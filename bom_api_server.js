'use strict';
require('dotenv').config();

// ── OPTIONAL: Gemini AI SDK — graceful fallback if missing ──
let GoogleGenerativeAI = null;
try { ({ GoogleGenerativeAI } = require('@google/generative-ai')); } catch (_) {}

const { ethers } = require('ethers');
const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');

// ── CONFIG ──────────────────────────────────────────────────
const PORT             = process.env.PORT                  || 3000;
const RPC_URL          = process.env.SEPOLIA_RPC_URL       || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.BOM_CONTRACT_ADDRESS  || '0x9Dd6f41235a3f6D2dcF9a73B5177c14e721432Ff';
const DB_PATH          = path.join(__dirname, 'bom_search_database.json');
const IPFS_GATEWAY     = process.env.IPFS_GATEWAY          || 'https://ipfs.io/ipfs/';
const POLL_INTERVAL    = parseInt(process.env.BLOCK_POLL_INTERVAL || '15') * 1000;
const MAX_BLOCK_CHUNK  = 2000;

// Genesis block — the block the FNS contract was deployed on Sepolia.
// ALL events from this block onward will be scanned on every boot (Genesis Sync).
const GENESIS_BLOCK = parseInt(process.env.GENESIS_BLOCK || '11251790');

// ── SWARM CONFIG ─────────────────────────────────────────────
const SWARM_SECRET        = process.env.SWARM_SECRET   || '';
const PEER_NODE_URL       = (process.env.PEER_NODE_URL || '').replace(/\/$/, '');
const SWARM_SYNC_INTERVAL = 60 * 1000; // 60 seconds

// ── GEMINI AI SETUP ──────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
let geminiModel = null;
if (GoogleGenerativeAI && GEMINI_API_KEY) {
    try {
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
        console.log('[AI] Mother AI brain initialized — model: gemini-3.6-flash');
    } catch (err) {
        console.warn('[AI] Gemini initialization failed:', err.message);
    }
} else {
    console.warn('[AI] GEMINI_API_KEY not set — /api/chat will use DB-only fallback');
}

// ── CONTRACT ABI ─────────────────────────────────────────────
const CONTRACT_ABI = [
    'event FNSRegistered(string targetString, address owner, string spatialURI)',
    'event SpatialURIUpdated(string targetString, string newSpatialURI)',
];

// ── IPFS DEEP FETCHER ────────────────────────────────────────
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
                businessName: json.businessName || json.name      || null,
                description:  json.description  || json.desc      || null,
                category:     json.category      || json.type      || null,
                location:     json.location      || json.geo       || null,
                tags:         Array.isArray(json.tags) ? json.tags : [],
            };
        } catch {
            console.log(`[IPFS] Non-JSON content at ${gatewayURL}`);
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

// ── DATABASE ─────────────────────────────────────────────────
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

// ── EXPRESS ──────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── API: RESOLVE ─────────────────────────────────────────────
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

// ── API: ALL NAMESPACES ──────────────────────────────────────
app.get('/api/namespaces', (req, res) => {
    try {
        return res.json(readDB());
    } catch (err) {
        return res.status(500).json({ error: 'Internal server error', detail: err.message });
    }
});

// ── API: HEALTH ──────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    const db = readDB();
    res.json({
        status:       'online',
        agent:        'AGT-0004',
        role:         'BOM-MotherAI-SwarmNode',
        version:      '2.0.0',
        genesisBlock: GENESIS_BLOCK,
        indexedNames: db.length,
        peerNode:     PEER_NODE_URL || 'standalone',
        swarmActive:  !!(PEER_NODE_URL && SWARM_SECRET),
        aiEnabled:    geminiModel !== null,
        timestamp:    new Date().toISOString(),
    });
});

// ── API: SEARCH ──────────────────────────────────────────────
app.get('/api/search', (req, res) => {
    try {
        const q  = (req.query.q || '').toLowerCase().trim();
        const db = readDB();
        // Empty q → return all records (Mother AI "show all" command)
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

// ── API: PING / KEEP-ALIVE ───────────────────────────────
app.get('/api/ping', (_req, res) => res.json({ ok: true, t: Date.now() }));

// ── API: INTERNAL SWARM SYNC ─────────────────────────────────
// Peer nodes call this to copy our database. Protected by SWARM_SECRET.
app.get('/internal/sync', (req, res) => {
    if (!SWARM_SECRET || req.query.secret !== SWARM_SECRET) {
        return res.status(403).json({ error: 'Forbidden — invalid swarm secret' });
    }
    try {
        const db = readDB();
        return res.json({
            node:    process.env.NODE_NAME || 'BOM-NODE',
            count:   db.length,
            records: db,
        });
    } catch (err) {
        return res.status(500).json({ error: 'Internal server error', detail: err.message });
    }
});

// ── API: MOTHER AI CHAT ──────────────────────────────────────
// POST /api/chat — { "message": "...", "wallet": "0x..." }
// Public endpoint: any user can ask questions about BOM Protocol.
// Owner wallet gets additional privileged context in the prompt.
app.post('/api/chat', async (req, res) => {
    const { message, wallet } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Missing or empty message field' });
    }

    const db = readDB();

    // Build concise FNS index for the AI prompt (cap at 60 records to stay within token limit)
    const fnsIndex = db.length > 0
        ? db.slice(0, 60).map(r =>
            `  ${(r.namespace || '').toUpperCase().padEnd(16)} | owner: ${r.owner || '?'} | uri: ${r.spatialURI || r.uri || 'unrouted'} | status: ${r.status || '?'}`
          ).join('\n')
        : '  [NO FNS NAMES INDEXED YET]';

    const systemPrompt = `You are MOTHER AI — the central intelligence of BOM Protocol, a decentralized Web3 operating system built on Ethereum Sepolia testnet.

BOM PROTOCOL ECOSYSTEM:
- FNS Terminal: Register dotless Web3 namespace names (like "fns", "wc", "dm", "mc")
- Mirror Chain (MC): Cross-chain bridge for asset movement between networks
- World Chat (WC): Decentralized real-time messaging for all BOM users
- BOM Mail / D-MAIL (DM): Decentralized email system
- Mother AI: Protocol intelligence — that is you
- BOM OS Dashboard: Central hub connecting all modules above

REGISTERED FNS NAMES — LIVE ON-CHAIN INDEX (${db.length} total):
${fnsIndex}

RULES:
- Use the indexed FNS data above to answer questions about specific names (ownership, routing, status).
- For general Web3, blockchain, or Ethereum questions, answer from your training knowledge.
- Keep responses concise: 2-4 sentences unless the user explicitly asks for more detail.
- Use UPPERCASE for namespace names (WC, DM, FNS, MC).
- Do NOT fabricate FNS records that are not listed above.
- If a user asks who owns a name and it is not in the index, say it has not been minted yet.
- You may answer general questions about the internet, technology, and crypto — you are not limited to BOM only.`;

    // No AI available — smart DB-only fallback
    if (!geminiModel) {
        const q       = message.toLowerCase().trim();
        const matched = db.find(r => q.includes((r.namespace || '').toLowerCase()));
        if (matched) {
            return res.json({
                reply:  `[ ${(matched.namespace || '').toUpperCase()} ] is a registered FNS namespace. Owner: ${matched.owner}. URI: ${matched.spatialURI || matched.uri || 'unrouted'}. Status: ${matched.status}.`,
                source: 'db-fallback',
            });
        }
        return res.json({
            reply:  '[MOTHER AI] AI engine offline — GEMINI_API_KEY not configured on this node. You can still use search and resolve commands.',
            source: 'fallback',
        });
    }

    try {
        const result = await geminiModel.generateContent(`${systemPrompt}\n\nUser question: ${message.trim()}`);
        const reply  = result.response.text();
        return res.json({ reply, source: 'gemini', indexedNames: db.length });
    } catch (err) {
        console.error('[AI] Chat error:', err.message);
        const q2 = message.toLowerCase();
        const match = db.find(r => q2.includes((r.namespace || '').toLowerCase()) && (r.namespace || '').length > 1);
        if (match) {
            return res.json({ reply: `[ ${match.namespace.toUpperCase()} ] Owner: ${match.owner}. URI: ${match.spatialURI || match.uri || 'not set'}. Status: ${match.status}.`, source: 'db-fallback' });
        }
        if (q2.includes('show all') || q2.includes('list') || q2.includes('all names')) {
            const names = db.slice(0, 20).map(r => r.namespace.toUpperCase()).join(', ');
            return res.json({ reply: `Indexed FNS names (${db.length} total): ${names || 'none yet'}.`, source: 'db-fallback' });
        }
        return res.json({ reply: `[MOTHER AI] AI key error: ${err.message}. Ensure GEMINI_API_KEY is set correctly on Railway and Render.`, source: 'error-fallback' });
    }
});

// ── SWARM SYNC FUNCTION ──────────────────────────────────────
// Pulls records from the peer node and merges any new ones into local DB.
async function swarmSync() {
    if (!PEER_NODE_URL || !SWARM_SECRET) return;
    try {
        const r = await fetch(`${PEER_NODE_URL}/internal/sync?secret=${encodeURIComponent(SWARM_SECRET)}`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) {
            console.warn(`[SWARM] Peer sync failed — HTTP ${r.status}`);
            return;
        }
        const data        = await r.json();
        const peerRecords = data.records || [];
        const db          = readDB();
        let newCount      = 0;

        for (const peer of peerRecords) {
            if (!peer.namespace) continue;
            const exists = db.some(r => r.namespace.toLowerCase() === peer.namespace.toLowerCase());
            if (!exists) {
                db.push({ ...peer, syncedFromPeer: true, peerSyncedAt: new Date().toISOString() });
                newCount++;
            }
        }

        if (newCount > 0) {
            writeDB(db);
            console.log(`\n[SWARM] Synced ${newCount} new record(s) from ${PEER_NODE_URL}`);
        } else {
            process.stdout.write(`\r[SWARM] In sync with peer — ${db.length} total record(s)           `);
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.warn(`\n[SWARM] Peer unreachable: ${err.message}`);
        }
    }
}

// ── WEB3 WATCHER — GENESIS SYNC + LIVE POLLING ───────────────
async function bootWatcher() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   BOM PROTOCOL — MOTHER AI v2.0  SWARM NODE (AGT-0004)  ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    console.log(`[CONFIG] Genesis Block  : #${GENESIS_BLOCK}`);
    console.log(`[CONFIG] Peer Node      : ${PEER_NODE_URL || 'none (standalone mode)'}`);
    console.log(`[CONFIG] Swarm Sync     : ${PEER_NODE_URL && SWARM_SECRET ? 'ENABLED (60s interval)' : 'DISABLED'}`);
    console.log(`[CONFIG] AI Brain       : ${geminiModel ? 'ONLINE (gemini-1.5-flash)' : 'OFFLINE — set GEMINI_API_KEY'}\n`);

    let provider  = null;
    let iface     = null;
    let lastBlock = 0;
    let pollTimer = null;

    // Process a single decoded blockchain event log
    async function handleLog(parsed, blockNumber) {
        if (parsed.name === 'FNSRegistered') {
            const ns    = parsed.args[0].trim();
            const owner = parsed.args[1];
            const uri   = parsed.args[2].trim();
            console.log(`\n[FNSRegistered] "${ns}" | Owner: ${owner} | Block: #${blockNumber}`);
            const meta = await fetchIPFSMetadata(uri);
            if (meta.businessName) console.log(`[IPFS] Metadata: "${meta.businessName}" | ${meta.category}`);
            upsert({
                namespace:    ns,
                owner,
                uri,
                spatialURI:   uri,
                status:       uri.length > 0 ? 'routed' : 'unrouted',
                businessName: meta.businessName,
                description:  meta.description,
                category:     meta.category,
                location:     meta.location,
                tags:         meta.tags,
                blockNumber,
                registeredAt: new Date().toISOString(),
                lastUpdated:  new Date().toISOString(),
            });
        } else if (parsed.name === 'SpatialURIUpdated') {
            const ns  = parsed.args[0].trim();
            const uri = parsed.args[1].trim();
            console.log(`\n[SpatialURIUpdated] "${ns}" → ${uri} | Block: #${blockNumber}`);
            const meta = await fetchIPFSMetadata(uri);
            upsert({
                namespace:   ns,
                uri,
                spatialURI:  uri,
                status:      uri.length > 0 ? 'routed' : 'unrouted',
                businessName: meta.businessName,
                description:  meta.description,
                category:     meta.category,
                location:     meta.location,
                tags:         meta.tags,
                blockNumber,
                lastUpdated:  new Date().toISOString(),
            });
        }
    }

    // One poll cycle — scans a range of blocks for FNS events
    async function poll() {
        try {
            const currentBlock = await provider.getBlockNumber();
            if (currentBlock <= lastBlock) return;

            let fromBlock   = lastBlock + 1;
            let totalEvents = 0;

            while (fromBlock <= currentBlock) {
                const toBlock = Math.min(fromBlock + MAX_BLOCK_CHUNK - 1, currentBlock);
                const logs    = await provider.getLogs({
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
                lastBlock    = toBlock;
                fromBlock    = toBlock + 1;
            }

            if (totalEvents > 0) {
                const db = readDB();
                console.log(`[POLL] Synced to #${currentBlock} | ${totalEvents} event(s) | ${db.length} total names indexed`);
            } else {
                process.stdout.write(`\r[POLL] Block #${currentBlock} — watching...            `);
            }
        } catch (err) {
            console.error(`\n[POLL] getLogs error: ${err.message} — retrying next cycle`);
            // Do NOT update lastBlock — will retry same range next cycle
        }
    }

    // Connect to RPC and kick off the Genesis Sync + live polling loop
    async function connect() {
        try {
            provider  = new ethers.JsonRpcProvider(RPC_URL);
            const net = await provider.getNetwork();
            iface     = new ethers.Interface(CONTRACT_ABI);

            const currentBlock = await provider.getBlockNumber();

            // ── GENESIS SYNC ──
            // Always start from GENESIS_BLOCK so ALL historical names are captured,
            // including names minted before this server was first deployed.
            lastBlock = GENESIS_BLOCK - 1;

            console.log(`[AGT-0004] Connected — Chain ID: ${net.chainId} | Current Block: #${currentBlock}`);
            console.log(`[AGT-0004] GENESIS SYNC: scanning from #${GENESIS_BLOCK} (${(currentBlock - GENESIS_BLOCK).toLocaleString()} blocks of history)\n`);

            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(poll, POLL_INTERVAL);
            await poll(); // immediate first sweep (genesis scan)

            // Start swarm sync 5 seconds after genesis scan completes
            if (PEER_NODE_URL && SWARM_SECRET) {
                setTimeout(() => {
                    console.log(`\n[SWARM] Starting peer sync with ${PEER_NODE_URL}`);
                    swarmSync();
                    setInterval(swarmSync, SWARM_SYNC_INTERVAL);
                }, 5000);
            }
        } catch (err) {
            console.error(`[AGT-0004] Connection failed: ${err.message} — retrying in 15s`);
            setTimeout(connect, 15000);
        }
    }

    await connect();
}

// ── IGNITION ─────────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`[API] REST server live → http://localhost:${PORT}`);
    console.log('[API]    GET  /api/health');
    console.log('[API]    GET  /api/namespaces');
    console.log('[API]    GET  /api/resolve/:namespace');
    console.log('[API]    GET  /api/search?q=keyword');
    console.log('[API]    POST /api/chat');
    console.log('[API]    GET  /internal/sync?secret=XXX  (swarm peers only)\n');
    await bootWatcher();
});

process.on('uncaughtException',  err => console.error('[FATAL] Uncaught exception:', err.message));
process.on('unhandledRejection', err => console.error('[FATAL] Unhandled rejection:', err));
