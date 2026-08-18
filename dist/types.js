/**
 * The harness-agnostic model every adapter normalizes into.
 *
 * Agents log wildly different things. The shared currency is therefore the
 * rendered result — rows and figures — not events. Each adapter reports what
 * its format actually records and leaves the rest undefined, so the renderer
 * can show an em dash instead of a fabricated zero: "this agent does not log
 * decode timing" and "this session decoded nothing" are different facts.
 */
/** Every agent id, in display order. */
export const HARNESS_IDS = ['claude', 'codex', 'deepseek', 'hermes'];
/** Short label rendered beside a row or session. */
export const HARNESS_LABEL = {
    claude: 'claude',
    codex: 'codex',
    deepseek: 'dsh',
    hermes: 'hermes',
};
/** Sum the defined figures of several sessions for the unified view. */
export function mergeMetrics(parts) {
    const defined = (pick) => parts.map(pick).filter((value) => value !== undefined);
    const sum = (pick) => {
        const values = defined(pick);
        return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
    };
    const mean = (pick) => {
        const values = defined(pick);
        return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0) / values.length;
    };
    const max = (pick) => {
        const values = defined(pick);
        return values.length === 0 ? undefined : Math.max(...values);
    };
    const inputTokens = sum(m => m.inputTokens);
    const cacheReadTokens = sum(m => m.cacheReadTokens);
    const prompt = (inputTokens ?? 0) + (cacheReadTokens ?? 0);
    return {
        turns: sum(m => m.turns),
        steps: sum(m => m.steps),
        llmMs: sum(m => m.llmMs),
        toolMs: sum(m => m.toolMs),
        // Means, not sums: without every session's step count this is the only
        // available figure, and it is what the strip claims to show.
        ttftMs: mean(m => m.ttftMs),
        tokensPerSecond: mean(m => m.tokensPerSecond),
        inputTokens,
        outputTokens: sum(m => m.outputTokens),
        cacheReadTokens,
        cacheHitRatio: prompt > 0 && cacheReadTokens !== undefined ? cacheReadTokens / prompt : undefined,
        // Capacity does not add across models; the largest in view is the only
        // honest single number.
        contextWindow: max(m => m.contextWindow),
        contextTokens: max(m => m.contextTokens),
    };
}
