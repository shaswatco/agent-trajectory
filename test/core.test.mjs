import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { claudeAdapter } from '../dist/adapters/claude.js'
import { codexAdapter } from '../dist/adapters/codex.js'
import { cachedTrajectory } from '../dist/adapters/util.js'
import { adjustedFromEnd } from '../dist/app.js'
import { parseOptions } from '../dist/cli.js'
import { selectUnifiedSessions, underCwd } from '../dist/registry.js'
import { mergeMetrics } from '../dist/types.js'

/** Run a test in an isolated temporary agent home. */
function withTempDir(run) {
  const path = mkdtempSync(join(tmpdir(), 'agent-trajectory-'))
  try {
    run(path)
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}

test('Claude discovery takes cwd from its transcript, not its encoded directory name', () => {
  withTempDir(home => {
    const projects = join(home, 'projects')
    const path = join(projects, 'lossy-name', 'session.jsonl')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{"cwd":"/work/agent-trajectory"}\n')
    const sessions = claudeAdapter(projects).discover()
    assert.deepEqual(sessions.map(session => session.cwd), ['/work/agent-trajectory'])
  })
})

test('Codex discovery finds active rollouts in date-nested session directories', () => {
  withTempDir(home => {
    const sessionsRoot = join(home, 'sessions')
    const path = join(sessionsRoot, '2026', '08', '20', 'rollout-live.jsonl')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{"type":"session_meta","payload":{"cwd":"/work/live"}}\n')
    const sessions = codexAdapter([sessionsRoot]).discover()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.id, 'live')
    assert.equal(sessions[0]?.cwd, '/work/live')
  })
})

test('folded trajectories are reused until their source file changes', () => {
  withTempDir(home => {
    const path = join(home, 'session.jsonl')
    writeFileSync(path, 'first\n')
    let runs = 0
    const read = () => cachedTrajectory(path, () => ({ run: ++runs }))
    assert.deepEqual(read(), { run: 1 })
    assert.deepEqual(read(), { run: 1 })
    writeFileSync(path, 'second\n')
    assert.deepEqual(read(), { run: 2 })
  })
})

test('unified selection reserves one slot for every harness before filling by recency', () => {
  const entries = [
    ['claude', 10], ['claude', 9], ['codex', 8], ['deepseek', 7], ['hermes', 6], ['codex', 5],
  ].map(([harness, modifiedAt], index) => ({
    session: { harness, id: String(index), path: `/logs/${String(index)}`, modifiedAt },
    adapter: {},
  }))
  const selected = selectUnifiedSessions(entries, 6)
  assert.deepEqual(selected.map(entry => entry.session.harness), [
    'claude', 'codex', 'deepseek', 'hermes', 'claude', 'codex',
  ])
})

test('a merged context gauge is reported only when exactly one session supplies a pair', () => {
  const one = mergeMetrics([{ contextTokens: 90_000, contextWindow: 100_000 }])
  assert.equal(one.contextTokens, 90_000)
  assert.equal(one.contextWindow, 100_000)
  assert.equal(one.contextMixed, undefined)
  const mixed = mergeMetrics([
    { contextTokens: 90_000, contextWindow: 100_000 },
    { contextTokens: 100_000, contextWindow: 1_000_000 },
  ])
  assert.equal(mixed.contextMixed, true)
  assert.equal(mixed.contextTokens, undefined)
  assert.equal(mixed.contextWindow, undefined)
})

test('cwd filtering accepts a project and descendants but not a shared prefix', () => {
  assert.equal(underCwd('/work/repo', '/work/repo'), true)
  assert.equal(underCwd('/work/repo/packages/app', '/work/repo'), true)
  assert.equal(underCwd('/work/repository', '/work/repo'), false)
})

test('a paused scroll position stays on the same top row as new activity arrives', () => {
  // With 100 rows, a ten-row viewport and a 30-row distance from the bottom,
  // the visible top row is 60. Ten new rows must not move it.
  assert.equal(adjustedFromEnd(30, 90, 100), 40)
  assert.equal(100 - 40, 60)
  assert.equal(adjustedFromEnd(0, 90, 100), 0)
})

test('JSON mode is explicit and malformed options fail before starting the monitor', () => {
  const options = parseOptions(['--json', '--agent', 'codex'])
  assert.equal(options.json, true)
  assert.deepEqual(options.harnesses, ['codex'])
  assert.throws(() => parseOptions(['--merge']), /--merge needs a value/)
  assert.throws(() => parseOptions(['--unknown']), /unknown option/)
})
