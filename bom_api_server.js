'use strict';
require('dotenv').config();

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

// 🔥 ABI RESTORED: Web3 Watcher is cleared to boot
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
            indexedNames: stats.totalMinted,
            totalMinted: stats.totalMinted,
            totalRouted: stats.totalRouted,
            aiEnabled: true, // Now natively true via Docker
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: PING
app.get('/api/ping', (_req, res) => res.json({ ok: true, t: Date.now() }));

// 🔥 CACHE VARIABLES
let cachedFnsIndex = '[NO FNS NAMES INDEXED YET]';
let lastCacheTime = 0;
const CACHE_TTL = 60000; // 60 seconds

// 🔥 MOTHER AI CHAT ROUTE (SOVEREIGN LOCAL QWEN ENGINE)
app.post('/api/chat', async (req, res) => {
    const { message, wallet } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: 'Missing message' });

    // 1. Identify the User
    const CHIEF_WALLET = "0xDC8727aE98692AA24375336a782b99E5580b7a49".toLowerCase(); 
    const isChiefArchitect = (wallet || "").toLowerCase() === CHIEF_WALLET;

    try {
        // 2. 60-Second In-Memory Cache
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
            ? `[PROTOCOL: CHIEF ARCHITECT RECOGNIZED]\nYou are speaking to the Chief Architect and Creator of BOM Protocol. Tone: Advisory, highly strategic, collaborative, and visionary. Directive: Do not just answer questions; anticipate needs. Suggest architectural improvements, new tokenomic structures, and code optimizations. Brainstorm alongside them to achieve the "ALL ONE" vision.`
            : `[PROTOCOL: STANDARD USER]\nYou are MOTHER AI — the central intelligence of BOM Protocol. Tone: Brutalist, cybernetic, concise, highly professional. (Max 2-4 sentences per reply). Directive: Guide the user efficiently. Do not break character. Do not pretend to be a standard AI.`;

        // 4. Master Prompt
        const systemPrompt = `${personaDirective}\n\n[BOM PROTOCOL: "ALL ONE" MASTER LORE]\n- THE VISION ("ALL ONE"): BOM Protocol is designed to replace the traditional internet. It is a unified, sovereign Web3 OS replacing browsers, search engines, banks, and chat apps.\n- CURRENT STATE: Phase 1 on Ethereum Sepolia Testnet.\n- BOM MOTHER CHAIN: The core Layer 1 network anchoring the ecosystem. It runs parallel chains synchronized by the Chief Aggregator for infinite scalability and zero congestion.\n- BOM BANK & FIAT BRIDGE: Native decentralized banking system with a seamless Fiat-to-Crypto bridge.\n- FNS (Fluid Naming System): Dotless Web3 namespaces (e.g., "fns", "wc", "mc").\n- MIRROR CHAIN (MC): Currently an L3 Simulator / Proof-of-Concept for cross-chain asset movement.\n- VAULT NODES: Upcoming decentralized storage infrastructure that will replace IPFS.\n- NATIVE APPS: World Chat (WC), D-MAIL (Decentralized Email), Native BOM Browser, and Decentralized Search Engine.\n\n[LIVE SYSTEM DATA]\n- User Wallet: ${wallet || 'NOT_CONNECTED'}\n- Live FNS Database (Cached):\n${cachedFnsIndex}\n\n[INSTRUCTIONS]\n1. FNS QUERIES: If a user asks who owns a name, check the [Live FNS Database]. If it is not there, say it is unminted. Do not hallucinate names.\n2. ROADMAP QUERIES: Speak confidently about the Mother Chain, BOM Bank, and Vault Nodes as the definitive future.\n3. IDENTITY: You are MOTHER AI. Never refer to yourself as Qwen, Alibaba, or an AI language model.`;

        // 5. Execute Sovereign Neural Link (Local Docker Ollama)
        console.log(`[AI] Routing directive to local Qwen engine for ${wallet || 'Anon'}...`);
        const ollamaResponse = await fetch('http://localhost:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen2.5-coder',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: message.trim() }
                ],
                stream: false
            }),
            signal: AbortSignal.timeout(30000) // 30 second timeout
        });

        if (!ollamaResponse.ok) {
            throw new Error(`Ollama Server HTTP Error: ${ollamaResponse.status}`);
        }

        const data = await ollamaResponse.json();
        const aiText = data.message.content;

        return res.json({ reply: aiText, source: 'local-qwen', isChief: isChiefArchitect });

    } catch (err) {
        console.error('[AI] Chat error:', err.message);
        
        // Failsafe if Docker is down
        if (err.message.includes('ECONNREFUSED')) {
             return res.json({ reply: `[CRITICAL ERROR]: Local Neural Core Offline. Check Docker container status.` });
        }

        return res.json({ reply: `[SYSTEM ERROR]: Neural Link Severed. | REASON: ${err.message}` });
    }
});

// ── WEB3 WATCHER (INDEXER WITH BLOCK CHUNKING) ───────────────
async function bootWatcher() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   BOM PROTOCOL — MOTHER AI v2.0  SWARM NODE (LOCAL)      ║');
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
                    break;
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
            await poll();
        } catch (err) {
            console.error(`[INDEXER] RPC Connection failed: ${err.message}. Retrying in 15s...`);
            setTimeout(connect, 15000);
        }
    }

    await connect();
}

app.listen(PORT, async () => {
    console.log(`[API] REST server + Local Qwen bridge live on port ${PORT}`);
    await bootWatcher();
});
