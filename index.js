const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let qrCodeDataUrl = null;

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
                        <p>Refresh if you don't see a code yet.</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<html><body><h1>Client is Ready!</h1><p>Bot is connected. Send <b>!gpt hello</b> to yourself to test.</p></body></html>');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- WhatsApp Client ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        // CRITICAL: Point to the Chrome we installed in Docker
        executablePath: '/usr/bin/google-chrome-stable', 
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Vital for Docker memory
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
    }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generating QR image', err);
            return;
        }
        qrCodeDataUrl = url;
    });
});

client.on('ready', () => {
    console.log('Client is ready!');
    qrCodeDataUrl = null;
});

client.on('message_create', async msg => {
    if (msg.body.startsWith('!gpt ')) {
        const prompt = msg.body.slice(5); 
        console.log(`Received prompt: ${prompt}`);

        try {
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            await msg.reply(text);
        } catch (error) {
            console.error('Error fetching from Gemini:', error);
            await msg.reply('Error: ' + error.message);
        }
    }
});

client.initialize();