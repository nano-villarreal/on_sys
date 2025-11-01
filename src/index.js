// external packages
const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
require('dotenv').config();
const uri = process.env.MONGO_LINK;
var accountSid = process.env.TWILIO_ACCOUNT_SID;
var authToken = process.env.TWILIO_AUTH_TOKEN;

const twilioClient = require('twilio')(accountSid, authToken);


const client = new MongoClient(uri);
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

// Function to send message to WhatsApp
// Unified sendMessage: handles strings, arrays, or objects
const sendMessage = async (content, senderID) => {
    console.log('Sending WhatsApp message to:', senderID);

    try {
        // Case 1: Plain string
        if (typeof content === 'string') {
            if (!content.trim()) {
                console.warn('Empty message skipped.');
                return;
            }

            const msg = await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: senderID,
                body: content
            });
            console.log('Message sent, SID:', msg.sid);
            return;
        }

        // Case 2: Array of results (like from CSV processing)
        if (Array.isArray(content)) {
            const maxLength = 1500;
            let message = 'CSV Processing Results:\n\n';
            let currentLength = message.length;

            for (const item of content) {
                const epc = item.epc || 'Unknown';
                const status = item.result ? 'Found' : item.error ? 'Error' : 'Not found';
                const line = `${status}: ${epc}\n`;

                if (currentLength + line.length > maxLength) {
                    // Send current chunk
                    await twilioClient.messages.create({
                        from: 'whatsapp:+14155238886',
                        to: senderID,
                        body: message
                    });
                    console.log('Chunk sent (continued)');
                    message = `...continued...\n${line}`;
                    currentLength = message.length;
                } else {
                    message += line;
                    currentLength += line.length;
                }
            }

            // Send final chunk
            if (message.trim() && message !== 'CSV Processing Results:\n\n') {
                await twilioClient.messages.create({
                    from: 'whatsapp:+14155238886',
                    to: senderID,
                    body: message
                });
                console.log('Final chunk sent');
            } else if (content.length === 0) {
                await twilioClient.messages.create({
                    from: 'whatsapp:+14155238886',
                    to: senderID,
                    body: 'No EPCs found in CSV.'
                });
            }
            return;
        }

        // Case 3: Any other object → pretty print
        const jsonString = JSON.stringify(content, null, 2);
        const lines = jsonString.split('\n');
        const chunkSize = 1400;
        let chunk = '';

        for (const line of lines) {
            if (chunk.length + line.length + 1 > chunkSize) {
                await twilioClient.messages.create({
                    from: 'whatsapp:+14155238886',
                    to: senderID,
                    body: chunk || 'Data:'
                });
                chunk = line + '\n';
            } else {
                chunk += line + '\n';
            }
        }
        if (chunk) {
            await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: senderID,
                body: chunk
            });
        }

    } catch (error) {
        console.error('Error at sendMessage -->', error.message);
        try {
            await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: senderID,
                body: 'Failed to send message.'
            });
        } catch (fallbackError) {
            console.error('Fallback message also failed:', fallbackError.message);
        }
    }
};

// ---------- WhatsApp ----------
webApp.post('/whatsapp', async (req, res) => {
    const form = req.body;
    const senderID = form.From;
    const numMedia = parseInt(form.NumMedia || '0', 10);
    console.log('Incoming payload:', form);

    try {
        // ---- CSV handling ----
        if (numMedia > 0 && form.MediaContentType0 === 'text/csv') {
            const mediaUrl = form.MediaUrl0;

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

            // 4. Extract and query ALL EPCs ASYNCHRONOUSLY
            const epcValues = [];
            const dataRows = lines.slice(1); // Skip header
            const results = [];

            console.log('\n=== QUERYING EPCs FROM DATABASE ===');
            for (const line of dataRows) {
                const cols = line.split(',').map(c => c.trim());
                const epc = cols[epcIndex];
                if (epc) {
                    epcValues.push(epc);
                    try {
                        const result = await client.db("on").collection("tags").findOne({ scanId: epc });
                        console.log(`EPC: ${epc} →`, result);
                        results.push({ epc, result });
                    } catch (dbErr) {
                        console.error(`DB error for EPC ${epc}:`, dbErr.message);
                        results.push({ epc, error: dbErr.message });
                    }
                }
            }

            console.log(`\nTotal EPCs processed: ${epcValues.length}`);

            // 5. Send confirmation
            await sendMessage(
                results,
                senderID
            );
        }
        // ---- Plain text fallback ----
        else {
            const txt = form.Body || '(no text)';
            console.log('Text message:', txt);
            await sendMessage(`You said: ${txt}`, senderID);
        }

        res.sendStatus(200);
    } catch (err) {
        console.error('Error in /whatsapp handler:', err.message);
        try {
            await sendMessage('An error occurred while processing your request.', senderID);
        } catch (sendErr) {
            console.error('Failed to send error message:', sendErr);
        }
        res.sendStatus(200); // Still respond 200 to Twilio to avoid retries
    }
});
// Start the server
webApp.listen(PORT, () => {
    console.log(`Server is up and running at ${PORT}`);
});