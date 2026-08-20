/**
 * Codex adapter.
 *
 * Rollout files interleave three record families: `session_meta` and
 * `turn_context` (cwd, model), `event_msg` (the user-visible turn stream), and
 * `response_item` (raw model output). Rows come from `event_msg` because that
 * is the deduplicated view; `response_item` repeats the same content.
 *
 * Codex is the richest format here: `token_count` carries cumulative usage and
 * the model context window, and `task_complete` carries per-turn duration and
 * time-to-first-token, so the whole metrics strip is recoverable.
 */

import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Adapter, Metrics, Row, Session, Trajectory } from '../types.js'
import { epochOf, flatten, jsonlFilesUnder, modifiedAt, numberAt, readJsonl, readJsonlPrefix, recordAt } from './util.js'

/** Codex home; rollouts live in two directories under it. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['CODEX_HOME']
  return configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.codex')
}

/** Directories holding rollout files. */
export function codexRoots(home: string = codexHome()): string[] {
  return [join(home, 'sessions'), join(home, 'archived_sessions')]
}

/** A folded rollout, plus the cwd its metadata records. */
interface FoldedRollout extends Trajectory {
  cwd?: string
}

/** Cwd recorded by session metadata near the start of each rollout. */
function cwdOf(path: string): string | undefined {
  for (const record of readJsonlPrefix(path)) {
    const payload = recordAt(record, 'payload')
    const cwd = payload?.['cwd']
    if (typeof cwd === 'string') return cwd
  }
  return undefined
}

/** Fold one rollout into rows and figures. */
function foldRollout(records: readonly Record<string, unknown>[]): FoldedRollout {
  const rows: Row[] = []
  let index = 0
  let cwd: string | undefined
  let model: string | undefined
  let turns = 0
  let steps = 0
  let llmMs = 0
  let ttftTotal = 0
  let ttftCount = 0
  let input: number | undefined
  let output: number | undefined
  let cached: number | undefined
  let contextWindow: number | undefined
  let contextTokens: number | undefined

  const push = (row: Omit<Row, 'index'>): void => {
    index += 1
    rows.push({ ...row, index })
  }

  for (const record of records) {
    const time = epochOf(record['timestamp']) ?? 0
    const payload = recordAt(record, 'payload')
    if (payload === undefined) continue
    const family = record['type']

    if (family === 'session_meta' || family === 'turn_context') {
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd'] as string
      if (typeof payload['model'] === 'string') model = payload['model'] as string
      continue
    }
    if (family !== 'event_msg') continue

    switch (payload['type']) {
      case 'user_message': {
        const text = flatten(payload['message'])
        if (text.length > 0) {
          turns += 1
          push({ kind: 'user', label: 'user', text, time })
        }
        break
      }
      case 'agent_message': {
        steps += 1
        const text = flatten(payload['message'])
        if (text.length > 0) push({ kind: 'assistant', label: 'assistant', text, time })
        break
      }
      case 'agent_reasoning': {
        const text = flatten(payload['text'])
        if (text.length > 0) push({ kind: 'context', label: 'reasoning', text, time })
        break
      }
      case 'exec_command_begin':
        push({ kind: 'tool', label: 'exec', text: flatten(payload['command']), time })
        break
      case 'mcp_tool_call_begin':
        push({ kind: 'tool', label: 'mcp', text: flatten(payload['invocation']), time })
        break
      case 'task_started':
        contextWindow = numberAt(payload, 'model_context_window') ?? contextWindow
        break
      case 'task_complete': {
        llmMs += numberAt(payload, 'duration_ms') ?? 0
        const ttft = numberAt(payload, 'time_to_first_token_ms')
        if (ttft !== undefined) {
          ttftTotal += ttft
          ttftCount += 1
        }
        break
      }
      case 'token_count': {
        const info = recordAt(payload, 'info')
        const totals = recordAt(info, 'total_token_usage')
        // Cumulative by construction, so the newest report replaces rather
        // than adds to the previous one.
        input = numberAt(totals, 'input_tokens') ?? input
        output = numberAt(totals, 'output_tokens') ?? output
        cached = numberAt(totals, 'cached_input_tokens') ?? cached
        contextTokens = numberAt(totals, 'total_tokens') ?? contextTokens
        contextWindow = numberAt(info, 'model_context_window') ?? contextWindow
        break
      }
      case 'error':
        push({ kind: 'error', label: 'error', text: flatten(payload['message']), time })
        break
      default:
        // Codex adds event kinds freely; unknown ones carry no row.
        break
    }
  }

  const prompt = (input ?? 0) + (cached ?? 0)
  const metrics: Metrics = {
    turns,
    steps,
    ...llmMs > 0 ? { llmMs } : {},
    ...ttftCount > 0 ? { ttftMs: ttftTotal / ttftCount } : {},
    ...output !== undefined && llmMs > 0 ? { tokensPerSecond: (output * 1000) / llmMs } : {},
    ...input === undefined ? {} : { inputTokens: input },
    ...output === undefined ? {} : { outputTokens: output },
    ...cached === undefined ? {} : { cacheReadTokens: cached },
    ...prompt > 0 && cached !== undefined ? { cacheHitRatio: cached / prompt } : {},
    ...contextWindow === undefined ? {} : { contextWindow },
    ...contextTokens === undefined ? {} : { contextTokens },
    ...model === undefined ? {} : { model },
  }
  return { metrics, rows, ...cwd === undefined ? {} : { cwd } }
}

/** Build the Codex adapter. */
export function codexAdapter(roots: readonly string[] = codexRoots()): Adapter {
  return {
    id: 'codex',
    root: roots[0] ?? codexHome(),
    discover: () => {
      const sessions: Session[] = []
      for (const root of roots) {
        // Current Codex stores live rollouts under sessions/YYYY/MM/DD;
        // archived sessions remain flat. Searching below both roots supports
        // both layouts without requiring an agent-version switch.
        for (const path of jsonlFilesUnder(root)) {
          const name = basename(path, '.jsonl')
          if (!name.startsWith('rollout-')) continue
          const time = modifiedAt(path)
          if (time === undefined) continue
          const cwd = cwdOf(path)
          sessions.push({
            harness: 'codex',
            id: name.replace(/^rollout-/, ''),
            path,
            modifiedAt: time,
            ...cwd === undefined ? {} : { cwd },
          })
        }
      }
      return sessions
    },
    read: (session: Session) => {
      const folded = foldRollout(readJsonl(session.path))
      if (folded.cwd !== undefined) session.cwd = folded.cwd
      return { metrics: folded.metrics, rows: folded.rows }
    },
  }
}
