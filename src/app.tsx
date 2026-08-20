/**
 * Ink rendering: metrics strip, context gauge, activity feed, session picker.
 *
 * Every pane is a pure function of the polled snapshot, so the renderer holds
 * no derived state and a redraw can never disagree with the fold. A figure an
 * agent does not record renders as an em dash, never as zero.
 */

import { Box, Text, useApp, useInput } from 'ink'
import React from 'react'
import { HARNESS_LABEL } from './types.js'
import type { Metrics, Row, RowKind, Session } from './types.js'

/** One polled view. */
export interface Snapshot {
  /** Sessions discovered on the last poll, newest first. */
  sessions: Session[]
  /** Path of the pinned session, or undefined in the unified view. */
  pinned?: string
  /** Title of the pinned session. */
  title?: string
  /** Whether the feed merges several sessions. */
  unified: boolean
  metrics: Metrics
  rows: Row[]
  /** Message shown instead of the feed when the last poll produced nothing. */
  error?: string
}

/** Props of the application. */
export interface AppProps {
  snapshot: Snapshot
  /** Increments once per completed poll; drives the liveness indicator. */
  tick: number
  /** Rows the feed may occupy, from the current terminal height. */
  feedRows: number
  /** Report wheel events for scrolling; disabling restores drag-to-select. */
  mouse: boolean
  onUnify: () => void
  onSelect: (path: string) => void
}

const KIND_COLOR: Record<RowKind, string> = {
  user: 'cyan',
  context: 'gray',
  assistant: 'white',
  tool: 'yellow',
  error: 'red',
  turn: 'gray',
}

const KIND_GLYPH: Record<RowKind, string> = {
  user: '›',
  context: '⋯',
  assistant: '✎',
  tool: '⚙',
  error: '✖',
  turn: '─',
}

const HARNESS_COLOR: Record<string, string> = {
  claude: 'magenta',
  codex: 'green',
  dsh: 'blue',
  hermes: 'cyan',
}

/** Render a token count compactly, or an em dash when unknown. */
function tokens(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/** Render milliseconds as seconds, or an em dash when unknown. */
function seconds(ms: number | undefined): string {
  return ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`
}

/** Render a count, or an em dash when unknown. */
function count(value: number | undefined): string {
  return value === undefined ? '—' : String(value)
}

/** Render a USD cost, or an em dash when the model has no configured price. */
function money(value: number | undefined): string {
  if (value === undefined) return '$—'
  if (value === 0) return 'free'
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

/** Age of an event relative to now, in the narrowest useful unit. */
function ago(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))}d`
}

/** Frames of the liveness indicator, advanced once per poll. */
const HEARTBEAT = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Metrics strip. */
function MetricsStrip({ metrics }: { metrics: Metrics }): React.ReactElement {
  const cells = [
    `turns ${count(metrics.turns)}`,
    `steps ${count(metrics.steps)}`,
    `LLM ${seconds(metrics.llmMs)}`,
    `TTFT ${seconds(metrics.ttftMs)}`,
    metrics.tokensPerSecond === undefined ? '— tok/s' : `${metrics.tokensPerSecond.toFixed(1)} tok/s`,
    metrics.cacheHitRatio === undefined ? 'cache —' : `cache ${(metrics.cacheHitRatio * 100).toFixed(0)}%`,
    `in ${tokens(metrics.inputTokens)}`,
    `out ${tokens(metrics.outputTokens)}`,
    money(metrics.costUsd),
  ]
  return <Text color="gray" wrap="truncate">{cells.join(' · ')}</Text>
}

/** Context gauge. */
function ContextGauge({ metrics, width }: { metrics: Metrics; width: number }): React.ReactElement {
  const { contextTokens, contextWindow } = metrics
  if (metrics.contextMixed === true) {
    return <Text color="gray">ctx — · mixed sessions; select one for a context gauge</Text>
  }
  if (contextTokens === undefined || contextWindow === undefined) {
    return (
      <Text color="gray" wrap="truncate">
        {`ctx — · ${tokens(contextTokens)} occupied, no window reported`}
      </Text>
    )
  }
  const ratio = Math.min(1, contextTokens / contextWindow)
  const barWidth = Math.max(10, Math.min(40, width - 34))
  const filled = Math.round(ratio * barWidth)
  const color = ratio > 0.9 ? 'red' : ratio > 0.7 ? 'yellow' : 'green'
  return (
    <Text wrap="truncate">
      <Text color="gray">ctx </Text>
      <Text color={color}>{'█'.repeat(filled)}</Text>
      <Text color="gray">{'░'.repeat(barWidth - filled)}</Text>
      <Text color="gray">{` ${(ratio * 100).toFixed(0)}% · ${tokens(contextTokens)}/${tokens(contextWindow)}`}</Text>
    </Text>
  )
}

/** One activity row, held to a single terminal line. */
function FeedLine({ row, width, showHarness, now }: {
  row: Row
  width: number
  showHarness: boolean
  now: number
}): React.ReactElement {
  const duration = row.durationMs === undefined ? '' : ` ${seconds(row.durationMs)}`
  const repeat = row.repeat === undefined ? '' : ` ×${String(row.repeat)}`
  const tag = showHarness && row.harness !== undefined ? row.harness.padEnd(7).slice(0, 7) : ''
  const age = row.time > 0 ? ago(row.time, now).padStart(4) : '   —'
  const budget = Math.max(8, width - 27 - tag.length - duration.length - repeat.length)
  const text = row.text.length > budget ? `${row.text.slice(0, budget - 1)}…` : row.text
  return (
    <Text wrap="truncate">
      <Text color="gray">{`${age} `}</Text>
      {tag.length > 0 ? <Text color={HARNESS_COLOR[row.harness ?? ''] ?? 'gray'}>{tag}</Text> : null}
      <Text color={KIND_COLOR[row.kind]}>
        {`${KIND_GLYPH[row.kind]} ${row.label.padEnd(12).slice(0, 12)} ${text}`}
      </Text>
      <Text color="yellow">{repeat}</Text>
      <Text color="gray">{duration}</Text>
    </Text>
  )
}

/** Session picker overlay. */
function SessionPicker({ sessions, pinned }: {
  sessions: readonly Session[]
  pinned: string | undefined
}): React.ReactElement {
  const now = Date.now()
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="gray">sessions, newest first — digit selects · u unified · s closes</Text>
      {sessions.slice(0, 10).map((entry, position) => {
        const minutes = Math.round((now - entry.modifiedAt) / 60000)
        const age = minutes === 0
          ? 'now'
          : minutes < 60 ? `${String(minutes)}m` : `${String(Math.round(minutes / 60))}h`
        const marker = entry.path === pinned ? '●' : ' '
        const where = (entry.title ?? entry.cwd ?? '').slice(-38)
        return (
          <Text key={entry.path} wrap="truncate">
            <Text color="gray">{`${marker} ${String(position)} `}</Text>
            <Text color={HARNESS_COLOR[HARNESS_LABEL[entry.harness]] ?? 'gray'}>
              {HARNESS_LABEL[entry.harness].padEnd(7)}
            </Text>
            <Text {...entry.path === pinned ? { color: 'green' } : {}}>
              {`${entry.id.slice(0, 18).padEnd(18)} ${where.padEnd(38)} ${age}`}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}

/** The monitor application. */
export function App({ snapshot, tick, feedRows, mouse, onUnify, onSelect }: AppProps): React.ReactElement {
  const { exit } = useApp()
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const width = process.stdout.columns ?? 100

  const total = snapshot.rows.length
  const maxOffset = Math.max(0, total - feedRows)
  /**
   * Distance from the newest row, not an absolute index: history is capped by
   * dropping the oldest rows, so an absolute offset would drift backwards
   * through the feed every time the cap bites.
   */
  const [fromEnd, setFromEnd] = React.useState(0)
  // Following means pinned to the newest row, which is also the resting state
  // after `G`. Scrolling up leaves it, so arriving rows cannot yank the view.
  const following = fromEnd === 0
  const offset = Math.max(0, maxOffset - fromEnd)
  const visible = snapshot.rows.slice(offset, offset + feedRows)

  const scrollBy = (delta: number): void => {
    setFromEnd(current => Math.min(maxOffset, Math.max(0, current + delta)))
  }

  // Key handling needs raw mode, which only a TTY stdin offers. Piped output
  // still renders every pane; it just cannot be driven.
  const interactive = process.stdin.isTTY === true

  /**
   * Wheel scrolling via xterm SGR mouse reporting.
   *
   * This is handled on raw stdin rather than through `useInput`, because Ink
   * parses a mouse report's leading ESC as the escape key — quitting on every
   * scroll if quit were bound to it. Quit is therefore `q` or Ctrl+C only.
   */
  React.useEffect(() => {
    if (!interactive || !mouse) return
    const { stdin, stdout } = process
    // 1000 enables button reporting, 1006 asks for SGR coordinates so columns
    // beyond 223 still encode correctly on wide terminals.
    stdout.write('\u001B[?1000h\u001B[?1006h')
    const restore = (): void => { stdout.write('\u001B[?1006l\u001B[?1000l') }
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const match of text.matchAll(/\u001B\[<(\d+);\d+;\d+[Mm]/g)) {
        const button = Number.parseInt(match[1] ?? '', 10)
        if (button === 64) scrollBy(3)
        else if (button === 65) scrollBy(-3)
      }
    }
    stdin.on('data', onData)
    // A crash or signal skips React cleanup and would leave the terminal
    // reporting every mouse move to the shell.
    process.once('exit', restore)
    return () => {
      stdin.off('data', onData)
      process.off('exit', restore)
      restore()
    }
  }, [interactive, mouse, maxOffset])

  useInput((input, key) => {
    if (input === 'q') exit()
    if (input === 's') setPickerOpen(open => !open)
    if (input === 'u') {
      onUnify()
      setPickerOpen(false)
    }
    if (key.upArrow || input === 'k') scrollBy(1)
    if (key.downArrow || input === 'j') scrollBy(-1)
    if (key.pageUp) scrollBy(feedRows)
    if (key.pageDown) scrollBy(-feedRows)
    if (input === 'g') setFromEnd(maxOffset)
    if (input === 'G') setFromEnd(0)
    // Digits address sessions, so they must not be read as scroll input.
    const digit = Number.parseInt(input, 10)
    if (!Number.isNaN(digit)) {
      const entry = snapshot.sessions[digit]
      if (entry !== undefined) {
        onSelect(entry.path)
        setPickerOpen(false)
      }
    }
  }, { isActive: interactive })

  // One clock per render keeps every relative age on the same instant.
  const now = Date.now()
  const counts = new Map<string, number>()
  for (const session of snapshot.sessions) {
    const label = HARNESS_LABEL[session.harness]
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const sources = [...counts].map(([label, total]) => `${label} ${String(total)}`).join(' · ')

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text bold color="magenta" wrap="truncate">
          <Text color="green">{`${HEARTBEAT[tick % HEARTBEAT.length] ?? '·'} `}</Text>
          {snapshot.unified ? `agent trajectory · ${sources}` : snapshot.title ?? 'agent trajectory'}
        </Text>
        <Text color="gray">
          {following
            ? `q quit · s sessions · ${mouse ? 'wheel' : '↑'} scroll`
            : `PAUSED ${String(offset + 1)}-${String(Math.min(total, offset + feedRows))}/${String(total)} · G live`}
        </Text>
      </Box>
      <MetricsStrip metrics={snapshot.metrics} />
      <ContextGauge metrics={snapshot.metrics} width={width} />
      <Box flexDirection="column" marginTop={1}>
        {snapshot.error !== undefined
          ? <Text color="red">{snapshot.error}</Text>
          : snapshot.rows.length === 0
            ? <Text color="gray">no activity recorded yet</Text>
            : visible.map(row => (
              <FeedLine
                key={`${String(row.index)}-${String(row.time)}`}
                row={row}
                width={width}
                showHarness={snapshot.unified}
                now={now}
              />
            ))}
      </Box>
      {pickerOpen ? <SessionPicker sessions={snapshot.sessions} pinned={snapshot.pinned} /> : null}
    </Box>
  )
}
