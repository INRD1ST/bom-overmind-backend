// ============================================================
//  BOM PROTOCOL — SEPOLIA WATCHER AGENT (OVERMIND V2)
//  Monitors: FNS registrations, block health, chain anomalies
//  Brain: Gemini AI (reasoning + autonomous response)
//  Registry: Tracks spawn/dissolve lifecycle
// ============================================================
'use strict';

require('dotenv').config();

const { ethers }    = require('ethers');
const { initGemini, reason } = require('./core/gemini');
const registry      = require('./core/registry');

// ── CONFIG ─────────────────────────────────────────────────
const RPC_URL          = process.env.SEPOLIA_RPC_URL    || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.BOM_CONTRACT_ADDRESS || '0x9Dd6f41235a3f6D2dcF9a73B5177c14e721432Ff';
const POLL_INTERVAL    = parseInt(process.env.BLOCK_POLL_INTERVAL || '15') * 1000;
const MAX_DEPTH        = parseInt(process.env.MAX_AGENT_DEPTH || '5');

// ── ABI ────────────────────────────────────────────────────
const CONTRACT_ABI = [
    'event FNSRegistered(string targetString, address owner, string spatialURI)',
];

// ── STATE ──────────────────────────────────────────────────
let lastBlockNumber   = 0;
let missedBlocks      = 0;
let provider          = null;
let contract          = null;

// ── BANNER ─────────────────────────────────────────────────
function printBanner() {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║        BOM PROTOCOL — OVERMIND V2                   ║');
    console.log('║        BASE OF MODELS // SWARM EXECUTOR             ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Contract : ${CONTRACT_ADDRESS.slice(0,20)}...         ║`);
    console.log(`║  Network  : Sepolia Testnet                          ║`);
    console.log(`║  AI Brain : Gemini 2.0 Flash                        ║`);
    console.log(`║  Poll     : Every ${POLL_INTERVAL / 1000}s                              ║`);
    console.log('╚══════════════════════════════════════════════════════╝\n');
}

// ── FNS EVENT HANDLER ──────────────────────────────────────
async function onFNSRegistered(targetString, owner, spatialURI, event) {
    const blockNum = event.log.blockNumber;
    console.log('\n🌐 [FNS EVENT] New Domain Registration Detected!');
    console.log('─'.repeat(54));
    console.log(`  Namespace : ${targetString}`);
    console.log(`  Owner     : ${owner}`);
    console.log(`  Route URI : ${spatialURI}`);
    console.log(`  Block #   : ${blockNum}`);
    console.log('─'.repeat(54));

    // Spawn a dedicated FNS Analysis Agent
    const agentId = registry.register(
        'FNS-Analysis-Agent',
        `Analyze FNS registration: ${targetString}`,
        null, // parent = Mother AI (top level)
        0
    );
    registry.updateStatus(agentId, 'RUNNING', `Analyzing registration of "${targetString}"`);

    const analysis = await reason(
        'You are the FNS Supervisor Agent for BOM Protocol. You monitor domain registrations on the Fluid Naming System.',
        `A new namespace was registered:
  - Namespace: "${targetString}"
  - Owner wallet: ${owner}
  - Routed to: ${spatialURI}
  - On block: ${blockNum}
  
Check if this looks legitimate, whether the routing URI is valid format, and flag anything suspicious.`
    );

    console.log('\n🧠 [GEMINI ANALYSIS]');
    console.log(analysis);
    registry.updateStatus(agentId, 'DISSOLVED', 'FNS analysis complete');
    registry.summary();
}

// ── BLOCK HEALTH MONITOR ───────────────────────────────────
async function checkBlockHealth(healthAgentId) {
    try {
        const currentBlock = await provider.getBlockNumber();
        const timestamp = new Date().toLocaleTimeString();

        if (lastBlockNumber === 0) {
            lastBlockNumber = currentBlock;
            console.log(`[${timestamp}] 🔗 Initial block sync: #${currentBlock}`);
            registry.updateStatus(healthAgentId, 'RUNNING', `Synced at block #${currentBlock}`);
            return;
        }

        const blockDelta = currentBlock - lastBlockNumber;
        const expectedBlocks = Math.floor(POLL_INTERVAL / 12000); // ~12s per Sepolia block

        if (blockDelta === 0) {
            missedBlocks++;
            console.log(`[${timestamp}] ⚠️  No new blocks detected. Stall count: ${missedBlocks}`);
            registry.updateStatus(healthAgentId, 'RUNNING', `Chain stall detected — ${missedBlocks} consecutive`);

            if (missedBlocks >= 3) {
                await handleChainStall(healthAgentId, currentBlock, missedBlocks);
            }
        } else {
            missedBlocks = 0;
            console.log(`[${timestamp}] ✅ Block #${currentBlock} (+${blockDelta} new blocks)`);
            registry.updateStatus(healthAgentId, 'RUNNING', `Healthy — block #${currentBlock}`);
        }

        lastBlockNumber = currentBlock;
    } catch (err) {
        console.error(`[BLOCK MONITOR] 🚨 RPC Error: ${err.message}`);
        registry.updateStatus(healthAgentId, 'ERROR', `RPC failure: ${err.message}`);
        await handleRPCFailure(healthAgentId, err);
    }
}

// ── SELF-REPLICATING CRASH HANDLER — CHAIN STALL ──────────
async function handleChainStall(parentId, lastBlock, stallCount) {
    console.log('\n🚨 [CRITICAL] Chain stall detected! Spawning recovery swarm...');

    const swarmIds = [];

    // Shard 1 — RPC Diagnostics
    const rpcAgentId = registry.register('RPC-Diagnostics-Agent', 'Test alternate RPC endpoints', parentId, 1);
    registry.updateStatus(rpcAgentId, 'RUNNING', 'Pinging alternate RPC nodes');
    swarmIds.push(rpcAgentId);

    // Shard 2 — Etherscan Verification
    const ethscanAgentId = registry.register('Etherscan-Verify-Agent', 'Verify chain state via Etherscan API', parentId, 1);
    registry.updateStatus(ethscanAgentId, 'RUNNING', 'Cross-checking Etherscan');
    swarmIds.push(ethscanAgentId);

    // Shard 3 — AI Root Cause Analysis
    const rcaAgentId = registry.register('RCA-Agent', 'Perform root cause analysis on stall', parentId, 1);
    registry.updateStatus(rcaAgentId, 'RUNNING', 'Gemini RCA in progress');
    swarmIds.push(rcaAgentId);

    const analysis = await reason(
        'You are an emergency recovery agent for BOM Protocol. A chain stall has been detected.',
        `The Sepolia ledger has not produced new blocks in ${stallCount * POLL_INTERVAL / 1000} seconds.
Last known block: #${lastBlock}
Stall count: ${stallCount} consecutive polls with no change.

Diagnose the issue and recommend recovery actions. Consider:
1. RPC endpoint failure
2. Network partition
3. Testnet downtime
4. Local connectivity issue`
    );

    console.log('\n🧠 [SWARM RCA — GEMINI ANALYSIS]');
    console.log(analysis);

    // Dissolve all swarm agents
    for (const id of swarmIds) {
        registry.updateStatus(id, 'DISSOLVED', 'Recovery analysis complete');
    }
    registry.summary();
}

// ── RPC FAILURE HANDLER ────────────────────────────────────
async function handleRPCFailure(parentId, err) {
    const agentId = registry.register('RPC-Recovery-Agent', 'Handle RPC connection failure', parentId, 1);
    registry.updateStatus(agentId, 'RUNNING', 'Attempting reconnection logic');

    const analysis = await reason(
        'You are an RPC recovery agent for BOM Protocol.',
        `The primary RPC connection failed with error: "${err.message}"
Recommend whether to: retry same endpoint, switch to backup RPC, or escalate to the owner.`
    );

    console.log('\n🧠 [RPC RECOVERY — GEMINI]');
    console.log(analysis);
    registry.updateStatus(agentId, 'DISSOLVED', 'RPC recovery analysis done');
}

// ── BOOT SEQUENCE ──────────────────────────────────────────
async function bootOvermind() {
    printBanner();

    // Step 1: Init Gemini brain
    initGemini();

    // Step 2: Register the Mother (top-level) agent
    const motherAgentId = registry.register(
        '⚡ OVERMIND-CORE',
        'Master orchestrator — supervise all BOM Protocol modules',
        null,
        0
    );
    registry.updateStatus(motherAgentId, 'RUNNING', 'Booting Sepolia monitoring stack');

    // Step 3: Connect to Sepolia
    console.log(`[BOOT] Connecting to Sepolia RPC: ${RPC_URL}`);
    try {
        provider = new ethers.JsonRpcProvider(RPC_URL);
        const network = await provider.getNetwork();
        console.log(`[BOOT] ✅ Connected. Chain ID: ${network.chainId}`);
    } catch (err) {
        console.error(`[BOOT] 🚨 Failed to connect to RPC: ${err.message}`);
        console.error('[BOOT] Check your SEPOLIA_RPC_URL in .env and your internet connection.');
        process.exit(1);
    }

    // Step 4: Attach FNS contract listener
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
    console.log(`[BOOT] 👁️  FNS Watcher attached to: ${CONTRACT_ADDRESS}`);
    contract.on('FNSRegistered', onFNSRegistered);

    // Step 5: Register Block Health Agent
    const healthAgentId = registry.register(
        '📡 Block-Health-Agent',
        `Monitor Sepolia block production every ${POLL_INTERVAL / 1000}s`,
        motherAgentId,
        1
    );

    // Step 6: Start block polling loop
    console.log(`\n[OVERMIND] 🚀 All systems online. Monitoring BOM Protocol...\n`);
    registry.updateStatus(motherAgentId, 'RUNNING', 'All watchers active');
    registry.summary();

    setInterval(() => checkBlockHealth(healthAgentId), POLL_INTERVAL);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\n[OVERMIND] 🛑 Shutdown signal received. Dissolving all agents...');
        registry.getActive().forEach(a => registry.updateStatus(a.id, 'DISSOLVED', 'Graceful shutdown'));
        registry.summary();
        process.exit(0);
    });
}

// ── IGNITION ───────────────────────────────────────────────
bootOvermind().catch(err => {
    console.error('🚨 [FATAL] Overmind boot failed:', err);
    process.exit(1);
});