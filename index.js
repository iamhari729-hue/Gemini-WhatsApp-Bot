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
    
    // Fetch the latest version of WhatsApp Web to avoid 405 errors
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`>> Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // Disabled to stop deprecation warnings
        logger: pino({ level: 'silent' }), 
        // MIMIC A REAL BROWSER (Ubuntu/Chrome)
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        generateHighQualityLinkPreview: true,
        syncFullHistory: false, 
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('>> New QR Code generated. Check the website.');
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) qrCodeDataUrl = url;
            });
        }

        if (connection === 'close') {
            qrCodeDataUrl = null;
            const statusCode = lastDisconnect.error?.output?.statusCode;
            // 405, 403, and 401 usually mean we need to re-login completely
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 405;
            
            console.log(`>> Connection closed (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000); // Wait 5s before reconnecting
            } else {
                console.log('>> Critical Error (Blocked or Logged Out). Deleting session and restarting...');
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
            if (!msg.message || msg.key.fromMe) return; 

            const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            if (messageText.startsWith('!gpt ')) {
                const prompt = messageText.slice(5);
                const remoteJid = msg.key.remoteJid;
                console.log(`>> Received Prompt: ${prompt}`);

                // Send typing indicator
                await sock.sendPresenceUpdate('composing', remoteJid);

                const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                const result = await model.generateContent(prompt);
                const response = await result.response;
                const text = response.text();

                await sock.sendMessage(remoteJid, { text: text }, { quoted: msg });
            }
        } catch (error) {
            console.error('>> Error processing message:', error);
        }
    });
}

connectToWhatsApp();
