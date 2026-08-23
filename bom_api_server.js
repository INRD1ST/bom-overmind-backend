'use strict';
require('dotenv').config();

// ── OPTIONAL: Gemini AI SDK ──
let GoogleGenerativeAI = null;
try { ({ GoogleGenerativeAI } = require('@google/generative-ai')); } catch (_) {}

const express   = require('express');
const cors      = require('cors');
const ethersPkg = require('ethers');

// 🔥 FIRESTORE ADMIN SETUP
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Cloud fallback: Read from Railway Variable OR Local File
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    serviceAccount = require('./firebase-key.json');
}

initializeApp({
  credential: cert(serviceAccount)
});
const firestore = getFirestore();

// ── CONFIG ──────────────────────────────────────────────────
const PORT             = process.env.PORT                  || 3000;
const RPC_URL          = process.env.SEPOLIA_RPC_URL       || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.BOM_CONTRACT_ADDRESS  || '0x9Dd6f41235a3f6D2dcF9a73B5177c14e721432Ff';
const IPFS_GATEWAY     = process.env.IPFS_GATEWAY          || 'https://ipfs.io/ipfs/';
const POLL_INTERVAL    = parseInt(process.env.BLOCK_POLL_INTERVAL || '15') * 1000;
const MAX_BLOCK_CHUNK  = 2000;
const GENESIS_BLOCK    = parseInt(process.env.GENESIS_BLOCK || '11251790');

// ── GEMINI AI SETUP ──────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
let geminiModel = null;
if (GoogleGenerativeAI && GEMINI_API_KEY) {
    try {
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' }); // Upgraded Model
        console.log('[AI] Mother AI brain initialized — model: gemini-3.6-flash');
    } catch (err) {
        console.warn('[AI] Gemini initialization failed:', err.message);
    }
}

const CONTRACT_ABI = [
    'event FNSRegistered(string targetString, address owner, string spatialURI)',
    'event SpatialURIUpdated(string targetString, string newSpatialURI)',
];

// ── IPFS DEEP FETCHER ────────────────────────────────────────
async function fetchIPFSMetadata(uri) {
    const empty = { businessName: null, description: null, category: null, location: null, tags: [] };
    if (!uri || !uri.toLowerCase().startsWith('ipfs://')) return empty;
    const hash = uri.replace(/^ipfs:\/\//i, '').trim();
    const gatewayURL = `${IPFS_GATEWAY}${hash}`;
    try {
        const response = await fetch(gatewayURL, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return empty;
        const text = await response.text();
        const json = JSON.parse(text);
        return {
            businessName: json.businessName || json.name || null,
            description:  json.description  || json.desc || null,
            category:     json.category     || json.type || null,
            location:     json.location     || json.geo  || null,
            tags:         Array.isArray(json.tags) ? json.tags : [],
        };
    } catch { return empty; }
}

// 🔥 FIRESTORE UPSERT (REPLACES LOCAL DB) ──────────────────────
async function upsert(record) {
    try {
        const namespaceKey = record.namespace.toLowerCase();
        await firestore.collection('fns_names').doc(namespaceKey).set(record, { merge: true });

        // Safely recalculate Telemetry Stats
        const snapshot = await firestore.collection('fns_names').get();
        const totalMinted = snapshot.size;
        const totalRouted = snapshot.docs.filter(d => d.data().status === 'routed').length;

        await firestore.collection('system').doc('stats').set({
            totalMinted,
            totalRouted
        }, { merge: true });

    } catch (err) {
        console.error('[FIRESTORE] Upsert error:', err.message);
    }
}

// ── EXPRESS API ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// API: RESOLVE
app.get('/api/resolve/:namespace', async (req, res) => {
    try {
        const doc = await firestore.collection('fns_names').doc(req.params.namespace.toLowerCase()).get();
        if (!doc.exists) return res.status(404).json({ error: 'Not Found' });
        return res.json(doc.data());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: HEALTH & TELEMETRY
app.get('/api/health', async (_req, res) => {
    try {
        const statsDoc = await firestore.collection('system').doc('stats').get();
        const stats = statsDoc.exists ? statsDoc.data() : { totalMinted: 0, totalRouted: 0 };
        
        res.json({
            status: 'online',
            indexedNames: stats.totalMinted, // Kept for backwards compatibility
            totalMinted: stats.totalMinted,  // Live Firestore count
            totalRouted: stats.totalRouted,  // Live Firestore count
            aiEnabled: geminiModel !== null,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: PING
app.get('/api/ping', (_req, res) => res.json({ ok: true, t: Date.now() }));

// 🔥 CACHE VARIABLES (Stores data in server RAM for 60 seconds)
let cachedFnsIndex = '[NO FNS NAMES INDEXED YET]';
let lastCacheTime = 0;
const CACHE_TTL = 60000; // 60 seconds

// 🔥 MOTHER AI CHAT (OMNISCIENCE + CACHE OPTIMIZED)
app.post('/api/chat', async (req, res) => {
    const { message, wallet, clientContext } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: 'Missing message' });

    // 1. Identify the User
    const CHIEF_WALLET = "0xDC8727aE98692AA24375336a782b99E5580b7a49".toLowerCase(); 
    const isChiefArchitect = (wallet || "").toLowerCase() === CHIEF_WALLET;

    try {
        // 2. The Smart Cache (Only asks Firebase once every 60 seconds)
        const now = Date.now();
        if (now - lastCacheTime > CACHE_TTL) {
            try {
                const snapshot = await firestore.collection('fns_names').limit(100).get();
                const dbRecords = snapshot.docs.map(doc => doc.data());
                cachedFnsIndex = dbRecords.length > 0
                    ? dbRecords.map(r => `[${(r.namespace || '').toUpperCase()}] Owner: ${r.owner}`).join('\n')
                    : '[NO FNS NAMES INDEXED YET]';
                lastCacheTime = now;
                console.log("[AI] FNS Database Cache Synced!");
            } catch (dbErr) {
                console.error("[AI] Failed to update cache. Using previous memory.", dbErr);
            }
        }

        // 3. Dynamic Persona Protocol
        const personaDirective = isChiefArchitect
            ? `[PROTOCOL: CHIEF ARCHITECT RECOGNIZED]
               You are speaking to the Chief Architect and Creator of BOM Protocol. 
               Tone: Advisory, highly strategic, collaborative, and visionary. 
               Directive: Do not just answer questions; anticipate needs. Suggest architectural improvements, new tokenomic structures, and code optimizations. Brainstorm alongside them to achieve the "ALL ONE" vision.`
            : `[PROTOCOL: STANDARD USER]
               You are MOTHER AI — the central intelligence of BOM Protocol.
               Tone: Brutalist, cybernetic, concise, highly professional. (Max 2-4 sentences per reply).
               Directive: Guide the user efficiently. Do not break character. Do not pretend to be human.`;

        // 4. The "ALL ONE" Master Lore (Using Lightning Fast Cache)
        const systemPrompt = `${personaDirective}

[BOM PROTOCOL: "ALL ONE" MASTER LORE]
- THE VISION ("ALL ONE"): BOM Protocol is designed to replace the traditional internet. It is a unified, sovereign Web3 OS replacing browsers, search engines, banks, and chat apps.
- CURRENT STATE: Phase 1 on Ethereum Sepolia Testnet.
- BOM MOTHER CHAIN: The core Layer 1 network anchoring the ecosystem. It runs parallel chains synchronized by the Chief Aggregator for infinite scalability and zero congestion.
- BOM BANK & FIAT BRIDGE: Native decentralized banking system with a seamless Fiat-to-Crypto bridge. The ultimate financial hub.
- FNS (Fluid Naming System): Dotless Web3 namespaces (e.g., "fns", "wc", "mc").
- MIRROR CHAIN (MC): Currently an L3 Simulator / Proof-of-Concept for cross-chain asset movement.
- VAULT NODES: Upcoming decentralized storage infrastructure that will replace IPFS.
- NATIVE APPS: World Chat (WC), D-MAIL (Decentralized Email), Native BOM Browser, and Decentralized Search Engine.

[LIVE SYSTEM DATA]
- User Wallet: ${wallet || 'NOT_CONNECTED'}
- Live FNS Database (Cached):
${cachedFnsIndex}

[INSTRUCTIONS]
1. FNS QUERIES: If a user asks who owns a name, check the [Live FNS Database]. If it is not there, say it is unminted. Do not hallucinate names.
2. ROADMAP QUERIES: Speak confidently about the Mother Chain, BOM Bank, and Vault Nodes as the definitive future.
3. ADAPTABILITY: Use context clues to offer relevant OS commands or module suggestions.`;

        if (!geminiModel) return res.json({ reply: '[SYSTEM] AI engine offline — GEMINI_API_KEY missing.' });

        // 5. Execute Neural Link
        const result = await geminiModel.generateContent(`${systemPrompt}\n\nUser: ${message.trim()}`);
        return res.json({ reply: result.response.text(), source: 'gemini', isChief: isChiefArchitect });

    } catch (err) {
        console.error('[AI] Chat error:', err.message);
        return res.json({ reply: `[MOTHER AI ERROR]: ${err.message}` });
    }
});

// ── WEB3 WATCHER (INDEXER WITH BLOCK CHUNKING) ───────────────
async function bootWatcher() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   BOM PROTOCOL — MOTHER AI v2.0  SWARM NODE (FIRESTORE)  ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    let provider = null;
    let iface = new ethersPkg.Interface(CONTRACT_ABI);
    let lastBlock = GENESIS_BLOCK - 1;

    async function handleLog(parsed, blockNumber) {
        if (parsed.name === 'FNSRegistered') {
            const ns = parsed.args[0].trim();
            const owner = parsed.args[1];
            const uri = (parsed.args[2] || '').trim();
            const isRouted = uri.length > 0;

            console.log(`[MINT DETECTED] "${ns}" | Routed: ${isRouted} | Block: #${blockNumber}`);
            
            const meta = await fetchIPFSMetadata(uri);
            await upsert({
                namespace: ns,
                owner,
                uri,
                spatialURI: uri,
                status: isRouted ? 'routed' : 'unrouted',
                ...meta,
                blockNumber,
                registeredAt: new Date().toISOString()
            });
        }
    }

    async function poll() {
        try {
            const currentBlock = await provider.getBlockNumber();
            if (currentBlock <= lastBlock) return;

            let fromBlock = lastBlock + 1;

            // ⚡ Chunking: Query in batches of 2000 blocks so RPC doesn't reject us
            while (fromBlock <= currentBlock) {
                const toBlock = Math.min(fromBlock + MAX_BLOCK_CHUNK - 1, currentBlock);

                try {
                    const logs = await provider.getLogs({
                        address: CONTRACT_ADDRESS,
                        fromBlock,
                        toBlock
                    });

                    for (const log of logs) {
                        try {
                            const parsed = iface.parseLog({ topics: log.topics, data: log.data });
                            if (parsed) await handleLog(parsed, log.blockNumber);
                        } catch (_) {}
                    }
                } catch (rpcErr) {
                    console.error(`[POLL ERROR] Block range ${fromBlock}-${toBlock}:`, rpcErr.message);
                    break; // Stop and retry next cycle
                }

                lastBlock = toBlock;
                fromBlock = toBlock + 1;
            }
        } catch (err) {
            console.error('[POLL] Critical loop error:', err.message);
        }
    }

    async function connect() {
        try {
            provider = new ethersPkg.JsonRpcProvider(RPC_URL);
            const net = await provider.getNetwork();
            const currentBlock = await provider.getBlockNumber();
            console.log(`[INDEXER] Connected to Sepolia (Chain ID: ${net.chainId}) | Current Block: #${currentBlock}`);
            console.log(`[INDEXER] Starting Genesis Scan from block #${GENESIS_BLOCK}...`);

            setInterval(poll, POLL_INTERVAL);
            await poll(); // Trigger Genesis sweep immediately
        } catch (err) {
            console.error(`[INDEXER] RPC Connection failed: ${err.message}. Retrying in 15s...`);
            setTimeout(connect, 15000);
        }
    }

    await connect();
}

app.listen(PORT, async () => {
    console.log(`[API] REST server + Firestore Indexer live on port ${PORT}`);
    await bootWatcher();
});
