/** Adapter registry and the cross-agent reads the renderer consumes. */
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { deepseekAdapter } from './adapters/deepseek.js';
import { hermesAdapter } from './adapters/hermes.js';
import { contextWindowFor, costOf } from './models.js';
import { HARNESS_LABEL, mergeMetrics } from './types.js';
/** Every adapter, in display order. */
export function allAdapters() {
    return [claudeAdapter(), codexAdapter(), deepseekAdapter(), hermesAdapter()];
}
/** Discover every session across every adapter, newest write first. */
export function discoverAll(adapters) {
    const found = [];
    for (const adapter of adapters) {
        for (const session of adapter.discover())
            found.push({ session, adapter });
    }
    return found.sort((left, right) => right.session.modifiedAt - left.session.modifiedAt);
}
/**
 * Sessions to include in the unified feed.
 *
 * The feed promises to show several agent harnesses. Selecting the first N
 * global mtimes breaks that promise whenever a background agent writes more
 * frequently than the rest, so every active harness receives one slot before
 * the remaining slots fill by recency.
 */
export function selectUnifiedSessions(entries, limit) {
    if (limit <= 0)
        return [];
    const selected = [];
    const seen = new Set();
    for (const entry of entries) {
        if (selected.length >= limit)
            break;
        if (seen.has(entry.session.harness))
            continue;
        selected.push(entry);
        seen.add(entry.session.harness);
    }
    if (selected.length >= limit)
        return selected;
    const chosen = new Set(selected.map(entry => entry.session.path));
    for (const entry of entries) {
        if (selected.length >= limit)
            break;
        if (chosen.has(entry.session.path))
            continue;
        selected.push(entry);
    }
    return selected;
}
/**
 * Collapse runs of identical rows.
 *
 * A stuck agent retrying, or a loop re-reading one file, otherwise fills the
 * whole screen with the same line and hides everything before it.
 */
export function collapseRepeats(rows) {
    const out = [];
    for (const row of rows) {
        const previous = out[out.length - 1];
        if (previous !== undefined
            && previous.kind === row.kind
            && previous.label === row.label
            && previous.text === row.text
            && previous.harness === row.harness) {
            previous.repeat = (previous.repeat ?? 1) + 1;
            continue;
        }
        out.push({ ...row });
    }
    return out;
}
/**
 * Attach cost and, for agents that do not log one, a configured context window.
 *
 * A window the observed occupancy exceeds is discarded rather than clamped: a
 * bar pinned at 100% because the configured capacity is wrong reads exactly
 * like a context about to overflow, which is the one thing this gauge exists
 * to warn about.
 */
function enrich(metrics, pricing) {
    // A session-wide token total cannot be priced at the last model's rate when
    // it switched models. Until every source provides a per-request model usage
    // split, an absent cost is more truthful than a plausible wrong dollar value.
    const cost = metrics.models !== undefined && metrics.models.length > 1
        ? undefined
        : costOf(metrics.model, metrics, pricing);
    const configured = metrics.contextWindow ?? contextWindowFor(metrics.model, pricing);
    const occupied = metrics.contextTokens;
    const window = configured !== undefined && occupied !== undefined && occupied > configured
        ? undefined
        : configured;
    return {
        ...metrics,
        ...cost === undefined ? {} : { costUsd: cost },
        ...window === undefined ? { contextWindow: undefined } : { contextWindow: window },
    };
}
/** Read one session, tagging every row with its agent. */
export function readTagged(entry, options) {
    const trajectory = entry.adapter.read(entry.session);
    const harness = HARNESS_LABEL[entry.session.harness];
    const tagged = trajectory.rows
        .filter(row => options.verbose || row.kind !== 'context')
        .map(row => ({ ...row, harness }));
    return { metrics: enrich(trajectory.metrics, options.pricing), rows: collapseRepeats(tagged) };
}
/**
 * Merge several sessions into one time-ordered feed with summed figures.
 * Rows are re-indexed after the merge so `#N` counts the unified feed rather
 * than repeating each source's own numbering.
 */
export function mergeSessions(entries, limit, options) {
    if (entries.length === 0)
        return { metrics: {}, rows: [] };
    const parts = [];
    const rows = [];
    for (const entry of entries) {
        const trajectory = readTagged(entry, options);
        parts.push(trajectory.metrics);
        rows.push(...trajectory.rows);
    }
    rows.sort((left, right) => left.time - right.time);
    return {
        metrics: mergeMetrics(parts),
        // Collapse again after interleaving: identical rows from one agent can be
        // separated by another agent's rows before the merge sorts them together.
        rows: collapseRepeats(rows).slice(-limit).map((row, position) => ({ ...row, index: position + 1 })),
    };
}
/** Whether a session's recorded cwd sits at or under `root`. */
export function underCwd(sessionCwd, root) {
    if (sessionCwd === undefined)
        return false;
    return sessionCwd === root || sessionCwd.startsWith(`${root}/`);
}
/** Sessions per agent, for the header summary. */
export function sourceCounts(sessions) {
    const counts = new Map();
    for (const session of sessions)
        counts.set(session.harness, (counts.get(session.harness) ?? 0) + 1);
    return [...counts];
}
