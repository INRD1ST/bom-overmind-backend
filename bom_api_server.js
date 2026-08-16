'use strict';

require('dotenv').config();

const { ethers } = require('ethers');
const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');

// ── CONFIG ─────────────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const RPC_URL          = process.env.SEPOLIA_RPC_URL    || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.BOM_CONTRACT_ADDRESS || '0x9Dd6f41235a3f6D2dcF9a73B5177c14e721432Ff';
const DB_PATH          = path.join(__dirname, 'bom_search_database.json');
const IPFS_GATEWAY     = process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/';
const POLL_INTERVAL    = parseInt(process.env.BLOCK_POLL_INTERVAL || '15') * 1000;

const CONTRACT_ABI = [
    'event FNSRegistered(string targetString, address owner, string spatialURI)',
    'event SpatialURIUpdated(string targetString, string newSpatialURI)',
];

// ── IPFS DEEP FETCHER ──────────────────────────────────────
async function fetchIPFSMetadata(uri) {
    const empty = { businessName: null, description: null, category: null, location: null, tags: [] };
    if (!uri || !uri.toLowerCase().startsWith('ipfs://')) return empty;

    const hash       = uri.replace(/^ipfs:\/\//i, '').trim();
    const gatewayURL = `${IPFS_GATEWAY}${hash}`;

    try {
        const controller = new AbortController();
        const timer      = setTimeout(() => controller.abort(), 10000);

        let response;
        try {
            response = await fetch(gatewayURL, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            console.log(`[IPFS] Failed — HTTP ${response.status} for ${gatewayURL}`);
            return empty;
        }

        const text = await response.text();
        try {
            const json = JSON.parse(text);
            return {
                businessName: json.businessName || json.name        || null,
                description:  json.description  || json.desc        || null,
                category:     json.category      || json.type        || null,
                location:     json.location      || json.geo         || null,
                tags:         Array.isArray(json.tags) ? json.tags   : [],
            };
        } catch {
            console.log(`[IPFS] Non-JSON content at ${gatewayURL} — stored as raw URI`);
            return empty;
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log(`[IPFS] Timeout fetching ${gatewayURL}`);
        } else {
            console.log(`[IPFS] Failed — ${err.message}`);
        }
        return empty;
    }
}

// ── DATABASE ───────────────────────────────────────────────
function readDB() {
    try {
        if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]', 'utf8');
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch {
        return [];
    }
}

function writeDB(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('[DB] Write error:', err.message);
    }
}

function upsert(record) {
    const db  = readDB();
    const idx = db.findIndex(r => r.namespace.toLowerCase() === record.namespace.toLowerCase());
    if (idx >= 0) {
        db[idx] = { ...db[idx], ...record };
    } else {
        db.push(record);
    }
    writeDB(db);
}

// ── EXPRESS ────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/resolve/:namespace', (req, res) => {
    try {
        const db     = readDB();
        const target = req.params.namespace.toLowerCase();
        const record = db.find(r => r.namespace.toLowerCase() === target);
        if (!record) return res.status(404).json({ error: 'Not Found', status: 404 });
        return res.json(record);
    } catch (err) {
        return res.status(500).json({ error: 'Internal server error', detail: err.message });
    }
});

app.get('/api/namespaces', (req, res) => {
    try {
        return res.json(readDB());
    } catch (err) {
        return res.status(500).json({ error: 'Internal server error', detail: err.message });
    }
});

app.get('/api/health', (_req, res) => {
    res.json({ status: 'online', agent: 'AGT-0004', role: 'BOM-API-Server', timestamp: new Date().toISOString() });
});

app.get('/api/search', (req, res) => {
    try {
        const q = (req.query.q || '').toLowerCase().trim();
        const db = readDB();
        // Empty q = return all records (used by Mother AI "show all" command)
        if (!q) return res.json({ query: '', count: db.length, results: db });
        const results = db.filter(r => {
            const inNamespace = (r.namespace     || '').toLowerCase().includes(q);
            const inBusiness  = (r.businessName  || '').toLowerCase().includes(q);
            const inCategory  = (r.category      || '').toLowerCase().includes(q);
            const inTags      = Array.isArray(r.tags)
                ? r.tags.some(t => t.toLowerCase().includes(q))
                : false;
            return inNamespace || inBusiness || inCategory || inTags;
        });
        return res.json({ query: q, count: results.length, results });
    } catch (err) {
        return res.status(500).json({ error: 'Internal server error', detail: err.message });
    }
});

// ── WEB3 WATCHER — getLogs POLLING MODEL (AGT-0004) ───────
async function bootWatcher() {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  BOM PROTOCOL — API SERVER + WATCHER  (AGT-0004)    ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    let provider  = null;
    let iface     = null;
    let lastBlock = 0;
    let pollTimer = null;

    // ── Process a single decoded log ───────────────────────
    async function handleLog(parsed, blockNumber) {
        if (parsed.name === 'FNSRegistered') {
            const ns  = parsed.args[0].trim();
            const owner = parsed.args[1];
            const uri = parsed.args[2].trim();
            console.log(`\n🌐 [FNSRegistered] Namespace: "${ns}" | Owner: ${owner} | URI: ${uri} | Block: ${blockNumber}`);
            const meta = await fetchIPFSMetadata(uri);
            if (meta.businessName) console.log(`[IPFS] ✅ Metadata indexed — Business: "${meta.businessName}" | Category: ${meta.category}`);
            upsert({
                namespace:    ns,
                owner,
                uri,
                status:       uri.length > 0 ? 'routed' : 'unrouted',
                businessName: meta.businessName,
                description:  meta.description,
                category:     meta.category,
                location:     meta.location,
                tags:         meta.tags,
                lastUpdated:  new Date().toISOString(),
            });
        } else if (parsed.name === 'SpatialURIUpdated') {
            const ns  = parsed.args[0].trim();
            const uri = parsed.args[1].trim();
            console.log(`\n📡 [SpatialURIUpdated] Namespace: "${ns}" → New URI: ${uri} | Block: ${blockNumber}`);
            const meta = await fetchIPFSMetadata(uri);
            if (meta.businessName) console.log(`[IPFS] ✅ Metadata re-indexed — Business: "${meta.businessName}"`);
            upsert({
                namespace:    ns,
                uri,
                status:       uri.length > 0 ? 'routed' : 'unrouted',
                businessName: meta.businessName,
                description:  meta.description,
                category:     meta.category,
                location:     meta.location,
                tags:         meta.tags,
                lastUpdated:  new Date().toISOString(),
            });
        }
    }

const MAX_BLOCK_CHUNK = 2000;
const START_BLOCK     = process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : 11500000;

    // ── One poll cycle ─────────────────────────────────────
    async function poll() {
        try {
            const currentBlock = await provider.getBlockNumber();
            if (currentBlock <= lastBlock) return;

            let fromBlock = lastBlock + 1;
            let totalEvents = 0;

            while (fromBlock <= currentBlock) {
                const toBlock = Math.min(fromBlock + MAX_BLOCK_CHUNK - 1, currentBlock);
                const logs = await provider.getLogs({
                    address:   CONTRACT_ADDRESS,
                    fromBlock,
                    toBlock,
                });

                for (const log of logs) {
                    try {
                        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
                        if (parsed) await handleLog(parsed, log.blockNumber);
                    } catch {
                        // unknown event signature — skip silently
                    }
                }

                totalEvents += logs.length;
                lastBlock = toBlock;
                fromBlock = toBlock + 1;
            }

            if (totalEvents > 0) {
                console.log(`[POLL] ✅ Synced up to #${currentBlock} | ${totalEvents} event(s) processed`);
            } else {
                process.stdout.write(`\r[POLL] Block #${currentBlock} — listening...          `);
            }
        } catch (err) {
            console.error(`\n[POLL] ⚠️  getLogs error: ${err.message} — retrying next cycle`);
            // Do NOT update lastBlock — will retry same range next cycle
        }
    }

    // ── Connect + start polling ────────────────────────────
    async function connect() {
        try {
            provider  = new ethers.JsonRpcProvider(RPC_URL);
            const net = await provider.getNetwork();
            iface     = new ethers.Interface(CONTRACT_ABI);

            const currentBlock = await provider.getBlockNumber();
            lastBlock = START_BLOCK && START_BLOCK > 0
                ? Math.min(START_BLOCK - 1, currentBlock - 1)
                : Math.max(0, currentBlock - 5000);

            console.log(`[AGT-0004] ✅ Connected — Chain ID: ${net.chainId} | Current: #${currentBlock} | Backfill start: #${lastBlock + 1}`);
            console.log(`[AGT-0004] 🔁 Polling FNS contract every ${POLL_INTERVAL / 1000}s via getLogs`);
            console.log(`[AGT-0004] 📋 Contract: ${CONTRACT_ADDRESS}\n`);

            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(poll, POLL_INTERVAL);
            await poll(); // immediate first sweep
        } catch (err) {
            console.error(`[AGT-0004] ❌ Connection failed: ${err.message} — retrying in 15s...`);
            setTimeout(connect, 15000);
        }
    }

    await connect();
}

// ── IGNITION ───────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`[API] ✅ REST server live → http://localhost:${PORT}`);
    console.log(`[API]    GET /api/resolve/:namespace`);
    console.log(`[API]    GET /api/namespaces`);
    console.log(`[API]    GET /api/search?q=keyword`);
    console.log(`[API]    GET /api/health`);
    await bootWatcher();
});

process.on('uncaughtException',  err => console.error('[FATAL] Uncaught exception:', err.message));
process.on('unhandledRejection', err => console.error('[FATAL] Unhandled rejection:', err));
