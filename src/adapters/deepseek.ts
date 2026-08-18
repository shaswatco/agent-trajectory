/**
 * DeepSeek Harness adapter.
 *
 * Sessions are append-only JSONL compressed as concatenated Zstandard frames,
 * one per durable batch, so a writer mid-append always leaves a torn tail that
 * decoding skips until it completes.
 *
 * The event log is a typed lifecycle stream, which makes this the only format
 * here that reports step boundaries: `step/start` → first delta chunk gives
 * TTFT, first chunk → `assistant/message` gives decode time, and `tool/call` →
 * `tool/result` pairs give tool wall time. The fold below mirrors the
 * harness's own `sessionStats` and `tokenUsage` projections.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, Metrics, Row, Session, Trajectory } from '../types.js'
import { decodeZstdFrames, modifiedAt, numberAt, parseJsonl, previewArguments, readText, recordAt, safeReaddir } from './util.js'

/** Default sessions root. */
export function deepseekRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['DSH_HOME']
  const base = home !== undefined && home.trim().length > 0 ? home : join(homedir(), '.dsh')
  return join(base, 'sessions')
}

/** Decode a workspace directory name back into a path. */
function decodeWorkspace(encoded: string): string {
  return `/${encoded.replace(/^-+|-+$/g, '').replaceAll('-', '/')}`
}

/** Read a log artifact, decompressing when it is Zstandard-framed. */
function readLog(path: string): Record<string, unknown>[] {
  if (!path.endsWith('.zstd')) {
    const text = readText(path)
    return text === undefined ? [] : parseJsonl(text)
  }
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch {
    // Deleted or unreadable between discovery and read.
    return []
  }
  return parseJsonl(decodeZstdFrames(buffer))
}

/** Collapse an event's message content into one line. */
function contentText(message: unknown): string {
  const blocks = recordAt(message as Record<string, unknown> | undefined, 'content') ?? message
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as Record<string, unknown>
    if (item['type'] === 'text' && typeof item['text'] === 'string') parts.push(item['text'] as string)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** Prompt-side tokens of one usage record. */
function promptOf(usage: Record<string, unknown>): number {
  return (numberAt(usage, 'inputTokens') ?? 0)
    + (numberAt(usage, 'cacheReadTokens') ?? 0)
    + (numberAt(usage, 'cacheWriteTokens') ?? 0)
}

/** Fold one event log into rows and figures. */
function foldLog(records: readonly Record<string, unknown>[]): Trajectory {
  const rows: Row[] = []
  let index = 0
  const openCalls = new Map<string, { row: Row; time: number }>()

  let turns = 0
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftTotal = 0
  let ttftCount = 0
  let decodeMs = 0
  let decodeTokens = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let sawUsage = false
  let contextWindow: number | undefined
  let contextTokens: number | undefined
  let model: string | undefined

  let stepStart: number | undefined
  let firstToken: number | undefined

  const push = (row: Omit<Row, 'index'>): Row => {
    index += 1
    const complete: Row = { ...row, index }
    rows.push(complete)
    return complete
  }

  for (const record of records) {
    const time = numberAt(record, 'time') ?? 0
    const data = recordAt(record, 'data')
    switch (record['type']) {
      case 'turn/start':
        turns += 1
        break
      case 'turn/end': {
        const reason = recordAt(data, 'reason')
        const kind = reason?.['kind']
        if (kind !== undefined && kind !== 'completed') {
          const failure = recordAt(reason, 'error')
          const detail = failure === undefined
            ? String(kind)
            : `${String(failure['code'] ?? 'ERROR')}: ${String(failure['message'] ?? '')}`
          push({ kind: 'error', label: 'turn', text: detail, time })
        }
        break
      }
      case 'step/start':
        stepStart = time
        firstToken = undefined
        break
      case 'step/end':
        steps += 1
        break
      case 'user/message': {
        const source = recordAt(data, 'source')
        const producer = typeof source?.['kind'] === 'string' ? source['kind'] as string : 'user'
        const text = contentText(data)
        if (text.length === 0) break
        push(producer === 'user'
          ? { kind: 'user', label: 'user', text, time }
          : { kind: 'context', label: producer, text, time })
        break
      }
      case 'assistant/chunk': {
        const chunk = recordAt(data, 'chunk')
        if (chunk?.['type'] === 'usage') {
          const usage = recordAt(chunk, 'usage')
          if (usage !== undefined) contextTokens = promptOf(usage)
        } else if (firstToken === undefined) {
          firstToken = time
        }
        break
      }
      case 'assistant/message': {
        if (stepStart !== undefined) {
          llmMs += time - stepStart
          if (firstToken !== undefined) {
            ttftTotal += firstToken - stepStart
            ttftCount += 1
          }
        }
        const usage = recordAt(data, 'usage')
        if (usage !== undefined) {
          sawUsage = true
          input += numberAt(usage, 'inputTokens') ?? 0
          output += numberAt(usage, 'outputTokens') ?? 0
          cacheRead += numberAt(usage, 'cacheReadTokens') ?? 0
          cacheWrite += numberAt(usage, 'cacheWriteTokens') ?? 0
          contextTokens = promptOf(usage)
          const produced = numberAt(usage, 'outputTokens')
          if (firstToken !== undefined && produced !== undefined) {
            decodeMs += time - firstToken
            decodeTokens += produced
          }
        }
        const text = contentText(recordAt(data, 'message'))
        push({ kind: 'assistant', label: 'assistant', text: text.length > 0 ? text : '(reasoning only)', time })
        stepStart = undefined
        break
      }
      case 'tool/call': {
        const callId = String(data?.['callId'] ?? '')
        const row = push({
          kind: 'tool',
          label: typeof data?.['name'] === 'string' ? data['name'] as string : 'tool',
          text: previewArguments(data?.['arguments']),
          time,
        })
        openCalls.set(callId, { row, time })
        break
      }
      case 'tool/result': {
        const message = recordAt(data, 'message')
        const blocks = message?.['content']
        const first = Array.isArray(blocks) && typeof blocks[0] === 'object' && blocks[0] !== null
          ? blocks[0] as Record<string, unknown>
          : undefined
        const callId = String(first?.['toolCallId'] ?? '')
        const open = openCalls.get(callId)
        if (open !== undefined) {
          open.row.durationMs = time - open.time
          toolMs += time - open.time
          openCalls.delete(callId)
        }
        const failure = recordAt(data, 'error')
        if (failure !== undefined) {
          push({ kind: 'error', label: String(failure['code'] ?? 'error'), text: String(failure['name'] ?? ''), time })
        }
        break
      }
      case 'request/context':
        contextWindow = numberAt(data, 'contextWindow') ?? contextWindow
        break
      case 'request/header': {
        const selection = recordAt(data, 'model') ?? data
        const named = selection?.['model'] ?? selection?.['id']
        if (typeof named === 'string') model = named
        break
      }
      default:
        // Chunks, policy records and boundary markers carry no row.
        break
    }
  }

  const prompt = input + cacheRead + cacheWrite
  const metrics: Metrics = {
    turns,
    steps,
    ...llmMs > 0 ? { llmMs } : {},
    ...toolMs > 0 ? { toolMs } : {},
    ...ttftCount > 0 ? { ttftMs: ttftTotal / ttftCount } : {},
    ...decodeMs > 0 ? { tokensPerSecond: (decodeTokens * 1000) / decodeMs } : {},
    ...sawUsage ? { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead } : {},
    ...prompt > 0 ? { cacheHitRatio: cacheRead / prompt } : {},
    ...contextWindow === undefined ? {} : { contextWindow },
    ...contextTokens === undefined ? {} : { contextTokens },
    ...sawUsage ? { cacheWriteTokens: cacheWrite } : {},
    ...model === undefined ? {} : { model },
  }
  return { metrics, rows }
}

/** Build the DeepSeek Harness adapter. */
export function deepseekAdapter(root: string = deepseekRoot()): Adapter {
  return {
    id: 'deepseek',
    root,
    discover: () => {
      const sessions: Session[] = []
      for (const workspace of safeReaddir(root)) {
        const cwd = decodeWorkspace(workspace)
        for (const id of safeReaddir(join(root, workspace))) {
          if (!id.startsWith('session-')) continue
          for (const suffix of ['session.jsonl.zstd', 'session.jsonl']) {
            const path = join(root, workspace, id, suffix)
            const time = modifiedAt(path)
            if (time === undefined) continue
            sessions.push({ harness: 'deepseek', id, path, cwd, modifiedAt: time })
            break
          }
        }
      }
      return sessions
    },
    read: (session: Session) => {
      const records = readLog(session.path)
      const [header, ...events] = records
      if (typeof header?.['cwd'] === 'string') session.cwd = header['cwd'] as string
      if (typeof header?.['title'] === 'string') session.title = header['title'] as string
      return foldLog(events)
    },
  }
}
