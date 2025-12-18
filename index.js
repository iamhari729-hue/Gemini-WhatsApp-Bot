const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
        res.send('<html><body><h1>Bot is Running!</h1><p>Status: Active. Send <b>!gpt hello</b> to test.</p></body></html>');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

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
                connectToWhatsApp();
            } else {
                console.log('>> Critical Error. Deleting session...');
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

            // 1. Log EVERY message received to debug
            const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const sender = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;

            console.log(`>> Message Received: "${messageText}" from ${isFromMe ? "ME" : sender}`);

            // 2. Process Command (Removed 'fromMe' check)
            if (messageText.startsWith('!gpt ')) {
                const prompt = messageText.slice(5);
                console.log(`>> Processing GPT request: ${prompt}`);

                // Send typing indicator
                await sock.sendPresenceUpdate('composing', sender);

                const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                const result = await model.generateContent(prompt);
                const response = await result.response;
                const text = response.text();

                // Reply
                await sock.sendMessage(sender, { text: text }, { quoted: msg });
                console.log('>> Reply Sent!');
            }
        } catch (error) {
            console.error('>> Error processing message:', error);
        }
    });
}

connectToWhatsApp();
