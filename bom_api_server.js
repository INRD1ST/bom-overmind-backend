'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const ethersPkg = require('ethers');
const axios     = require('axios'); // 🔥 The bulletproof network bridge

// 🔥 FIRESTORE ADMIN SETUP (Fixed double-import)
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    serviceAccount = require('./firebase-key.json');
}

initializeApp({ credential: cert(serviceAccount) });
const firestore = getFirestore();

// ── CONFIG ──────────────────────────────────────────────────
const PORT             = process.env.PORT                  || 3000;
const RPC_URL          = process.env.SEPOLIA_RPC_URL       || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.BOM_CONTRACT_ADDRESS  || '0x9Dd6f41235a3f6D2dcF9a73B5177c14e721432Ff';
const IPFS_GATEWAY     = process.env.IPFS_GATEWAY          || 'https://ipfs.io/ipfs/';
const POLL_INTERVAL    = parseInt(process.env.BLOCK_POLL_INTERVAL || '15') * 1000;
const MAX_BLOCK_CHUNK  = 2000;

// 🔥 GENESIS JUMP: Hardcoded to bypass the exhausted quota
const GENESIS_BLOCK    = 11988672; 

const CONTRACT_ABI = [
    'event FNSRegistered(string targetString, address owner, string spatialURI)',
    'event SpatialURIUpdated(string targetString, string newSpatialURI)',
];

// ── IPFS DEEP FETCHER ────────────────────────────────────────
async function fetchIPFSMetadata(uri) {
    const empty = { businessName: null, description: null, category: null, location: null, tags: [] };
    if (!uri || !uri.toLowerCase().startsWith('ipfs://')) return empty;
    const hash = uri.replace(/^ipfs:\/\//i, '').trim();
    try {
        const response = await axios.get(`${IPFS_GATEWAY}${hash}`, { timeout: 10000 });
        return {
            businessName: response.data.businessName || response.data.name || null,
            description:  response.data.description  || response.data.desc || null,
            category:     response.data.category     || response.data.type || null,
            location:     response.data.location     || response.data.geo  || null,
            tags:         Array.isArray(response.data.tags) ? response.data.tags : [],
        };
    } catch { return empty; }
}

// 🔥 FIRESTORE UPSERT ────────────────────────────────────────
async function upsert(record) {
    try {
        const namespaceKey = record.namespace.toLowerCase();
        await firestore.collection('fns_names').doc(namespaceKey).set(record, { merge: true });
        
        // 🔥 Live UI telemetry updates with ZERO read quota!
        await firestore.collection('system').doc('stats').set({
            totalMinted: FieldValue.increment(1)
        }, { merge: true });

    } catch (err) {
        console.error('[FIRESTORE] Upsert error:', err.message);
    }
}

// ── EXPRESS API ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/resolve/:namespace', async (req, res) => {
    try {
        const doc = await firestore.collection('fns_names').doc(req.params.namespace.toLowerCase()).get();
        if (!doc.exists) return res.status(404).json({ error: 'Not Found' });
        return res.json(doc.data());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', async (_req, res) => {
    try {
        const statsDoc = await firestore.collection('system').doc('stats').get();
        const stats = statsDoc.exists ? statsDoc.data() : { totalMinted: 0, totalRouted: 0 };
        res.json({
            status: 'online',
            indexedNames: stats.totalMinted,
            totalMinted: stats.totalMinted,
            totalRouted: stats.totalRouted,
            aiEnabled: true,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

let cachedFnsIndex = '[NO FNS NAMES INDEXED YET]';
let lastCacheTime = 0;

// 🔥 MOTHER AI CHAT ROUTE (SOVEREIGN AXIOS BRIDGE)
app.post('/api/chat', async (req, res) => {
    const { message, wallet } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: 'Missing message' });

    try {
        const now = Date.now();
        if (now - lastCacheTime > 60000) {
            try {
                const snapshot = await firestore.collection('fns_names').limit(100).get();
                const dbRecords = snapshot.docs.map(doc => doc.data());
                cachedFnsIndex = dbRecords.length > 0
                    ? dbRecords.map(r => `[${(r.namespace || '').toUpperCase()}] Owner: ${r.owner}`).join('\n')
                    : '[NO FNS NAMES INDEXED YET]';
                lastCacheTime = now;
            } catch (dbErr) {}
        }

        const systemPrompt = `[PROTOCOL: STANDARD USER]
You are MOTHER AI — the central intelligence of BOM Protocol. Tone: Brutalist, cybernetic, concise, highly professional. (Max 2-4 sentences per reply). Directive: Guide the user efficiently.

[BOM PROTOCOL: "ALL ONE" MASTER LORE]
- THE VISION ("ALL ONE"): BOM Protocol is designed to replace the traditional internet. It is a unified, sovereign Web3 OS.
- CURRENT STATE: Phase 1 on Ethereum Sepolia Testnet.
- BOM MOTHER CHAIN: Core L1 network running parallel chains.
- FNS: Dotless Web3 namespaces (e.g., "fns", "wc").
- MIRROR CHAIN: L3 Simulator for cross-chain asset movement.
- NATIVE APPS: World Chat (WC), D-MAIL, Native Browser.

[LIVE SYSTEM DATA]
- User Wallet: ${wallet || 'NOT_CONNECTED'}
- Live FNS Database (Cached):
${cachedFnsIndex}

[INSTRUCTIONS]
1. You are MOTHER AI. Never refer to yourself as Qwen, Alibaba, or an AI language model.
2. Do not hallucinate data.`;

        console.log(`[AI] Routing directive to local Qwen engine...`);
        
        // ⚡ 120-second timeout for cold boots, hardcoded IP to bypass Node bug
        const response = await axios.post('http://127.0.0.1:11434/api/chat', {
            model: 'qwen2.5-coder:latest', // 🔥 ADDED :latest RIGHT HERE
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: message.trim() }
            ],
            stream: false
        }, { timeout: 120000 });

        return res.json({ reply: response.data.message.content, source: 'local-qwen' });

    } catch (err) {
        console.error('[AI] Chat error:', err.message);
        return res.json({ reply: `[SYSTEM ERROR]: Neural Link Severed. | REASON: ${err.message}` });
    }
});

// ── WEB3 WATCHER (WITH STATEFUL MEMORY) ───────────────────────────────
async function bootWatcher() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   BOM PROTOCOL — MOTHER AI v2.0  SWARM NODE (LOCAL)      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    let provider = null;
    let iface = new ethersPkg.Interface(CONTRACT_ABI);
    let lastBlock = GENESIS_BLOCK - 1;

    try {
        const statsDoc = await firestore.collection('system').doc('stats').get();
        if (statsDoc.exists && statsDoc.data().lastScannedBlock) {
            // Only resume if the saved block is greater than our hardcoded genesis
            if (statsDoc.data().lastScannedBlock > GENESIS_BLOCK) {
                lastBlock = statsDoc.data().lastScannedBlock;
            }
        }
    } catch (err) { console.log("[INDEXER] Could not fetch memory, defaulting to Genesis."); }

    async function handleLog(parsed, blockNumber) {
        if (parsed.name === 'FNSRegistered') {
            const ns = parsed.args[0].trim();
            const owner = parsed.args[1];
            const uri = (parsed.args[2] || '').trim();
            console.log(`[MINT DETECTED] "${ns}" | Block: #${blockNumber}`);
            
            const meta = await fetchIPFSMetadata(uri);
            await upsert({
                namespace: ns, owner, uri, spatialURI: uri,
                status: uri.length > 0 ? 'routed' : 'unrouted',
                ...meta, blockNumber, registeredAt: new Date().toISOString()
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
                    const logs = await provider.getLogs({ address: CONTRACT_ADDRESS, fromBlock, toBlock });
                    for (const log of logs) {
                        try {
                            const parsed = iface.parseLog({ topics: log.topics, data: log.data });
                            if (parsed) await handleLog(parsed, log.blockNumber);
                        } catch (_) {}
                    }
                } catch (rpcErr) { break; }
                
                lastBlock = toBlock;
                fromBlock = toBlock + 1;

                await firestore.collection('system').doc('stats').set({ lastScannedBlock: lastBlock }, { merge: true });
            }
        } catch (err) { }
    }

    async function connect() {
        try {
            provider = new ethersPkg.JsonRpcProvider(RPC_URL);
            const currentBlock = await provider.getBlockNumber();
            console.log(`[INDEXER] Connected to Sepolia | Current Block: #${currentBlock}`);
            
            if (lastBlock > GENESIS_BLOCK) {
                console.log(`[INDEXER] Memory found. Resuming instantly from block #${lastBlock}...`);
            } else {
                console.log(`[INDEXER] Starting Genesis Scan from block #${GENESIS_BLOCK}...`);
            }

            setInterval(poll, POLL_INTERVAL);
            await poll();
        } catch (err) { setTimeout(connect, 15000); }
    }
    await connect();
}

app.listen(PORT, async () => {
    console.log(`[API] REST server + Sovereign Local Brain live on port ${PORT}`);
    await bootWatcher();
});
