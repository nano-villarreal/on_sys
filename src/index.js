// external packages
const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();
var accountSid = process.env.TWILIO_ACCOUNT_SID;
var authToken = process.env.TWILIO_AUTH_TOKEN;
// Start the webapp
const webApp = express();

// Webapp settings
webApp.use(bodyParser.urlencoded({
    extended: true
}));
webApp.use(bodyParser.json());

// Server Port
const PORT = process.env.PORT;

// Home route
webApp.get('/', (req, res) => {
    res.send(`Hello World.!`);
});

const WA = require('../helper-function/whatsapp-send-message');

// Route for WhatsApp
// Route for WhatsApp

// ---------- WhatsApp ----------
webApp.post('/whatsapp', async (req, res) => {
    const form = req.body;
    const senderID = form.From;
    const numMedia = parseInt(form.NumMedia || '0', 10);

    console.log('Incoming payload:', form);

    // ---- CSV handling ----
    if (numMedia > 0 && form.MediaContentType0 === 'text/csv') {
        const mediaUrl = form.MediaUrl0;

        try {
            // 1. Build proper Basic Auth header
            const auth = Buffer.from(
                `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
            ).toString('base64');

            const resp = await fetch(mediaUrl, {
                headers: { Authorization: `Basic ${auth}` },
            });

            if (!resp.ok) {
                const txt = await resp.text();
                throw new Error(`HTTP ${resp.status} – ${txt}`);
            }

            // 2. Read whole CSV into a string (in-memory)
            const csvText = await resp.text();

            // 3. Simple CSV → array of arrays
            const lines = csvText.trim().split('\n');
            const headers = lines[0].split(',').map(h => h.trim());
            const dataRows = lines.slice(1, 11).map(l => l.split(',').map(c => c.trim()));

            // 4. Log
            console.log('\n=== CSV CONTENTS (first 10 rows) ===');
            console.log('Headers:', headers.join(' | '));
            dataRows.forEach((row, i) => console.log(`${i + 1}: ${row.join(' | ')}`));
            console.log('Total rows in file:', lines.length - 1);

            // 5. Reply
            await sendMessage(
                `CSV received! ${lines.length - 1} row(s) – check server logs for content.`,
                senderID
            );

        } catch (err) {
            console.error('Error reading CSV:', err.message);
            await sendMessage('Received file, but could not read CSV.', senderID);
        }
    }
    // ---- Plain text fallback ----
    else {
        const txt = form.Body || '(no text)';
        console.log('Text message:', txt);
        await sendMessage(`You said: ${txt}`, senderID);
    }

    // Twilio expects a quick 200
    res.sendStatus(200);
});
// Start the server
webApp.listen(PORT, () => {
    console.log(`Server is up and running at ${PORT}`);
});