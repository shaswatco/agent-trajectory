#!/usr/bin/env node
/** `atrajectory` entry: poll every agent's session store and render the feed. */

import { render } from 'ink'
import React from 'react'
import { App } from './app.js'
import type { Snapshot } from './app.js'
import { loadPricing, pricingPath } from './models.js'
import type { PricingTable } from './models.js'
import { allAdapters, discoverAll, mergeSessions, readTagged, underCwd } from './registry.js'
import { HARNESS_IDS } from './types.js'
import type { Adapter, HarnessId } from './types.js'

/** Resolved launch parameters; defaulting happens here, never inline. */
interface Options {
  pollIntervalMs: number
  pinned?: string
  harnesses: readonly HarnessId[]
  cwd?: string
  mergeLimit: number
  /** Show injected-context rows, which otherwise dominate the feed. */
  verbose: boolean
  pricing: PricingTable
}

/** Rows reserved for the header, metrics strip, gauge and spacing. */
const CHROME_ROWS = 6

const HELP = `
agent trajectory — watch what your AI coding agents are doing, in the terminal

  Reads Claude Code, Codex, DeepSeek Harness and Hermes session logs and shows
  tool calls, model responses, tokens and context in one live feed.

Usage
  atrajectory [options]

Options
  --agent <list>     comma-separated: claude,codex,deepseek,hermes (default all)
  --verbose          include injected context rows (system prompts, tool results)
  --pricing <path>   model price table (default ${pricingPath()})
  --cwd [dir]        only sessions recorded under dir (bare flag means $PWD)
  --session <path>   pin one session instead of the unified feed
  --merge <n>        sessions merged into the unified feed, default 6
  --interval <ms>    poll interval, default 1000
  -h, --help         show this help
  -v, --version      show the version

Keys
  q quit · s session picker · u unified view · 0-9 select a session

Costs need a price table; free-tier models are recognised automatically and
everything else shows $— until you write one. See the README.

Everything is read-only: session logs are never written, locked or deleted.
`

/** Parse an `--agent` list, rejecting unknown names rather than ignoring them. */
function parseAgents(value: string): HarnessId[] {
  const chosen: HarnessId[] = []
  for (const name of value.split(',').map(part => part.trim()).filter(part => part.length > 0)) {
    const match = HARNESS_IDS.find(id => id === name)
    if (match === undefined) {
      throw new Error(`atrajectory: unknown agent ${JSON.stringify(name)}; known: ${HARNESS_IDS.join(', ')}`)
    }
    chosen.push(match)
  }
  if (chosen.length === 0) throw new Error('atrajectory: --agent needs at least one name')
  return chosen
}

/** Resolve arguments into launch parameters. */
export function parseOptions(argv: readonly string[]): Options {
  let pollIntervalMs = 1000
  let pinned: string | undefined
  let harnesses: readonly HarnessId[] = HARNESS_IDS
  let cwd: string | undefined
  let mergeLimit = 6
  let verbose = false
  let pricingFile: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    const hasValue = next !== undefined && !next.startsWith('-')
    if (arg === '--interval' && hasValue) { pollIntervalMs = Number.parseInt(next, 10); index += 1 }
    else if (arg === '--session' && hasValue) { pinned = next; index += 1 }
    else if (arg === '--agent' && hasValue) { harnesses = parseAgents(next); index += 1 }
    else if (arg === '--merge' && hasValue) { mergeLimit = Number.parseInt(next, 10); index += 1 }
    else if (arg === '--verbose') verbose = true
    else if (arg === '--pricing' && hasValue) { pricingFile = next; index += 1 }
    else if (arg === '--cwd') {
      // Bare `--cwd` means "here", the common case; a value narrows elsewhere.
      cwd = hasValue ? next : process.cwd()
      if (hasValue) index += 1
    }
  }

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('atrajectory: --interval must be a positive number of milliseconds')
  }
  if (!Number.isInteger(mergeLimit) || mergeLimit <= 0) {
    throw new Error('atrajectory: --merge must be a positive integer')
  }
  return {
    pollIntervalMs,
    harnesses,
    mergeLimit,
    verbose,
    pricing: loadPricing(pricingFile),
    ...pinned === undefined ? {} : { pinned },
    ...cwd === undefined ? {} : { cwd },
  }
}

/** Read one snapshot across every selected agent. */
export function snapshot(
  options: Options,
  adapters: readonly Adapter[],
  pinned: string | undefined,
  feedRows: number,
): Snapshot {
  let discovered = discoverAll(adapters)
  if (options.cwd !== undefined) {
    const root = options.cwd
    // Some formats record cwd only inside the body, so an unknown cwd is
    // excluded rather than assumed to match.
    discovered = discovered.filter(entry => underCwd(entry.session.cwd, root))
  }

  if (discovered.length === 0) {
    return {
      sessions: [],
      unified: pinned === undefined,
      metrics: {},
      rows: [],
      error: options.cwd === undefined
        ? `no sessions found for: ${adapters.map(adapter => adapter.id).join(', ')}`
        : `no sessions recorded under ${options.cwd}`,
    }
  }

  const sessions = discovered.map(entry => entry.session)

  if (pinned !== undefined) {
    const entry = discovered.find(candidate => candidate.session.path === pinned)
    if (entry === undefined) {
      return {
        sessions,
        pinned,
        unified: false,
        metrics: {},
        rows: [],
        error: `pinned session is no longer discoverable: ${pinned}`,
      }
    }
    const trajectory = readTagged(entry, { verbose: options.verbose, pricing: options.pricing })
    return {
      sessions,
      pinned,
      title: entry.session.title ?? entry.session.id,
      unified: false,
      metrics: trajectory.metrics,
      rows: trajectory.rows.slice(-feedRows),
    }
  }

  const merged = mergeSessions(
    discovered.slice(0, options.mergeLimit),
    feedRows,
    { verbose: options.verbose, pricing: options.pricing },
  )
  return { sessions, unified: true, metrics: merged.metrics, rows: merged.rows }
}

/** Root component owning the poll loop and the pinned selection. */
function Monitor({ options }: { options: Options }): React.ReactElement {
  const adapters = React.useMemo(
    () => allAdapters().filter(adapter => options.harnesses.includes(adapter.id)),
    [options],
  )
  const feedRows = Math.max(4, (process.stdout.rows ?? 24) - CHROME_ROWS)
  const [pinned, setPinned] = React.useState<string | undefined>(options.pinned)
  const [view, setView] = React.useState<Snapshot>(() => snapshot(options, adapters, options.pinned, feedRows))
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    const timer = setInterval(() => {
      setView(snapshot(options, adapters, pinned, feedRows))
      // Advancing only after a completed read makes the indicator report that
      // polling is working, not merely that a timer is firing.
      setTick(previous => previous + 1)
    }, options.pollIntervalMs)
    return () => { clearInterval(timer) }
  }, [pinned, options, adapters, feedRows])

  return React.createElement(App, {
    snapshot: view,
    tick,
    onUnify: () => { setPinned(undefined) },
    onSelect: (path: string) => { setPinned(path) },
  })
}

const argv = process.argv.slice(2)

if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(`${HELP.trimStart()}\n`)
} else if (argv.includes('-v') || argv.includes('--version')) {
  process.stdout.write('0.1.0\n')
} else {
  try {
    const options = parseOptions(argv)
    const instance = render(React.createElement(Monitor, { options }))
    await instance.waitUntilExit()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
