#!/usr/bin/env node
/** `atrajectory` entry: poll every agent's session store and render the feed. */
import { render } from 'ink';
import React from 'react';
import { App } from './app.js';
import { allAdapters, discoverAll, mergeSessions, readTagged, underCwd } from './registry.js';
import { HARNESS_IDS } from './types.js';
/** Rows reserved for the header, metrics strip, gauge and spacing. */
const CHROME_ROWS = 6;
const HELP = `
agent trajectory — watch what your AI coding agents are doing, in the terminal

  Reads Claude Code, Codex, DeepSeek Harness and Hermes session logs and shows
  tool calls, model responses, tokens and context in one live feed.

Usage
  atrajectory [options]

Options
  --agent <list>     comma-separated: claude,codex,deepseek,hermes (default all)
  --cwd [dir]        only sessions recorded under dir (bare flag means $PWD)
  --session <path>   pin one session instead of the unified feed
  --merge <n>        sessions merged into the unified feed, default 6
  --interval <ms>    poll interval, default 1000
  -h, --help         show this help
  -v, --version      show the version

Keys
  q quit · s session picker · u unified view · 0-9 select a session

Everything is read-only: session logs are never written, locked or deleted.
`;
/** Parse an `--agent` list, rejecting unknown names rather than ignoring them. */
function parseAgents(value) {
    const chosen = [];
    for (const name of value.split(',').map(part => part.trim()).filter(part => part.length > 0)) {
        const match = HARNESS_IDS.find(id => id === name);
        if (match === undefined) {
            throw new Error(`atrajectory: unknown agent ${JSON.stringify(name)}; known: ${HARNESS_IDS.join(', ')}`);
        }
        chosen.push(match);
    }
    if (chosen.length === 0)
        throw new Error('atrajectory: --agent needs at least one name');
    return chosen;
}
/** Resolve arguments into launch parameters. */
export function parseOptions(argv) {
    let pollIntervalMs = 1000;
    let pinned;
    let harnesses = HARNESS_IDS;
    let cwd;
    let mergeLimit = 6;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        const hasValue = next !== undefined && !next.startsWith('-');
        if (arg === '--interval' && hasValue) {
            pollIntervalMs = Number.parseInt(next, 10);
            index += 1;
        }
        else if (arg === '--session' && hasValue) {
            pinned = next;
            index += 1;
        }
        else if (arg === '--agent' && hasValue) {
            harnesses = parseAgents(next);
            index += 1;
        }
        else if (arg === '--merge' && hasValue) {
            mergeLimit = Number.parseInt(next, 10);
            index += 1;
        }
        else if (arg === '--cwd') {
            // Bare `--cwd` means "here", the common case; a value narrows elsewhere.
            cwd = hasValue ? next : process.cwd();
            if (hasValue)
                index += 1;
        }
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
        throw new Error('atrajectory: --interval must be a positive number of milliseconds');
    }
    if (!Number.isInteger(mergeLimit) || mergeLimit <= 0) {
        throw new Error('atrajectory: --merge must be a positive integer');
    }
    return { pollIntervalMs, harnesses, mergeLimit, ...pinned === undefined ? {} : { pinned }, ...cwd === undefined ? {} : { cwd } };
}
/** Read one snapshot across every selected agent. */
export function snapshot(options, adapters, pinned, feedRows) {
    let discovered = discoverAll(adapters);
    if (options.cwd !== undefined) {
        const root = options.cwd;
        // Some formats record cwd only inside the body, so an unknown cwd is
        // excluded rather than assumed to match.
        discovered = discovered.filter(entry => underCwd(entry.session.cwd, root));
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
        };
    }
    const sessions = discovered.map(entry => entry.session);
    if (pinned !== undefined) {
        const entry = discovered.find(candidate => candidate.session.path === pinned);
        if (entry === undefined) {
            return {
                sessions,
                pinned,
                unified: false,
                metrics: {},
                rows: [],
                error: `pinned session is no longer discoverable: ${pinned}`,
            };
        }
        const trajectory = readTagged(entry);
        return {
            sessions,
            pinned,
            title: entry.session.title ?? entry.session.id,
            unified: false,
            metrics: trajectory.metrics,
            rows: trajectory.rows.slice(-feedRows),
        };
    }
    const merged = mergeSessions(discovered.slice(0, options.mergeLimit), feedRows);
    return { sessions, unified: true, metrics: merged.metrics, rows: merged.rows };
}
/** Root component owning the poll loop and the pinned selection. */
function Monitor({ options }) {
    const adapters = React.useMemo(() => allAdapters().filter(adapter => options.harnesses.includes(adapter.id)), [options]);
    const feedRows = Math.max(4, (process.stdout.rows ?? 24) - CHROME_ROWS);
    const [pinned, setPinned] = React.useState(options.pinned);
    const [view, setView] = React.useState(() => snapshot(options, adapters, options.pinned, feedRows));
    React.useEffect(() => {
        const timer = setInterval(() => {
            setView(snapshot(options, adapters, pinned, feedRows));
        }, options.pollIntervalMs);
        return () => { clearInterval(timer); };
    }, [pinned, options, adapters, feedRows]);
    return React.createElement(App, {
        snapshot: view,
        onUnify: () => { setPinned(undefined); },
        onSelect: (path) => { setPinned(path); },
    });
}
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${HELP.trimStart()}\n`);
}
else if (argv.includes('-v') || argv.includes('--version')) {
    process.stdout.write('0.1.0\n');
}
else {
    try {
        const options = parseOptions(argv);
        const instance = render(React.createElement(Monitor, { options }));
        await instance.waitUntilExit();
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
