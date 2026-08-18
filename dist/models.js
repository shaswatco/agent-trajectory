/**
 * Model identity: context capacity and price.
 *
 * Two very different kinds of fact live here, and they are treated
 * differently on purpose.
 *
 * Context windows are NOT guessed from the model id. Agents that know their
 * own capacity report it — Codex and DeepSeek Harness both write it into the
 * log — and for agents that do not, notably Claude Code, a guessed number is
 * worse than none: an under-guess renders a full red bar on a half-empty
 * context. Declare those in the config file instead.
 *
 * Prices change without notice and vary by contract, so nothing is guessed:
 * costs come from a user-owned file, plus the one price this tool can know for
 * itself, which is that a free-tier model costs nothing. An unpriced model
 * reports `undefined` and renders as an em dash, never as `$0.00`.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Default pricing file location. */
export function pricingPath(env = process.env) {
    const configured = env['AGENT_TRAJECTORY_PRICING'];
    if (configured !== undefined && configured.trim().length > 0)
        return configured;
    const base = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
    return join(base, 'agent-trajectory', 'pricing.json');
}
/**
 * Strip provider prefixes and deployment suffixes so `z-ai/glm-4.5-air:free`,
 * `glm-4.5-air` and `glm-4.5-air:cloud` resolve to the same entry.
 */
export function normalizeModelId(id) {
    const withoutProvider = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
    return withoutProvider.split(':')[0].trim().toLowerCase();
}
/** Whether an id advertises a free tier, which is a price this tool can know. */
export function isFreeTier(id) {
    const lower = id.toLowerCase();
    return lower.endsWith(':free') || lower.endsWith('-free') || lower.includes('-free-');
}
/**
 * Ids that name no real model. Claude Code writes `<synthetic>` for records it
 * generated itself, which must not be mistaken for an unpriced model.
 */
export function isRealModel(id) {
    return id.length > 0 && !id.startsWith('<');
}
/** Coerce one JSON entry, ignoring fields that are not finite numbers. */
function toPrice(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    const num = (key) => typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : undefined;
    const price = {
        contextWindow: num('contextWindow'),
        input: num('input'),
        output: num('output'),
        cacheRead: num('cacheRead'),
        cacheWrite: num('cacheWrite'),
    };
    return price.input === undefined && price.output === undefined && price.contextWindow === undefined
        ? undefined
        : price;
}
/**
 * Load the user's pricing file.
 *
 * A missing file is the normal state, not an error: the tool is useful without
 * prices and says so by rendering an em dash. A malformed file is also
 * tolerated, because a monitor that refuses to start over a stray comma is
 * worse than one that shows no costs.
 * @param path - file location; defaults to the documented config path.
 * @returns the table, empty when absent or unreadable.
 */
export function loadPricing(path = pricingPath()) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        // No pricing configured: costs render as em dashes.
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        // Malformed file: better to run without costs than to refuse to start.
        return {};
    }
    if (typeof parsed !== 'object' || parsed === null)
        return {};
    const table = {};
    for (const [id, value] of Object.entries(parsed)) {
        if (id.startsWith('//') || id.startsWith('$'))
            continue;
        const price = toPrice(value);
        if (price !== undefined)
            table[normalizeModelId(id)] = price;
    }
    return table;
}
/**
 * Cost in USD for one model's usage.
 * @param id - model id as recorded, or undefined when unknown.
 * @param usage - token counts.
 * @param pricing - the loaded table.
 * @returns the cost, or undefined when the model has no price.
 */
export function costOf(id, usage, pricing) {
    if (id === undefined || !isRealModel(id))
        return undefined;
    // A free tier is the one price knowable without configuration.
    if (isFreeTier(id))
        return 0;
    const price = pricing[normalizeModelId(id)];
    if (price === undefined)
        return undefined;
    const per = (tokens, rate) => tokens === undefined || rate === undefined ? 0 : (tokens / 1_000_000) * rate;
    return per(usage.inputTokens, price.input)
        + per(usage.outputTokens, price.output)
        + per(usage.cacheReadTokens, price.cacheRead ?? price.input)
        + per(usage.cacheWriteTokens, price.cacheWrite ?? price.input);
}
/**
 * Configured capacity for a model id.
 * @param id - the model id as the agent recorded it.
 * @param pricing - the loaded table.
 * @returns the window in tokens, or undefined when unconfigured.
 */
export function contextWindowFor(id, pricing) {
    if (id === undefined || !isRealModel(id))
        return undefined;
    return pricing[normalizeModelId(id)]?.contextWindow;
}
