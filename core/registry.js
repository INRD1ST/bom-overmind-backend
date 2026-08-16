// ============================================================
//  BOM PROTOCOL — AGENT REGISTRY
//  Tracks all active Overmind agents: status, parent, task.
// ============================================================
'use strict';

class AgentRegistry {
    constructor() {
        this.agents = new Map();
        this.counter = 0;
    }

    /**
     * Register a new agent.
     * @param {string} name - Agent name (e.g. 'FNS-Watcher')
     * @param {string} task - What this agent is doing
     * @param {string|null} parentId - ID of spawning agent (null = Mother AI)
     * @param {number} depth - Nesting depth (0 = top level)
     */
    register(name, task, parentId = null, depth = 0) {
        const id = `AGT-${String(++this.counter).padStart(4, '0')}`;
        const agent = {
            id,
            name,
            task,
            parentId,
            depth,
            status: 'SPAWNED',
            spawnedAt: new Date().toISOString(),
            dissolvedAt: null,
            childIds: [],
            lastAction: null,
        };

        this.agents.set(id, agent);

        if (parentId && this.agents.has(parentId)) {
            this.agents.get(parentId).childIds.push(id);
        }

        console.log(`[REGISTRY] ✅ Agent registered: ${id} | ${name} | Depth: ${depth}`);
        return id;
    }

    updateStatus(id, status, lastAction = null) {
        const agent = this.agents.get(id);
        if (!agent) return;
        agent.status = status;
        if (lastAction) agent.lastAction = lastAction;
        if (status === 'DISSOLVED') {
            agent.dissolvedAt = new Date().toISOString();
            console.log(`[REGISTRY] 💨 Agent dissolved: ${id} | ${agent.name}`);
        }
    }

    getActive() {
        return [...this.agents.values()].filter(a => a.status !== 'DISSOLVED');
    }

    printTree(parentId = null, indent = '') {
        const children = [...this.agents.values()].filter(a => a.parentId === parentId);
        for (const agent of children) {
            const icon = agent.status === 'RUNNING' ? '🤖' :
                         agent.status === 'DISSOLVED' ? '💨' :
                         agent.status === 'ERROR' ? '🚨' : '⏳';
            console.log(`${indent}${icon} [${agent.id}] ${agent.name} — ${agent.status}`);
            if (agent.lastAction) console.log(`${indent}    └─ ${agent.lastAction}`);
            this.printTree(agent.id, indent + '    ');
        }
    }

    summary() {
        const active = this.getActive();
        console.log(`\n[REGISTRY] 📊 Active Agents: ${active.length} | Total spawned: ${this.counter}`);
        this.printTree();
        console.log('');
    }
}

module.exports = new AgentRegistry(); // Singleton
