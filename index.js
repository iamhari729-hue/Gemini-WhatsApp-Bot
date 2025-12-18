const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

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
                        <p><b>Note:</b> If the code doesn't work, refresh this page to get a new one.</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<html><body><h1>Bot is Running!</h1><p>Status: Connected (or connecting...). Check logs.</p></body></html>');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- WhatsApp Logic (Baileys) ---
async function connectToWhatsApp() {
    // Auth state folder
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Also prints to logs just in case
        logger: pino({ level: 'silent' }), // Hide debug logs to save space
        browser: ["RenderBot", "Chrome", "1.0.0"], // Pretend to be a browser
        connectTimeoutMs: 60000,
    });

    // Handle Connection Events
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('>> New QR Code generated');
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) qrCodeDataUrl = url;
            });
        }

        if (connection === 'close') {
            qrCodeDataUrl = null;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('>> Connection closed. Reconnecting?', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('>> ✅ WhatsApp Connected!');
            qrCodeDataUrl = null;
        }
    });

    // Save Credentials
    sock.ev.on('creds.update', saveCreds);

    // Handle Messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        // Get text from message (handles various types like conversation, extendedTextMessage)
        const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        
        // Check for command (works for you AND others)
        if (messageText.startsWith('!gpt ')) {
            const prompt = messageText.slice(5);
            const remoteJid = msg.key.remoteJid;
            console.log(`>> Received Prompt: ${prompt}`);

            // Send "typing..." status
            await sock.sendPresenceUpdate('composing', remoteJid);

            try {
                const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                const result = await model.generateContent(prompt);
                const response = await result.response;
                const text = response.text();

                // Reply to the message
                await sock.sendMessage(remoteJid, { text: text }, { quoted: msg });
                console.log('>> Reply sent.');
            } catch (error) {
                console.error('Gemini Error:', error);
                await sock.sendMessage(remoteJid, { text: 'Error processing request.' }, { quoted: msg });
            }
        }
    });
}

// Start the bot
connectToWhatsApp();
