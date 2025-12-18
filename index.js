const { Client, NoAuth } = require('whatsapp-web.js'); // Changed to NoAuth for stability
const qrcode = require('qrcode');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
let qrCodeDataUrl = null;
let isConnected = false;

// --- Express Server ---
app.get('/', (req, res) => {
    if (isConnected) {
        res.send('<html><body style="font-family: sans-serif; text-align: center; padding-top: 50px;"><h1>✅ Bot is Connected!</h1><p>Go to WhatsApp and send <b>!gpt hello</b> to yourself.</p></body></html>');
    } else if (qrCodeDataUrl) {
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
        res.send('<html><body><h1>Please Wait...</h1><p>Initializing...</p></body></html>');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- WhatsApp Client ---
console.log("Initializing WhatsApp Client...");
const client = new Client({
    authStrategy: new NoAuth(), // Safer for free tier testing
    puppeteer: {
        executablePath: '/usr/bin/google-chrome-stable',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer' 
        ],
    }
});

client.on('qr', (qr) => {
    console.log('>> QR CODE RECEIVED. Please scan it now.');
    qrcode.toDataURL(qr, (err, url) => {
        if (!err) {
            qrCodeDataUrl = url;
        }
    });
});

client.on('ready', () => {
    console.log('>> ✅ CLIENT IS READY! Bot is successfully logged in.');
    isConnected = true;
    qrCodeDataUrl = null;
});

client.on('authenticated', () => {
    console.log('>> Authenticated successfully!');
});

client.on('auth_failure', (msg) => {
    console.error('>> AUTH FAILURE', msg);
});

// Using message_create to hear your own messages
client.on('message_create', async msg => {
    // Log EVERY message to check if bot is "hearing" you
    console.log(`>> Message detected from ${msg.from}: ${msg.body}`);

    if (msg.body.startsWith('!gpt ')) {
        const prompt = msg.body.slice(5); 
        console.log(`>> Processing GPT request: "${prompt}"`);

        try {
            await msg.reply("Thinking..."); // Immediate feedback
            
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            console.log(">> Gemini response generated. Sending reply...");
            await msg.reply(text);
            console.log(">> Reply sent!");
        } catch (error) {
            console.error('>> ERROR interacting with Gemini:', error);
            await msg.reply('Error: ' + error.message);
        }
    }
});

client.initialize();
