const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Gemini
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
                        <p>Open WhatsApp > Linked Devices > Link a Device</p>
                        <img src="${qrCodeDataUrl}" alt="QR Code" style="border: 5px solid white; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);"/>
                        <p><b>Note:</b> If the code doesn't work, wait 10 seconds and refresh.</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<html><body><h1>Bot is Running!</h1><p>Status: Active. Check logs for details.</p></body></html>');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- WhatsApp Logic ---
async function connectToWhatsApp() {
    const authPath = path.resolve(__dirname, 'auth_info_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Silent logs to prevent spam
        browser: Browsers.macOS("Desktop"), // Pretend to be a Mac for stability
        syncFullHistory: false, // Don't sync history to save RAM
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('>> New QR Code generated');
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) qrCodeDataUrl = url;
            });
        }

        if (connection === 'close') {
            qrCodeDataUrl = null;
            const statusCode = lastDisconnect.error?.output?.statusCode;
            
            // If logged out or banned, delete session and start fresh
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('>> Logged out. Deleting session and restarting...');
                fs.rmSync(authPath, { recursive: true, force: true });
                connectToWhatsApp();
            } else {
                console.log('>> Connection closed. Reconnecting...');
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('>> ✅ WhatsApp Connected!');
            qrCodeDataUrl = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return; // Ignore self-messages for now to prevent loops

            // Extract text
            const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            if (messageText.startsWith('!gpt ')) {
                const prompt = messageText.slice(5);
                const remoteJid = msg.key.remoteJid;
                console.log(`>> Received Prompt: ${prompt}`);

                await sock.sendMessage(remoteJid, { react: { text: "⏳", key: msg.key } });

                const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                const result = await model.generateContent(prompt);
                const response = await result.response;
                const text = response.text();

                await sock.sendMessage(remoteJid, { text: text }, { quoted: msg });
                await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } });
            }
        } catch (error) {
            console.error('>> Error processing message:', error);
        }
    });
}

connectToWhatsApp();
