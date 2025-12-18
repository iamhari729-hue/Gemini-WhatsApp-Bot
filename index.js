const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const { HfInference } = require('@huggingface/inference');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Hugging Face
const hf = new HfInference(process.env.HUGGINGFACE_TOKEN);
// Mistral-7B is a very smart, fast, and free model
const MODEL_NAME = "mistralai/Mistral-7B-Instruct-v0.2";

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
                        <p>Powered by Mistral AI ⚡</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<html><body><h1>Bot is Running!</h1><p>Status: Connected to WhatsApp.</p></body></html>');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- AI Logic (Mistral) ---
async function getMistralResponse(prompt) {
    try {
        console.log(">> Sending request to Mistral AI...");
        const result = await hf.textGeneration({
            model: MODEL_NAME,
            inputs: `<s>[INST] ${prompt} [/INST]`, // Format for Mistral
            parameters: {
                max_new_tokens: 500,
                temperature: 0.7,
                return_full_text: false
            }
        });
        return result.generated_text;
    } catch (error) {
        console.error(">> Hugging Face Error:", error);
        return "Sorry, I couldn't process that. (API Error)";
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

                const text = await getMistralResponse(prompt);
                await sock.sendMessage(sender, { text: text }, { quoted: msg });
                console.log('>> Reply sent!');
            }
        } catch (error) {
            console.error('>> Handler Error:', error);
        }
    });
}

connectToWhatsApp();
