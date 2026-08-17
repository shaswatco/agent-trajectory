/** Adapter registry and the cross-agent reads the renderer consumes. */

import { claudeAdapter } from './adapters/claude.js'
import { codexAdapter } from './adapters/codex.js'
import { deepseekAdapter } from './adapters/deepseek.js'
import { hermesAdapter } from './adapters/hermes.js'
import { HARNESS_LABEL, mergeMetrics } from './types.js'
import type { Adapter, HarnessId, Metrics, Row, Session, Trajectory } from './types.js'

/** Every adapter, in display order. */
export function allAdapters(): Adapter[] {
  return [claudeAdapter(), codexAdapter(), deepseekAdapter(), hermesAdapter()]
}

/** A discovered session paired with the adapter that can read it. */
export interface Discovered {
  session: Session
  adapter: Adapter
}

/** Discover every session across every adapter, newest write first. */
export function discoverAll(adapters: readonly Adapter[]): Discovered[] {
  const found: Discovered[] = []
  for (const adapter of adapters) {
    for (const session of adapter.discover()) found.push({ session, adapter })
  }
  return found.sort((left, right) => right.session.modifiedAt - left.session.modifiedAt)
}

/** Read one session, tagging every row with its agent. */
export function readTagged(entry: Discovered): Trajectory {
  const trajectory = entry.adapter.read(entry.session)
  const harness = HARNESS_LABEL[entry.session.harness]
  return { metrics: trajectory.metrics, rows: trajectory.rows.map(row => ({ ...row, harness })) }
}

/**
 * Merge several sessions into one time-ordered feed with summed figures.
 * Rows are re-indexed after the merge so `#N` counts the unified feed rather
 * than repeating each source's own numbering.
 */
export function mergeSessions(entries: readonly Discovered[], limit: number): Trajectory {
  if (entries.length === 0) return { metrics: {}, rows: [] }
  const parts: Metrics[] = []
  const rows: Row[] = []
  for (const entry of entries) {
    const trajectory = readTagged(entry)
    parts.push(trajectory.metrics)
    rows.push(...trajectory.rows)
  }
  rows.sort((left, right) => left.time - right.time)
  return {
    metrics: mergeMetrics(parts),
    rows: rows.slice(-limit).map((row, position) => ({ ...row, index: position + 1 })),
  }
}

/** Whether a session's recorded cwd sits at or under `root`. */
export function underCwd(sessionCwd: string | undefined, root: string): boolean {
  if (sessionCwd === undefined) return false
  return sessionCwd === root || sessionCwd.startsWith(`${root}/`)
}

/** Sessions per agent, for the header summary. */
export function sourceCounts(sessions: readonly Session[]): Array<[HarnessId, number]> {
  const counts = new Map<HarnessId, number>()
  for (const session of sessions) counts.set(session.harness, (counts.get(session.harness) ?? 0) + 1)
  return [...counts]
}
