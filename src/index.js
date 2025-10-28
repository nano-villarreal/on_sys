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
webApp.post('/whatsapp', async (req, res) => {
    const form = req.body;
    const senderID = form.From;
    const numMedia = parseInt(form.NumMedia || '0', 10);

    console.log('Incoming message:', form);

    if (numMedia > 0 && form.MediaContentType0 === 'text/csv') {
        const mediaUrl = form.MediaUrl0;

        try {
            // Fetch CSV directly from Twilio (in memory)
            const response = await fetch(mediaUrl, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const stream = response.body;
            const chunks = [];

            // Read stream into string
            for await (const chunk of stream) {
                chunks.push(Buffer.from(chunk));
            }
            const csvText = Buffer.concat(chunks).toString('utf-8');

            // Simple CSV parser: split into rows and log first 10
            const rows = csvText.trim().split('\n').map(line => line.split(',').map(cell => cell.trim()));
            const headers = rows[0];
            const dataRows = rows.slice(1, 11); // first 10 data rows

            console.log('\nCSV CONTENTS (first 10 rows):');
            console.log('Headers:', headers.join(' | '));
            dataRows.forEach((row, i) => {
                console.log(`${i + 1}: ${row.join(' | ')}`);
            });

            // Reply to user
            await WA.sendMessage(`CSV received! ${rows.length - 1} rows detected. Check server logs for contents.`, senderID);

        } catch (err) {
            console.error('Error reading CSV:', err.message);
            await WA.sendMessage('Received file, but failed to read CSV.', senderID);
        }
    } else {
        // Regular text message
        const message = form.Body || '(no text)';
        console.log('Text message:', message);
        await WA.sendMessage(`You said: ${message}`, senderID);
    }

    // Always respond with 200 (Twilio expects quick response)
    res.sendStatus(200);
});

// Start the server
webApp.listen(PORT, () => {
    console.log(`Server is up and running at ${PORT}`);
});