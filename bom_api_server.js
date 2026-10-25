'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const ethersPkg = require('ethers');
const axios     = require('axios'); 
const fs = require('fs');
const path = require('path');

// ── SOVEREIGN VAULT (F: DRIVE) ARCHITECTURE ──
const VAULT_ROOT = 'F:\\';

const OS_DIRECTORIES = [
    'Mother_Brain\\Memory',          // AI chat history and user context
    'Mother_Brain\\Knowledge_Base',  // Scraped web data, lore, and RAG files
    'BOM_Database\\FNS_Registry',    // Replaces Firebase for dotless domains
    'BOM_Database\\L3_Subnets',      // Mirror Chains
    'BOM_Database\\System_State',    // Block indexer stats and system health
    'BOM_Database\\Swarm_Logs',      // P2P network telemetry
    'BOM_Database\\D_Mail',          // Encrypted decentralized mail
    'BOM_Database\\World_Chat',      // Global public message logs
    'BOM_Database\\Search_Index',    // Search bar queries and indexes
    'BOM_Database\\Web_Metadata'     // Site structures for the native browser
];

function forgeSovereignVault() {
    console.log('\n[GATEKEEPER] Scanning Sovereign Vault on F:\\...');
    
    OS_DIRECTORIES.forEach(dir => {
        const fullPath = path.join(VAULT_ROOT, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
            console.log(`[GATEKEEPER] Forged new sector: ${fullPath}`);
        } else {
            console.log(`[GATEKEEPER] Sector verified: ${fullPath}`);
        }
    });
    
    console.log('[GATEKEEPER] File system locked. The OS is anchored.\n');
}

// Execute the forge sequence immediately on boot
forgeSovereignVault();


// ── SOVEREIGN GATEKEEPER: LOCAL READ/WRITE PROTOCOLS ──

function writeToVault(sectorPath, filename, data) {
    try {
        const cleanName = filename.trim().toLowerCase();
        const filePath = path.join(VAULT_ROOT, sectorPath, `${cleanName}.json`);
        
        fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
        return true;
    } catch (err) {
        console.error(`[GATEKEEPER ERROR] Failed to write to ${sectorPath}:`, err.message);
        return false;
    }
}

function readFromVault(sectorPath, filename) {
    try {
        const cleanName = filename.trim().toLowerCase();
        const filePath = path.join(VAULT_ROOT, sectorPath, `${cleanName}.json`);
        
        if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(fileContent);
        }
        return null;
    } catch (err) {
        console.error(`[GATEKEEPER ERROR] Failed to read from ${sectorPath}:`, err.message);
        return null;
    }
}

// 🔥 INSTANT SSD TELEMETRY SCANNER
function getVaultTelemetry() {
    try {
        const registryPath = path.join(VAULT_ROOT, 'BOM_Database', 'FNS_Registry');
        if (!fs.existsSync(registryPath)) return { minted: 0, routed: 0 };
        
        // Count all .json files on the metal
        const files = fs.readdirSync(registryPath).filter(f => f.endsWith('.json'));
        let routedCount = 0;
        
        // Scan inside the files to see if they are routed (SSD makes this millisecond fast)
        files.forEach(file => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(registryPath, file), 'utf8'));
                if (data.status === 'routed' || (data.uri && data.uri.length > 0)) {
                    routedCount++;
                }
            } catch(e) {}
        });
        
        return { minted: files.length, routed: routedCount };
    } catch (err) {
        console.error('[GATEKEEPER ERROR] Telemetry scan failed:', err.message);
        return { minted: 0, routed: 0 };
    }
}

// ── CONFIG ──────────────────────────────────────────────────
const PORT             = process.env.PORT                  || 3000;
const RPC_URL          = process.env.SEPOLIA_RPC_URL       || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.BOM_CONTRACT_ADDRESS  || '0x9Dd6f41235a3f6D2dcF9a73B5177c14e721432Ff';
const IPFS_GATEWAY     = process.env.IPFS_GATEWAY          || 'https://ipfs.io/ipfs/';
const POLL_INTERVAL    = parseInt(process.env.BLOCK_POLL_INTERVAL || '15') * 1000;
const MAX_BLOCK_CHUNK  = 2000;

// 🔥 GENESIS JUMP
const GENESIS_BLOCK    = 11988672; 

const CONTRACT_ABI = [
    'event FNSRegistered(string targetString, address owner, string spatialURI)',
    'event SpatialURIUpdated(string targetString, string newSpatialURI)',
];

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

async function upsert(record) {
    try {
        const namespaceKey = record.namespace.toLowerCase();
        
        // Merge with existing record if it exists
        const existingData = readFromVault('BOM_Database\\FNS_Registry', namespaceKey) || {};
        const mergedData = { ...existingData, ...record };
        
        // Write to local FNS Registry
        writeToVault('BOM_Database\\FNS_Registry', namespaceKey, mergedData);
        
        console.log(`[GATEKEEPER] Successfully updated FNS: ${namespaceKey}`);
    } catch (err) { 
        console.error('[UPSERT ERROR]', err.message);
    }
}

// ── EXPRESS API ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// 🔥 FULLY SOVEREIGN HEALTH CHECK
app.get('/api/health', async (_req, res) => {
    const stats = readFromVault('BOM_Database\\System_State', 'stats') || {};
    const telemetry = getVaultTelemetry(); // Live SSD Read

    res.json({
        status: 'online',
        indexedNames: 'SYNCED (LOCAL VAULT)',
        totalMinted: telemetry.minted,
        totalRouted: telemetry.routed,
        lastScannedBlock: stats.lastScannedBlock || 'Genesis',
        aiEnabled: true,
    });
});

// 🔥 MILLISECOND LOCAL VAULT READ
app.get('/api/resolve/:namespace', async (req, res) => {
    const fnsData = readFromVault('BOM_Database\\FNS_Registry', req.params.namespace);
    
    if (fnsData) {
        return res.json(fnsData);
    } else {
        return res.status(404).json({ error: 'FNS not found in local vault.' });
    }
});

// 🔥 MOTHER AI CHAT ROUTE (Diagnostic Truth-Teller)
app.post('/api/chat', async (req, res) => {
    const { message, wallet } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: 'Missing message' });

    try {
        const telemetry = getVaultTelemetry();
        const cachedFnsIndex = `Total FNS Names Secured on SSD: ${telemetry.minted} | Total Routed: ${telemetry.routed}`;

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
2. Do not hallucinate data. If asked about the system state, refer to the Live System Data provided above.`;

        console.log(`[AI] Routing directive to local Qwen engine. Vault Telemetry: ${telemetry.minted} Minted...`);
        
        const fullPrompt = `${systemPrompt}\n\nUser: ${message.trim()}\nMOTHER AI:`;
        
        const response = await axios.post('http://127.0.0.1:11434/api/generate', {
            model: 'qwen2.5-coder:7b',
            prompt: fullPrompt,
            stream: false
        }, { timeout: 120000 });

        return res.json({ reply: response.data.response, source: 'local-qwen' });

    } catch (err) {
        const trueError = err.response && err.response.data 
            ? JSON.stringify(err.response.data) 
            : err.message;
            
        console.error('[AI] Chat error:', trueError);
        return res.json({ reply: `[SYSTEM ERROR]: Neural Link Severed. | REASON: ${trueError}` });
    }
});

// ── WEB3 WATCHER ───────────────────────────────
async function bootWatcher() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   BOM PROTOCOL — MOTHER AI v2.0  SWARM NODE (LOCAL)      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    let provider = null;
    let iface = new ethersPkg.Interface(CONTRACT_ABI);
    
    // Read the last scanned block from your F Drive memory
    const stats = readFromVault('BOM_Database\\System_State', 'stats') || {};
    let lastBlock = stats.lastScannedBlock || (GENESIS_BLOCK - 1);

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
                
                // Write block progress to local SSD instead of Firebase
                const currentStats = readFromVault('BOM_Database\\System_State', 'stats') || {};
                currentStats.lastScannedBlock = lastBlock;
                writeToVault('BOM_Database\\System_State', 'stats', currentStats);
            }
        } catch (err) { }
    }

    async function connect() {
        try {
            provider = new ethersPkg.JsonRpcProvider(RPC_URL);
            const currentBlock = await provider.getBlockNumber();
            console.log(`[INDEXER] Connected to Sepolia | Current Block: #${currentBlock}`);
            console.log(`[INDEXER] Vault Memory Active. Starting from block #${lastBlock + 1}...`);

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
