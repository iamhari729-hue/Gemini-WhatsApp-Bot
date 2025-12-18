const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.GEMINI_API_KEY) {
    console.error(">> CRITICAL ERROR: GEMINI_API_KEY is missing in Render Environment Variables!");
}
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
                        <p>Refresh page if code expires.</p>
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

// --- WhatsApp Logic ---
async function connectToWhatsApp() {
    const authPath = path.resolve(__dirname, 'auth_info_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`>> Starting socket with version: ${version.join('.')}`);

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
            console.log('>> New QR Code generated. Scan it now.');
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
                setTimeout(connectToWhatsApp, 3000);
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

            const messageText = msg.message.conversation || 
                              msg.message.extendedTextMessage?.text || 
                              msg.message.imageMessage?.caption || 
                              '';
            
            const sender = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;

            console.log(`>> Heard message: "${messageText}" | From Me: ${isFromMe}`);

            if (messageText.startsWith('!gpt ')) {
                const prompt = messageText.slice(5);
                console.log(`>> Triggering Gemini with: "${prompt}"`);

                // Send typing indicator
                await sock.sendPresenceUpdate('composing', sender);

                try {
                    // UPDATED MODEL NAME: Using gemini-1.5-flash which is standard now
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                    const result = await model.generateContent(prompt);
                    const response = await result.response;
                    const text = response.text();

                    await sock.sendMessage(sender, { text: text }, { quoted: msg });
                    console.log('>> Reply sent successfully!');
                } catch (aiError) {
                    console.error('>> Gemini API Error:', aiError);
                    await sock.sendMessage(sender, { text: "Error: " + aiError.message }, { quoted: msg });
                }
            }
        } catch (error) {
            console.error('>> Message Handler Error:', error);
        }
    });
}

connectToWhatsApp();
