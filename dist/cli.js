#!/usr/bin/env node
/** `atrajectory` entry: poll every agent's session store and render the feed. */
import { render } from 'ink';
import React from 'react';
import { App } from './app.js';
import { loadPricing, pricingPath } from './models.js';
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
  --verbose          include injected context rows (system prompts, tool results)
  --pricing <path>   model price table (default ${pricingPath()})
  --cwd [dir]        only sessions recorded under dir (bare flag means $PWD)
  --session <path>   pin one session instead of the unified feed
  --merge <n>        sessions merged into the unified feed, default 6
  --history <n>      rows kept for scrollback, default 5000
  --no-mouse         disable wheel scrolling, restoring drag-to-select
  --interval <ms>    poll interval, default 1000
  -h, --help         show this help
  -v, --version      show the version

Keys
  q quit · s session picker · u unified view · 0-9 select a session
  wheel or ↑/↓ or j/k scroll · PgUp/PgDn page · g top · G bottom (resume live)

Costs need a price table; free-tier models are recognised automatically and
everything else shows $— until you write one. See the README.

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
    let historyLimit = 5000;
    let verbose = false;
    let mouse = true;
    let pricingFile;
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
        else if (arg === '--history' && hasValue) {
            historyLimit = Number.parseInt(next, 10);
            index += 1;
        }
        else if (arg === '--verbose')
            verbose = true;
        else if (arg === '--no-mouse')
            mouse = false;
        else if (arg === '--pricing' && hasValue) {
            pricingFile = next;
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
    if (!Number.isInteger(historyLimit) || historyLimit <= 0) {
        throw new Error('atrajectory: --history must be a positive integer');
    }
    return {
        pollIntervalMs,
        harnesses,
        mergeLimit,
        historyLimit,
        verbose,
        mouse,
        pricing: loadPricing(pricingFile),
        ...pinned === undefined ? {} : { pinned },
        ...cwd === undefined ? {} : { cwd },
    };
}
/** Read one snapshot across every selected agent. */
export function snapshot(options, adapters, pinned) {
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
        const trajectory = readTagged(entry, { verbose: options.verbose, pricing: options.pricing });
        return {
            sessions,
            pinned,
            title: entry.session.title ?? entry.session.id,
            unified: false,
            metrics: trajectory.metrics,
            rows: trajectory.rows.slice(-options.historyLimit),
        };
    }
    const merged = mergeSessions(discovered.slice(0, options.mergeLimit), options.historyLimit, { verbose: options.verbose, pricing: options.pricing });
    return { sessions, unified: true, metrics: merged.metrics, rows: merged.rows };
}
/** Root component owning the poll loop and the pinned selection. */
function Monitor({ options }) {
    const adapters = React.useMemo(() => allAdapters().filter(adapter => options.harnesses.includes(adapter.id)), [options]);
    const [rows, setRows] = React.useState(process.stdout.rows ?? 24);
    const [pinned, setPinned] = React.useState(options.pinned);
    const [view, setView] = React.useState(() => snapshot(options, adapters, options.pinned));
    const [tick, setTick] = React.useState(0);
    // Ink does not re-render on resize by itself, and a stale viewport height
    // silently drops rows off the bottom of the feed.
    React.useEffect(() => {
        const onResize = () => { setRows(process.stdout.rows ?? 24); };
        process.stdout.on('resize', onResize);
        return () => { process.stdout.off('resize', onResize); };
    }, []);
    React.useEffect(() => {
        const timer = setInterval(() => {
            setView(snapshot(options, adapters, pinned));
            // Advancing only after a completed read makes the indicator report that
            // polling is working, not merely that a timer is firing.
            setTick(previous => previous + 1);
        }, options.pollIntervalMs);
        return () => { clearInterval(timer); };
    }, [pinned, options, adapters]);
    return React.createElement(App, {
        snapshot: view,
        tick,
        feedRows: Math.max(4, rows - CHROME_ROWS),
        mouse: options.mouse,
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
