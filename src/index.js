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
webApp.set('views', './views');     // optional: default is ./views
webApp.set('view engine', 'ejs');
// Webapp settings
webApp.use(bodyParser.urlencoded({
    extended: true
}));
webApp.use(bodyParser.json());

// Server Port
const PORT = process.env.PORT;

// Home route
webApp.get('/', (req, res) => {
    res.render('ui');
});

const WA = require('../helper-function/whatsapp-send-message');

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
// ---------- Web Form Input ----------
webApp.post('/conteo_input', async (req, res) => {
    const body = req.body;
    const rawText = body.IDs || '';  // Asegúrate de que el name del textarea sea "IDs"

    console.log('Raw input recibido:', rawText);

    // 1. Separar por saltos de línea
    const lines = rawText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);

    // 2. Eliminar duplicados (opcional, pero útil)
    const uniqueEPCs = [...new Set(lines)];

    // 3. Imprimir cada EPC individualmente
    console.log(`\nTotal EPCs recibidos: ${lines.length}`);
    console.log(`EPCs únicos: ${uniqueEPCs.length}\n`);

    uniqueEPCs.forEach((epc, index) => {
        console.log(`${index + 1}. ${epc}`);
    });

    // 4. (Opcional) Buscar en MongoDB y generar resumen
    const results = [];
    for (const epc of uniqueEPCs) {
        try {
            const result = await client.db("on").collection("tags").findOne({ scanId: epc });
            results.push({ epc, result });
            console.log(`→ ${epc} →`, result ? 'Encontrado' : 'No encontrado');
        } catch (err) {
            console.error(`Error buscando ${epc}:`, err.message);
            results.push({ epc, error: err.message });
        }
    }

    // 5. Generar resumen como en WhatsApp
    const summary = buildArticleSummary(results.filter(r => r.result));

    // 6. Responder en la web
    res.send(`
        <div style="font-family: 'Poppins', sans-serif; padding: 40px; text-align: center; background: #f0f7f4; min-height: 100vh;">
            <h1 style="color: #128C7E;">Conteo Procesado</h1>
            <p><strong>${uniqueEPCs.length}</strong> EPCs únicos procesados.</p>
            <pre style="background: white; padding: 16px; border-radius: 12px; text-align: left; max-width: 600px; margin: 20px auto; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
${summary}
            </pre>
            <a href="/" style="background: #25D366; color: white; padding: 12px 24px; border-radius: 12px; text-decoration: none; font-weight: 600;">Volver al inicio</a>
        </div>
    `);
});

webApp.post('/create_defect', async (req, res) => {
    const body = req.body

    try {
        await createDefect(client, {
            defect_count: 1,
            descripcion: [req.body.descripcion],
            image: [req.body.image],
            scanId: epc
        });
        console.log(`${i + 1}. ${epc} → inserted`);
    } catch (err) {
        console.error(`${i + 1}. ${epc} → FAILED:`, err.message);
    }
})

webApp.get('/create_defect', async (req, res) => {
    res.render('document_damage')
})


async function createDefect(client, newTag) {
    const result = await client.db("on").collection("defects").insertOne(newTag);
    console.log(`New tag created with _id: ${result.insertedId}`);
}
// Start the server
webApp.listen(PORT, () => {
    console.log(`Server is up and running at ${PORT}`);
});