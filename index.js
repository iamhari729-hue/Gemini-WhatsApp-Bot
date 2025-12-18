const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Gemini
// Note: We don't set a model here, we select it dynamically below
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

let qrCodeDataUrl = null;
let sock;
let activeModelName = null; // We will find a working model and save it here

// --- Express Server ---
app.get('/', (req, res) => {
    if (qrCodeDataUrl) {
        res.send(`
            <html>
                <head><title>WhatsApp Bot QR</title></head>
                <body style="display:flex; justify-content:center; align-items:center; height:100vh; background:#f0f2f5;">
                    <div style="text-align:center;">
                        <h1>Scan this QR Code</h1>
                        <img src="${qrCodeDataUrl}" alt="QR Code" style="border: 5px solid white; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);"/>
                        <p>Status: ${activeModelName ? "✅ Using " + activeModelName : "⚠️ Searching for model..."}</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send(`<html><body><h1>Bot is Active!</h1><p>Status: Connected.</p><p><b>Active Model:</b> ${activeModelName || "None (Check Logs)"}</p></body></html>`);
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- Smart Model Discovery ---
async function findWorkingModel() {
    console.log(">> 🔍 Searching for a working Gemini model...");
    
    // We try these in order. The first one that doesn't 404/403 is the winner.
    const candidates = [
        "gemini-1.5-flash",
        "gemini-1.5-flash-latest",
        "gemini-1.5-flash-001",
        "gemini-1.5-pro",
        "gemini-1.5-pro-latest",
        "gemini-1.5-pro-001",
        "gemini-pro",
        "gemini-1.0-pro"
    ];

    for (const modelName of candidates) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            // Run a tiny test prompt
            await model.generateContent("Test");
            
            console.log(`>> ✅ SUCCESS: Found working model: "${modelName}"`);
            activeModelName = modelName;
            return;
        } catch (error) {
            // Ignore 404 (Not Found) and 403 (Permission Denied) and keep looking
            if (error.message.includes("404") || error.message.includes("403")) {
                console.log(`>> Model "${modelName}" not available (${error.message.split(':')[0]})`);
            } else {
                // If it's a different error (like Quota), the model exists but we are out of limit.
                // We'll accept it anyway because it's "valid".
                console.log(`>> Model "${modelName}" found (with error: ${error.message})`);
                activeModelName = modelName;
                return;
            }
        }
    }
    console.error(">> ❌ CRITICAL: No working models found. Check API Key Region availability.");
}

// --- WhatsApp Logic ---
async function connectToWhatsApp() {
    // 1. Find the model FIRST before connecting
    await findWorkingModel();

    const authPath = path.resolve(__dirname, 'auth_info_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('>> New QR Code generated.');
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) qrCodeDataUrl = url;
            });
        }

        if (connection === 'close') {
            qrCodeDataUrl = null;
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`>> Connection closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 2000);
            } else {
                console.log('>> Session invalidated. Restarting...');
                fs.rmSync(authPath, { recursive: true, force: true });
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('>> ✅ WhatsApp Connected Successfully!');
            qrCodeDataUrl = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message) return;

            const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const sender = msg.key.remoteJid;

            if (messageText.startsWith('!gpt ')) {
                const prompt = messageText.slice(5);
                console.log(`>> Received Prompt: "${prompt}"`);

                if (!activeModelName) {
                    await sock.sendMessage(sender, { text: "⚠️ Error: No Gemini model is available for this API Key." }, { quoted: msg });
                    return;
                }

                await sock.sendPresenceUpdate('composing', sender);

                try {
                    // CRITICAL FIX: Use the model we found earlier
                    console.log(`>> Generating with active model: ${activeModelName}`);
                    const model = genAI.getGenerativeModel({ model: activeModelName });
                    const result = await model.generateContent(prompt);
                    const response = await result.response;
                    const text = response.text();

                    await sock.sendMessage(sender, { text: text }, { quoted: msg });
                    console.log('>> Reply sent!');
                } catch (aiError) {
                    console.error('>> Generation Failed:', aiError.message);
                    await sock.sendMessage(sender, { text: "⚠️ AI Error: " + aiError.message }, { quoted: msg });
                }
            }
        } catch (error) {
            console.error('>> Handler Error:', error);
        }
    });
}

connectToWhatsApp();
