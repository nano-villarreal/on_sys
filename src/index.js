// external packages
const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
require('dotenv').config();
const uri = process.env.MONGO_LINK;
var accountSid = process.env.TWILIO_ACCOUNT_SID;
var authToken = process.env.TWILIO_AUTH_TOKEN;

const mongoose = require('mongoose');

const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const twilioClient = require('twilio')(accountSid, authToken);
const multer = require('multer');
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'damage-reports', // carpeta en Cloudinary
        allowed_formats: ['jpeg', 'jpg', 'png', 'gif', 'webp'],
        transformation: [
            { width: 800, height: 800, crop: 'limit' }, // limita tamaño
            { quality: 'auto:good' },
            { fetch_format: 'auto' }
        ],
        public_id: (req, file) => {
            return `damage-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        },
    },
});


const upload = multer({ storage });

const mongoClient = new MongoClient(uri);
var accountSid = process.env.TWILIO_ACCOUNT_SID;
var authToken = process.env.TWILIO_AUTH_TOKEN;
// Start the webapp
const webApp = express();


const DamageReport = new mongoose.Schema({
    epc: {
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        required: true,
        trim: true,
    },
    imageUrl: {
        type: String,
        required: true,
    },
    imagePublicId: { // útil para borrar la imagen más tarde si es necesario
        type: String,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// config/cloudinary.js

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});


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
// Correct way with Express
webApp.post('/api/recoleccion', async (req, res) => {
    try {
        const { timestamp, items } = req.body;

        if (!items || Object.keys(items).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No se recibieron ítems para procesar.'
            });
        }

        console.log(`Recolección recibida el ${timestamp}`);
        let totalUpdated = 0;
        let totalProcessed = 0;
        const Tags = await mongoClient.db("on")
            .collection("tags")


        const database = await mongoClient.db("on").collection("recoleccion");
        const things_in = {}
        for (const [client, articles] of Object.entries(items)) {
            console.log(`Cliente: ${client}`);
            const EPCList = []
            for (const [article, data] of Object.entries(articles)) {
                const { count, epcs } = data;
                totalProcessed += epcs.length;

                console.log(`  ${count} ${article}`);
                things_in[article] = count
                console.log(`  Procesando ${epcs.length} EPCs...`);

                for (const epc of epcs) {
                    const trimmedEpc = epc.trim();
                    EPCList.push(trimmedEpc)
                    const updatedTag = await Tags.findOneAndUpdate(
                        { scanId: trimmedEpc },                          // Filtro: buscar por EPC
                        {
                            $set: { last_seen: new Date() }             // Actualizar última lectura
                        },
                        {
                            new: true,      // Devuelve el documento actualizado
                            upsert: false   // No crear si no existe (opcional: puedes cambiar a true si quieres crear nuevos)
                        }
                    );

                    if (updatedTag) {
                        totalUpdated++;
                        console.log(`    ✓ EPC ${trimmedEpc} actualizado → wash_count: ${updatedTag.wash_count}`);
                    } else {
                        console.log(`    ⚠ EPC ${trimmedEpc} no encontrado en la base de datos`);
                    }
                }
            }
            const newRecoleccion = {
                articles: things_in,
                client: client,
                date: new Date(),
                EPCs: EPCList
            }
            database.insertOne(newRecoleccion)
            console.log(newRecoleccion)
        }

        console.log(`Resumen: ${totalProcessed} EPCs procesados → ${totalUpdated} actualizados (+0.5 lavado cada uno)`);

        res.json({
            success: true,
            message: 'Recolección procesada correctamente con findOneAndUpdate',
            details: {
                timestamp,
                epcsProcessed: totalProcessed,
                itemsUpdated: totalUpdated,
            }
        });

    } catch (error) {
        console.error('Error al procesar recolección:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: error.message
        });
    }
});
webApp.post('/api/entrega', async (req, res) => {
    try {
        const { timestamp, items } = req.body;

        if (!items || Object.keys(items).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No se recibieron ítems para procesar.'
            });
        }

        console.log(`Recolección recibida el ${timestamp}`);
        let totalUpdated = 0;
        let totalProcessed = 0;
        const Tags = await mongoClient.db("on")
            .collection("tags")


        const database = await mongoClient.db("on").collection("entrega");
        const things_in = {}
        for (const [client, articles] of Object.entries(items)) {
            console.log(`Cliente: ${client}`);
            const EPCList = []
            for (const [article, data] of Object.entries(articles)) {
                const { count, epcs } = data;
                totalProcessed += epcs.length;

                console.log(`  ${count} ${article}`);
                things_in[article] = count
                console.log(`  Procesando ${epcs.length} EPCs...`);

                for (const epc of epcs) {
                    const trimmedEpc = epc.trim();
                    EPCList.push(trimmedEpc)
                    const updatedTag = await Tags.findOneAndUpdate(
                        { scanId: trimmedEpc },                          // Filtro: buscar por EPC
                        {
                            $inc: { wash_count: 1 },
                            $set: { last_seen: new Date() }             // Actualizar última lectura
                        },
                        {
                            new: true,      // Devuelve el documento actualizado
                            upsert: false   // No crear si no existe (opcional: puedes cambiar a true si quieres crear nuevos)
                        }
                    );

                    if (updatedTag) {
                        totalUpdated++;
                        console.log(`    ✓ EPC ${trimmedEpc} actualizado → wash_count: ${updatedTag.wash_count}`);
                    } else {
                        console.log(`    ⚠ EPC ${trimmedEpc} no encontrado en la base de datos`);
                    }
                }
            }
            const newEntrega = {
                articles: things_in,
                client: client,
                date: new Date(),
                EPCs: EPCList
            }
            database.insertOne(newEntrega)
            console.log(newEntrega)
        }

        console.log(`Resumen: ${totalProcessed} EPCs procesados → ${totalUpdated} actualizados (+0.5 lavado cada uno)`);

        res.json({
            success: true,
            message: 'Recolección procesada correctamente con findOneAndUpdate',
            details: {
                timestamp,
                epcsProcessed: totalProcessed,
                itemsUpdated: totalUpdated,
            }
        });

    } catch (error) {
        console.error('Error al procesar recolección:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: error.message
        });
    }
});
// Ruta API para búsqueda masiva en tiempo real
webApp.post('/api/lookup', async (req, res) => {
    try {
        const { epcs } = req.body;
        if (!Array.isArray(epcs) || epcs.length === 0) {
            return res.json([]);
        }

        // Búsqueda eficiente en MongoDB (usa índice en scanId)
        const docs = await mongoClient.db("on")
            .collection("tags")
            .find({ scanId: { $in: epcs } })
            .project({ scanId: 1, client: 1, article: 1 })
            .toArray();

        const map = new Map(docs.map(d => [d.scanId, {
            found: true,
            client: d.client,
            article: d.article
        }]));

        const result = epcs.map(epc => map.get(epc) || { epc, found: false });

        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json([]);
    }
});

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
            const result = await mongoClient.db("on").collection("tags").findOne({ scanId: epc });
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
    const result = await mongoClient.db("on").collection("defects").insertOne(newTag);
    console.log(`New tag created with _id: ${result.insertedId}`);
}
// Start the server
webApp.listen(PORT, () => {
    console.log(`Server is up and running at ${PORT}`);
});


webApp.post('/report-damage', upload.single('photo'), async (req, res) => {
    try {
        const { unitId: epc, description } = req.body;

        // Validación básica
        if (!epc?.trim() || !description?.trim()) {
            return res.status(400).json({
                error: 'El ID de la unidad y la descripción son obligatorios.',
            });
        }

        if (!req.file) {
            return res.status(400).json({
                error: 'Debes subir una foto del daño.',
            });
        }

        const trimmedEpc = epc.trim();

        // 1. Buscar el tag correspondiente al EPC en la colección "tags"
        const tag = await mongoClient.db("on")
            .collection("tags")
            .findOne({ scanId: trimmedEpc });

        let clientName = null;

        if (tag) {
            clientName = tag.client || null; // Extraer el client si existe

            // 2. Marcar el tag como dañado (damaged: true)
            await mongoClient.db("on")
                .collection("tags")
                .updateOne(
                    { scanId: trimmedEpc },
                    { $set: { damaged: true } }
                );

            console.log(`Tag ${trimmedEpc} marcado como dañado (damaged: true)`);
        } else {
            console.warn(`No se encontró tag con EPC ${trimmedEpc} en la colección tags`);
        }

        // 3. Crear el reporte de daño, incluyendo el campo client si se encontró
        const newDamageReport = {
            epc: trimmedEpc,
            description: description.trim(),
            client: clientName,          // ← Nuevo campo: client del tag
            date: new Date(),
            imageUrl: req.file.path,              // URL pública de Cloudinary
            imagePublicId: req.file.filename,     // ID interno para gestión futura
        };

        await mongoClient.db("on").collection("damage").insertOne(newDamageReport);

        console.log('Reporte de daño creado:', newDamageReport);

        // Respuesta exitosa
        res.redirect('/?damageReported=true');

    } catch (error) {
        console.error('Error al crear reporte de daño:', error);

        // Error específico de Cloudinary o Multer
        if (error.message.includes('File size too large') || error.http_code) {
            return res.status(400).json({ error: 'Imagen demasiado grande o formato no permitido.' });
        }

        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

webApp.post('/dashboard', async (req, res) => {
    const { client } = req.body;  // ← Change back to "client" to match the form

    let clientName = null;
    let stats = null;
    let articleAverages = null;
    let error = null;
    let overallAverage = '0';
    let damagedColor = '#4caf50';

    if (!client?.trim()) {
        error = 'Por favor ingresa un nombre de cliente.';
    } else {
        clientName = client.trim();

        try {
            const tagsCollection = await mongoClient.db("on").collection("tags");

            // General stats
            const generalStats = await tagsCollection.aggregate([
                { $match: { client: clientName } },
                {
                    $group: {
                        _id: null,
                        totalItems: { $sum: 1 },
                        totalWashCount: { $sum: "$wash_count" },
                        damagedCount: {
                            $sum: { $cond: [{ $eq: ["$damaged", true] }, 1, 0] }
                        }
                    }
                }
            ]).toArray();

            stats = generalStats.length > 0 ? generalStats[0] : {
                totalItems: 0,
                totalWashCount: 0,
                damagedCount: 0
            };

            // Per-article averages
            articleAverages = await tagsCollection.aggregate([
                { $match: { client: clientName } },
                {
                    $group: {
                        _id: "$article",
                        itemCount: { $sum: 1 },
                        totalWashes: { $sum: "$wash_count" },
                        avgWashes: { $avg: "$wash_count" }
                    }
                },
                { $sort: { avgWashes: -1 } }
            ]).toArray();

            // Calculate derived values
            overallAverage = stats.totalItems > 0
                ? (stats.totalWashCount / stats.totalItems).toFixed(1)
                : '0';
            damagedColor = stats.damagedCount > 0 ? '#d32f2f' : '#4caf50';

        } catch (err) {
            console.error('Error en dashboard:', err);
            error = 'Error al consultar la base de datos.';
            // stats, articleAverages remain null → will show "no data" message
        }
    }

    // Always render with consistent variables
    res.render('dashboard', {
        client: clientName,           // ← Use "client" consistently in template
        stats,
        articleAverages,
        error,
        overallAverage,
        damagedColor
    });
});

// GET /damage-breakdown?client=Club Country
webApp.get('/damage-breakdown', async (req, res) => {
    const clientName = req.query.client?.trim() || null;

    if (!clientName) {
        return res.redirect('/dashboard');
    }

    try {
        const damageCollection = mongoClient.db("on").collection("damage");
        const tagsCollection = mongoClient.db("on").collection("tags");

        // Fetch all damage reports for this client
        const damageReports = await damageCollection
            .find({ client: clientName })
            .sort({ date: -1 })
            .toArray();

        // Total damaged items
        const totalDamaged = damageReports.length;

        // Breakdown by article
        const articleBreakdown = {};
        const epcList = damageReports.map(report => report.epc);

        if (epcList.length > 0) {
            const tags = await tagsCollection
                .find({ scanId: { $in: epcList } })
                .project({ scanId: 1, article: 1 })
                .toArray();

            const tagMap = new Map(tags.map(t => [t.scanId, t.article]));

            damageReports.forEach(report => {
                const article = tagMap.get(report.epc) || 'Artículo Desconocido';
                articleBreakdown[article] = (articleBreakdown[article] || 0) + 1;
            });
        }

        // Sort breakdown by count descending
        const sortedBreakdown = Object.entries(articleBreakdown)
            .sort((a, b) => b[1] - a[1]);

        res.render('damage_breakdown', {
            client: clientName,
            totalDamaged,
            articleBreakdown: sortedBreakdown,
            damageReports,
            error: null
        });

    } catch (err) {
        console.error('Error en damage-breakdown:', err);
        res.render('damage_breakdown', {
            client: clientName,
            totalDamaged: 0,
            articleBreakdown: [],
            damageReports: [],
            error: 'Error al cargar el desglose de daños.'
        });
    }
});

webApp.get('/log', async (req, res) => {
    const clientName = req.query.client?.trim() || null;

    if (!clientName) {
        return res.redirect('/dashboard');
    }

    try {
        const recoleccionCollection = mongoClient.db("on").collection("recoleccion");
        const entregaCollection = mongoClient.db("on").collection("entrega");

        // Fetch all recolecciones and entregas for this client
        const recolecciones = await recoleccionCollection
            .find({ client: clientName })
            .sort({ date: -1 })
            .toArray();

        const entregas = await entregaCollection
            .find({ client: clientName })
            .sort({ date: -1 })
            .toArray();

        // === INSERT THE SAFE CODE HERE ===
        // Safe way to sum article counts
        const safeSumArticles = (articles) => {
            if (!articles || typeof articles !== 'object') return 0;
            return Object.values(articles)
                .reduce((acc, val) => acc + (typeof val === 'number' ? val : 0), 0);
        };

        const totalPrendasRecogidas = recolecciones.reduce((sum, r) =>
            sum + safeSumArticles(r.articles), 0);

        const totalPrendasEntregadas = entregas.reduce((sum, e) =>
            sum + safeSumArticles(e.articles), 0);
        // === END OF INSERTION ===

        // Combine and sort all events by date (newest first)
        const allEvents = [
            ...recolecciones.map(e => ({ ...e, type: 'recoleccion', typeLabel: 'Recolección' })),
            ...entregas.map(e => ({ ...e, type: 'entrega', typeLabel: 'Entrega' }))
        ].sort((a, b) => new Date(b.date) - new Date(a.date));

        // Summary stats (non-article counts remain the same)
        const totalRecolecciones = recolecciones.length;
        const totalEntregas = entregas.length;

        res.render('log', {
            client: clientName,
            allEvents,
            totalRecolecciones,
            totalEntregas,
            totalPrendasRecogidas,
            totalPrendasEntregadas,
            error: null
        });

    } catch (err) {
        console.error('Error en bitácora:', err);
        res.render('log', {
            client: clientName,
            allEvents: [],
            totalRecolecciones: 0,
            totalEntregas: 0,
            totalPrendasRecogidas: 0,
            totalPrendasEntregadas: 0,
            error: 'Error al cargar la bitácora de recolección y entrega.'
        });
    }
});

webApp.get('/dashboard', async (req, res) => {
    res.render('find_client')
})
