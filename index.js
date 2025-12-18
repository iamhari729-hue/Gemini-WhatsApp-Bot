const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

let qrCodeDataUrl = null;
let sock;

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
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<html><body><h1>Bot is Active!</h1><p>Status: Connected. Send <b>!gpt hello</b> to yourself.</p></body></html>');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- Smart Gemini Generator ---
async function generateWithFallback(prompt) {
    // List of models to try in order
    const modelsToTry = ["gemini-1.5-flash", "gemini-pro"];
    
    for (const modelName of modelsToTry) {
        try {
            console.log(`>> Trying model: ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error) {
            console.warn(`>> Failed with ${modelName}: ${error.message}`);
            // If it's the last model, throw the error
            if (modelName === modelsToTry[modelsToTry.length - 1]) {
                throw error;
            }
            // Otherwise loop and try the next one
        }
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
                console.log('>> Session invalidated. Deleting folder and restarting...');
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

            // Simple log to show message arrival
            if(messageText) console.log(`>> Msg: ${messageText.substring(0, 20)}...`);

            if (messageText.startsWith('!gpt ')) {
                const prompt = messageText.slice(5);
                console.log(`>> Processing GPT request: ${prompt}`);

                // Send typing indicator
                await sock.sendPresenceUpdate('composing', sender);

                try {
                    // Use the smart fallback function
                    const text = await generateWithFallback(prompt);
                    await sock.sendMessage(sender, { text: text }, { quoted: msg });
                    console.log('>> Reply sent!');
                } catch (aiError) {
                    console.error('>> Gemini API Failed:', aiError);
                    await sock.sendMessage(sender, { text: "Error: Could not connect to Gemini AI. Check API Key." }, { quoted: msg });
                }
            }
        } catch (error) {
            console.error('>> Message Handler Error:', error);
        }
    });
}

connectToWhatsApp();
