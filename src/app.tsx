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
  ]
  return <Text color="gray" wrap="truncate">{cells.join(' · ')}</Text>
}

/** Context gauge. */
function ContextGauge({ metrics, width }: { metrics: Metrics; width: number }): React.ReactElement {
  const { contextTokens, contextWindow } = metrics
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
function FeedLine({ row, width, showHarness }: {
  row: Row
  width: number
  showHarness: boolean
}): React.ReactElement {
  const duration = row.durationMs === undefined ? '' : ` ${seconds(row.durationMs)}`
  const tag = showHarness && row.harness !== undefined ? row.harness.padEnd(7).slice(0, 7) : ''
  const budget = Math.max(8, width - 22 - tag.length - duration.length)
  const text = row.text.length > budget ? `${row.text.slice(0, budget - 1)}…` : row.text
  return (
    <Text wrap="truncate">
      <Text color="gray">{`#${String(row.index).padEnd(4)}`}</Text>
      {tag.length > 0 ? <Text color={HARNESS_COLOR[row.harness ?? ''] ?? 'gray'}>{tag}</Text> : null}
      <Text color={KIND_COLOR[row.kind]}>
        {`${KIND_GLYPH[row.kind]} ${row.label.padEnd(12).slice(0, 12)} ${text}`}
      </Text>
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
export function App({ snapshot, onUnify, onSelect }: AppProps): React.ReactElement {
  const { exit } = useApp()
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const width = process.stdout.columns ?? 100

  // Key handling needs raw mode, which only a TTY stdin offers. Piped output
  // still renders every pane; it just cannot be driven.
  const interactive = process.stdin.isTTY === true

  useInput((input, key) => {
    if (input === 'q' || key.escape) exit()
    if (input === 's') setPickerOpen(open => !open)
    if (input === 'u') {
      onUnify()
      setPickerOpen(false)
    }
    const digit = Number.parseInt(input, 10)
    if (!Number.isNaN(digit)) {
      const entry = snapshot.sessions[digit]
      if (entry !== undefined) {
        onSelect(entry.path)
        setPickerOpen(false)
      }
    }
  }, { isActive: interactive })

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
          {snapshot.unified ? `agent trajectory · ${sources}` : snapshot.title ?? 'agent trajectory'}
        </Text>
        <Text color="gray">q quit · s sessions · u unified</Text>
      </Box>
      <MetricsStrip metrics={snapshot.metrics} />
      <ContextGauge metrics={snapshot.metrics} width={width} />
      <Box flexDirection="column" marginTop={1}>
        {snapshot.error !== undefined
          ? <Text color="red">{snapshot.error}</Text>
          : snapshot.rows.length === 0
            ? <Text color="gray">no activity recorded yet</Text>
            : snapshot.rows.map(row => (
              <FeedLine
                key={`${String(row.index)}-${String(row.time)}`}
                row={row}
                width={width}
                showHarness={snapshot.unified}
              />
            ))}
      </Box>
      {pickerOpen ? <SessionPicker sessions={snapshot.sessions} pinned={snapshot.pinned} /> : null}
    </Box>
  )
}
