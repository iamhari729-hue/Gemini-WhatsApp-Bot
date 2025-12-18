const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;
// CORRECT ROUTER ENDPOINT (OpenAI Compatible)
const ROUTER_URL = "https://router.huggingface.co/v1/chat/completions";
// We use the exact model ID expected by the router
const MODEL_ID = "mistralai/Mistral-7B-Instruct-v0.3"; 

let qrCodeDataUrl = null;
let sock;

// --- Express Server ---
app.get('/', (req, res) => {
    if (qrCodeDataUrl) {
        res.send(`
            <html>
                <head><title>WhatsApp Bot</title></head>
                <body style="display:flex; justify-content:center; align-items:center; height:100vh; background:#f0f2f5; font-family:sans-serif;">
                    <div style="text-align:center;">
                        <h1>Scan QR Code</h1>
                        <img src="${qrCodeDataUrl}" alt="QR Code" style="border: 5px solid white; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);"/>
                        <p>Status: Active (HF Router)</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<html><body><h1>Bot is Running!</h1><p>Status: Connected.</p></body></html>');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- Robust Router Call ---
async function callHFRouter(prompt) {
    if (!HF_TOKEN) throw new Error("HUGGINGFACE_TOKEN is missing.");

    console.log(">> Sending request to HF Router (OpenAI Standard)...");
    
    try {
        const response = await fetch(ROUTER_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${HF_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: MODEL_ID, // Router needs to know which model to route to
                messages: [
                    { role: "user", content: prompt }
                ],
                max_tokens: 500,
                stream: false
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Router Error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        
        // Parse OpenAI-style response
        if (data.choices && data.choices.length > 0 && data.choices[0].message) {
            return data.choices[0].message.content;
        } else {
            return "Error: Empty response from AI.";
        }

    } catch (error) {
        console.error(">> API Call Failed:", error);
        throw error;
    }
}

// --- WhatsApp Logic ---
async function connectToWhatsApp() {
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
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) qrCodeDataUrl = url;
            });
        }

        if (connection === 'close') {
            qrCodeDataUrl = null;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 2000);
            } else {
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
                await sock.sendPresenceUpdate('composing', sender);

                try {
                    const text = await callHFRouter(prompt);
                    await sock.sendMessage(sender, { text: text }, { quoted: msg });
                    console.log('>> Reply sent!');
                } catch (aiError) {
                    await sock.sendMessage(sender, { text: "⚠️ AI Error: " + aiError.message }, { quoted: msg });
                }
            }
        } catch (error) {
            console.error('>> Handler Error:', error);
        }
    });
}

connectToWhatsApp();
