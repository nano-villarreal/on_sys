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
    res.render('input/ui');
});

const WA = require('../helper-function/whatsapp-send-message');

// Route for WhatsApp
// Route for WhatsApp

// Function to send message to WhatsApp
// Unified sendMessage: handles strings, arrays, or objects
// ──────────────────────────────────────────────────────────────
// Unified sendMessage – handles strings OR full result objects
// ──────────────────────────────────────────────────────────────

/**
 * Converts array of { epc, result: { article, client } } into:
 * "7 toalla from club contry\n2 mantel from club misiones"
 */
const buildArticleSummary = (dbResults) => {
    const summary = {};

    for (const item of dbResults) {
        const { client, article } = item.result || {};
        if (!client || !article) continue; // skip malformed

        if (!summary[client]) summary[client] = {};
        summary[client][article] = (summary[client][article] || 0) + 1;
    }

    const lines = [];
    for (const [client, articles] of Object.entries(summary)) {
        for (const [article, count] of Object.entries(articles)) {
            const plural = count > 1 ? 's' : '';
            lines.push(`Se contaron ${count} ${article}${plural} de ${client}`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : 'No results to show.';
};

const sendMessage = async (content, senderID, options = {}) => {
    console.log('sendMessage → to:', senderID);

    try {
        // ───── 1. Handle plain string (unchanged) ─────
        if (typeof content === 'string') {
            if (!content.trim()) {
                console.warn('Empty string – skipping.');
                return;
            }

            const msg = await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: senderID,
                body: content
            });
            console.log('String message sent, SID:', msg.sid);
            return;
        }

        // ───── 2. Handle Array: Build Summary OR Full JSON ─────
        if (Array.isArray(content)) {
            // Option to force full JSON (for debugging)
            if (options.fullJson) {
                return await sendMessage(JSON.stringify(content, null, 2), senderID);
            }

            // Build compact summary: "7 toalla from club contry"
            const summary = buildArticleSummary(content);

            const msg = await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: senderID,
                body: summary
            });
            console.log('Summary message sent, SID:', msg.sid);
            return;
        }

        // ───── 3. Fallback: Any other object → JSON pretty-print + chunking ─────
        const json = JSON.stringify(content, null, 2);
        const lines = json.split('\n');
        const MAX_CHUNK = 1500;

        let chunk = '';
        for (const line of lines) {
            if (chunk.length + line.length + 1 > MAX_CHUNK) {
                await twilioClient.messages.create({
                    from: 'whatsapp:+14155238886',
                    to: senderID,
                    body: chunk
                });
                console.log('Chunk sent (continued)');
                chunk = line + '\n';
            } else {
                chunk += line + '\n';
            }
        }

        if (chunk.trim()) {
            await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: senderID,
                body: chunk
            });
            console.log('Final chunk sent');
        }

    } catch (error) {
        console.error('sendMessage error →', error.message);
        try {
            await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: senderID,
                body: 'Failed to send the response.'
            });
        } catch (fallbackErr) {
            console.error('Fallback message also failed →', fallbackErr.message);
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