/**
 * The harness-agnostic model every adapter normalizes into.
 *
 * Agents log wildly different things. The shared currency is therefore the
 * rendered result — rows and figures — not events. Each adapter reports what
 * its format actually records and leaves the rest undefined, so the renderer
 * can show an em dash instead of a fabricated zero: "this agent does not log
 * decode timing" and "this session decoded nothing" are different facts.
 */

/** Agents the monitor can read. */
export type HarnessId = 'claude' | 'codex' | 'deepseek' | 'hermes'

/** Every agent id, in display order. */
export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'codex', 'deepseek', 'hermes']

/** Short label rendered beside a row or session. */
export const HARNESS_LABEL: Record<HarnessId, string> = {
  claude: 'claude',
  codex: 'codex',
  deepseek: 'dsh',
  hermes: 'hermes',
}

/** Closed set of row kinds. */
export type RowKind = 'user' | 'context' | 'assistant' | 'tool' | 'error' | 'turn'

/** One rendered activity row. */
export interface Row {
  /** 1-based position, shown as `#N`. */
  index: number
  kind: RowKind
  /** Short left-hand label: a role name or a tool name. */
  label: string
  /** Single-line summary; the renderer truncates to the terminal width. */
  text: string
  /** Event time in epoch ms; the sort key that merges feeds across agents. */
  time: number
  /** Wall time in ms for rows the log pairs. */
  durationMs?: number
  /** Consecutive identical rows collapsed into this one; absent means 1. */
  repeat?: number
  /** Owning agent, stamped when rows from several sources share one feed. */
  harness?: string
}

/** One discovered session, before its body is read. */
export interface Session {
  harness: HarnessId
  /** Identifier as the owning agent records it. */
  id: string
  /** Absolute path of the artifact holding the trajectory. */
  path: string
  /** Working directory the session ran in, when the format records one. */
  cwd?: string
  /** Human title, when the format records one. */
  title?: string
  /** Last write time, used for ordering. */
  modifiedAt: number
}

/**
 * Figures shown in the metrics strip. Every field is optional: an agent that
 * does not record a quantity reports `undefined`, never `0`.
 */
export interface Metrics {
  turns?: number | undefined
  steps?: number | undefined
  /** Summed model wall time, ms. */
  llmMs?: number | undefined
  /** Summed tool wall time, ms. */
  toolMs?: number | undefined
  /** Mean first-token latency, ms. */
  ttftMs?: number | undefined
  /** Decode throughput, output tokens per second. */
  tokensPerSecond?: number | undefined
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  cacheReadTokens?: number | undefined
  /** Cache-read share of prompt-side tokens, 0..1. */
  cacheHitRatio?: number | undefined
  contextWindow?: number | undefined
  /** Best estimate of currently occupied context. */
  contextTokens?: number | undefined
  /** Context figures came from more than one session and cannot form one ratio. */
  contextMixed?: boolean | undefined
  /** Cache-write tokens, kept separate because they are priced differently. */
  cacheWriteTokens?: number | undefined
  /** Model id the session last used, as the agent recorded it. */
  model?: string | undefined
  /** Cost in USD, absent when the model has no configured price. */
  costUsd?: number | undefined
}

/** A session's normalized trajectory. */
export interface Trajectory {
  metrics: Metrics
  rows: Row[]
}

/**
 * One agent's reader. Discovery must stay cheap — it runs on every poll for
 * every adapter — so it reads directory metadata and never session bodies.
 */
export interface Adapter {
  id: HarnessId
  /** Where this adapter looks, shown in `--help` and the empty state. */
  root: string
  /** Locate this agent's sessions; the caller sorts. */
  discover(): Session[]
  /** Read and normalize one session. */
  read(session: Session): Trajectory
}

/** Sum the defined figures of several sessions for the unified view. */
export function mergeMetrics(parts: readonly Metrics[]): Metrics {
  const defined = (pick: (m: Metrics) => number | undefined): number[] =>
    parts.map(pick).filter((value): value is number => value !== undefined)
  const sum = (pick: (m: Metrics) => number | undefined): number | undefined => {
    const values = defined(pick)
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0)
  }
  const mean = (pick: (m: Metrics) => number | undefined): number | undefined => {
    const values = defined(pick)
    return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0) / values.length
  }
  const inputTokens = sum(m => m.inputTokens)
  const cacheReadTokens = sum(m => m.cacheReadTokens)
  const prompt = (inputTokens ?? 0) + (cacheReadTokens ?? 0)

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
      const contexts = parts.filter((metrics): metrics is Metrics & {
        contextWindow: number
        contextTokens: number
      } => metrics.contextWindow !== undefined && metrics.contextTokens !== undefined)
      if (contexts.length === 1) {
        const context = contexts[0]!
        return { contextWindow: context.contextWindow, contextTokens: context.contextTokens }
      }
      return contexts.length > 1 ? { contextMixed: true } : {}
    })(),
    cacheWriteTokens: sum(m => m.cacheWriteTokens),
    // Several models in one view have no single id; cost still adds up.
    model: (() => {
      const ids = [...new Set(parts.map(m => m.model).filter((v): v is string => v !== undefined))]
      return ids.length === 1 ? ids[0] : ids.length === 0 ? undefined : `${String(ids.length)} models`
    })(),
    costUsd: sum(m => m.costUsd),
  }
}
