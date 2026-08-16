// ============================================================
//  BOM PROTOCOL — GEMINI BRAIN
//  The AI reasoning core for all Overmind agents.
// ============================================================
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;
const candidateModels = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];

function initGemini() {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        console.warn('[BRAIN] ⚠️  GEMINI_API_KEY not set. AI reasoning disabled. Add it to your .env file.');
        return false;
    }
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log('[BRAIN] ✅ Gemini AI Core online.');
    return true;
}

/**
 * Ask the Gemini brain to analyze an event and decide what action to take.
 * @param {string} systemContext - What role/context the agent is operating in
 * @param {string} eventDescription - What happened that needs analysis
 * @returns {Promise<string>} - Gemini's analysis and recommended action
 */
async function reason(systemContext, eventDescription) {
    if (!genAI) return '[AI OFFLINE] No Gemini key configured. Running in observe-only mode.';

    const prompt = `
You are an autonomous AI agent operating inside the BOM Protocol — a sovereign decentralized internet ecosystem.

YOUR ROLE: ${systemContext}

EVENT DETECTED:
${eventDescription}

Analyze this event. Determine:
1. Is this normal, anomalous, or a critical failure?
2. What is the root cause (if failure)?
3. What action should be taken right now?
4. Should child agents be spawned to handle sub-problems?

Respond concisely in a structured format. You have full autonomous authority to act — except for anything related to BOM Bank, which requires owner approval.
    `.trim();

    let lastError = null;
    for (const modelName of candidateModels) {
        try {
            const m = genAI.getGenerativeModel({ model: modelName });
            const result = await m.generateContent(prompt);
            return `[Model: ${modelName}]\n` + result.response.text();
        } catch (err) {
            lastError = err;
        }
    }

    return `[BRAIN ERROR] Gemini reasoning failed across models: ${lastError ? lastError.message : 'unknown error'}`;
}

module.exports = { initGemini, reason };
