import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Ink rendering: metrics strip, context gauge, activity feed, session picker.
 *
 * Every pane is a pure function of the polled snapshot, so the renderer holds
 * no derived state and a redraw can never disagree with the fold. A figure an
 * agent does not record renders as an em dash, never as zero.
 */
import { Box, Text, useApp, useInput } from 'ink';
import React from 'react';
import { HARNESS_LABEL } from './types.js';
const KIND_COLOR = {
    user: 'cyan',
    context: 'gray',
    assistant: 'white',
    tool: 'yellow',
    error: 'red',
    turn: 'gray',
};
const KIND_GLYPH = {
    user: '›',
    context: '⋯',
    assistant: '✎',
    tool: '⚙',
    error: '✖',
    turn: '─',
};
const HARNESS_COLOR = {
    claude: 'magenta',
    codex: 'green',
    dsh: 'blue',
    hermes: 'cyan',
};
/** Render a token count compactly, or an em dash when unknown. */
function tokens(value) {
    if (value === undefined)
        return '—';
    if (value < 1000)
        return String(value);
    if (value < 1_000_000)
        return `${(value / 1000).toFixed(1)}K`;
    return `${(value / 1_000_000).toFixed(2)}M`;
}
/** Render milliseconds as seconds, or an em dash when unknown. */
function seconds(ms) {
    return ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`;
}
/** Render a count, or an em dash when unknown. */
function count(value) {
    return value === undefined ? '—' : String(value);
}
/** Render a USD cost, or an em dash when the model has no configured price. */
function money(value) {
    if (value === undefined)
        return '$—';
    if (value === 0)
        return 'free';
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}
/** Age of an event relative to now, in the narrowest useful unit. */
function ago(time, now) {
    const seconds = Math.max(0, Math.round((now - time) / 1000));
    if (seconds < 60)
        return `${String(seconds)}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${String(minutes)}m`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))}d`;
}
/** Frames of the liveness indicator, advanced once per poll. */
const HEARTBEAT = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Metrics strip. */
function MetricsStrip({ metrics }) {
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
    ];
    return _jsx(Text, { color: "gray", wrap: "truncate", children: cells.join(' · ') });
}
/** Context gauge. */
function ContextGauge({ metrics, width }) {
    const { contextTokens, contextWindow } = metrics;
    if (contextTokens === undefined || contextWindow === undefined) {
        return (_jsx(Text, { color: "gray", wrap: "truncate", children: `ctx — · ${tokens(contextTokens)} occupied, no window reported` }));
    }
    const ratio = Math.min(1, contextTokens / contextWindow);
    const barWidth = Math.max(10, Math.min(40, width - 34));
    const filled = Math.round(ratio * barWidth);
    const color = ratio > 0.9 ? 'red' : ratio > 0.7 ? 'yellow' : 'green';
    return (_jsxs(Text, { wrap: "truncate", children: [_jsx(Text, { color: "gray", children: "ctx " }), _jsx(Text, { color: color, children: '█'.repeat(filled) }), _jsx(Text, { color: "gray", children: '░'.repeat(barWidth - filled) }), _jsx(Text, { color: "gray", children: ` ${(ratio * 100).toFixed(0)}% · ${tokens(contextTokens)}/${tokens(contextWindow)}` })] }));
}
/** One activity row, held to a single terminal line. */
function FeedLine({ row, width, showHarness, now }) {
    const duration = row.durationMs === undefined ? '' : ` ${seconds(row.durationMs)}`;
    const repeat = row.repeat === undefined ? '' : ` ×${String(row.repeat)}`;
    const tag = showHarness && row.harness !== undefined ? row.harness.padEnd(7).slice(0, 7) : '';
    const age = row.time > 0 ? ago(row.time, now).padStart(4) : '   —';
    const budget = Math.max(8, width - 27 - tag.length - duration.length - repeat.length);
    const text = row.text.length > budget ? `${row.text.slice(0, budget - 1)}…` : row.text;
    return (_jsxs(Text, { wrap: "truncate", children: [_jsx(Text, { color: "gray", children: `${age} ` }), tag.length > 0 ? _jsx(Text, { color: HARNESS_COLOR[row.harness ?? ''] ?? 'gray', children: tag }) : null, _jsx(Text, { color: KIND_COLOR[row.kind], children: `${KIND_GLYPH[row.kind]} ${row.label.padEnd(12).slice(0, 12)} ${text}` }), _jsx(Text, { color: "yellow", children: repeat }), _jsx(Text, { color: "gray", children: duration })] }));
}
/** Session picker overlay. */
function SessionPicker({ sessions, pinned }) {
    const now = Date.now();
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1, children: [_jsx(Text, { color: "gray", children: "sessions, newest first \u2014 digit selects \u00B7 u unified \u00B7 s closes" }), sessions.slice(0, 10).map((entry, position) => {
                const minutes = Math.round((now - entry.modifiedAt) / 60000);
                const age = minutes === 0
                    ? 'now'
                    : minutes < 60 ? `${String(minutes)}m` : `${String(Math.round(minutes / 60))}h`;
                const marker = entry.path === pinned ? '●' : ' ';
                const where = (entry.title ?? entry.cwd ?? '').slice(-38);
                return (_jsxs(Text, { wrap: "truncate", children: [_jsx(Text, { color: "gray", children: `${marker} ${String(position)} ` }), _jsx(Text, { color: HARNESS_COLOR[HARNESS_LABEL[entry.harness]] ?? 'gray', children: HARNESS_LABEL[entry.harness].padEnd(7) }), _jsx(Text, { ...entry.path === pinned ? { color: 'green' } : {}, children: `${entry.id.slice(0, 18).padEnd(18)} ${where.padEnd(38)} ${age}` })] }, entry.path));
            })] }));
}
/** The monitor application. */
export function App({ snapshot, tick, onUnify, onSelect }) {
    const { exit } = useApp();
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const width = process.stdout.columns ?? 100;
    // Key handling needs raw mode, which only a TTY stdin offers. Piped output
    // still renders every pane; it just cannot be driven.
    const interactive = process.stdin.isTTY === true;
    useInput((input, key) => {
        if (input === 'q' || key.escape)
            exit();
        if (input === 's')
            setPickerOpen(open => !open);
        if (input === 'u') {
            onUnify();
            setPickerOpen(false);
        }
        const digit = Number.parseInt(input, 10);
        if (!Number.isNaN(digit)) {
            const entry = snapshot.sessions[digit];
            if (entry !== undefined) {
                onSelect(entry.path);
                setPickerOpen(false);
            }
        }
    }, { isActive: interactive });
    // One clock per render keeps every relative age on the same instant.
    const now = Date.now();
    const counts = new Map();
    for (const session of snapshot.sessions) {
        const label = HARNESS_LABEL[session.harness];
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const sources = [...counts].map(([label, total]) => `${label} ${String(total)}`).join(' · ');
    return (_jsxs(Box, { flexDirection: "column", width: width, children: [_jsxs(Box, { justifyContent: "space-between", children: [_jsxs(Text, { bold: true, color: "magenta", wrap: "truncate", children: [_jsx(Text, { color: "green", children: `${HEARTBEAT[tick % HEARTBEAT.length] ?? '·'} ` }), snapshot.unified ? `agent trajectory · ${sources}` : snapshot.title ?? 'agent trajectory'] }), _jsx(Text, { color: "gray", children: "q quit \u00B7 s sessions \u00B7 u unified" })] }), _jsx(MetricsStrip, { metrics: snapshot.metrics }), _jsx(ContextGauge, { metrics: snapshot.metrics, width: width }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: snapshot.error !== undefined
                    ? _jsx(Text, { color: "red", children: snapshot.error })
                    : snapshot.rows.length === 0
                        ? _jsx(Text, { color: "gray", children: "no activity recorded yet" })
                        : snapshot.rows.map(row => (_jsx(FeedLine, { row: row, width: width, showHarness: snapshot.unified, now: now }, `${String(row.index)}-${String(row.time)}`))) }), pickerOpen ? _jsx(SessionPicker, { sessions: snapshot.sessions, pinned: snapshot.pinned }) : null] }));
}
