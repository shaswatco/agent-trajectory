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
        // A context window and its occupancy are a pair from one request. Taking
        // their maxima independently can combine different sessions and turn an
        // almost-full 100K context plus an unrelated 1M window into a harmless
        // looking 10% gauge. Preserve one pair only; otherwise say it is mixed.
        ...(() => {
            const contexts = parts.filter((metrics) => metrics.contextWindow !== undefined && metrics.contextTokens !== undefined);
            if (contexts.length === 1) {
                const context = contexts[0];
                return { contextWindow: context.contextWindow, contextTokens: context.contextTokens };
            }
            return contexts.length > 1 ? { contextMixed: true } : {};
        })(),
        cacheWriteTokens: sum(m => m.cacheWriteTokens),
        // Several models in one view have no single id; cost still adds up.
        model: (() => {
            const ids = [...new Set(parts.map(m => m.model).filter((v) => v !== undefined))];
            return ids.length === 1 ? ids[0] : ids.length === 0 ? undefined : `${String(ids.length)} models`;
        })(),
        costUsd: sum(m => m.costUsd),
    };
}
