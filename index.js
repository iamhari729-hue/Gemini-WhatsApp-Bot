const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Global variable to store the latest QR code data URL
let qrCodeDataUrl = null;

// --- Express Server Setup ---
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
        res.send('<html><body><h1>Waiting for QR Code...</h1><p>Please check back in a few seconds.</p></body></html>');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// --- WhatsApp Client Setup ---
const client = new Client({
    authStrategy: new LocalAuth(), // Saves session to prevent re-scanning
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        // Explicitly tell Puppeteer to use the installed Chrome if needed, 
        // though typically just the args + installed libs are enough.
    }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    // Convert QR string to Data URI for HTML display
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
    qrCodeDataUrl = null; // Clear QR code once connected
});

// --- Message Handling ---
client.on('message', async msg => {
    if (msg.body.startsWith('!gpt ')) {
        const prompt = msg.body.slice(5); // Remove '!gpt ' from the start
        console.log(`Received prompt: ${prompt}`);

        try {
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();

            await msg.reply(text);
        } catch (error) {
            console.error('Error fetching from Gemini:', error);
            await msg.reply('Sorry, I encountered an error processing your request.');
        }
    }
});

client.initialize();