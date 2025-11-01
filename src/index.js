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
            // 1. Authenticate with Twilio
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

            // 2. Read CSV
            const csvText = await resp.text();
            const lines = csvText.trim().split('\n');

            if (lines.length <= 1) {
                await sendMessage('CSV is empty.', senderID);
                return res.sendStatus(200);
            }

            // 3. Find EPC column index
            const headers = lines[0].split(',').map(h => h.trim());
            const epcIndex = headers.findIndex(h => h.toUpperCase() === 'EPC');

            if (epcIndex === -1) {
                await sendMessage('No EPC column found in CSV.', senderID);
                return res.sendStatus(200);
            }

            // 4. Extract and print ALL EPCs
            const epcValues = [];
            const dataRows = lines.slice(1); // Skip header

            console.log('\n=== ALL EPCs FROM CSV ===');
            dataRows.forEach((line, i) => {
                const cols = line.split(',').map(c => c.trim());
                const epc = cols[epcIndex];
                if (epc) {
                    epcValues.push(epc);
                    const result = client.db("on").collection("tags").findOne({ scanId: epc })
                    console.log(result);
                }
            });

            console.log(`\nTotal EPCs found: ${epcValues.length}`);

            // 5. Send confirmation
            await sendMessage(
                `CSV processed! Found ${epcValues.length} EPC(s). Check server logs.`,
                senderID
            );

        } catch (err) {
            console.error('Error reading CSV:', err.message);
            await sendMessage('Error reading CSV file.', senderID);
        }
    }
    // ---- Plain text fallback ----
    else {
        const txt = form.Body || '(no text)';
        console.log('Text message:', txt);
        await sendMessage(`You said: ${txt}`, senderID);
    }

    res.sendStatus(200);
});
// Start the server
webApp.listen(PORT, () => {
    console.log(`Server is up and running at ${PORT}`);
});