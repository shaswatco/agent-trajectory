/**
 * Claude Code adapter.
 *
 * Transcripts are one JSONL file per session under a project directory whose
 * name encodes the working directory. Assistant records carry `message.usage`,
 * so tokens and cache traffic are recoverable; the format records no step
 * timing, so model wall time, TTFT and throughput stay undefined rather than
 * being guessed from record timestamps.
 */
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isRealModel } from '../models.js';
import { epochOf, flatten, jsonlFilesIn, modifiedAt, previewArguments, readJsonl, safeReaddir } from './util.js';
/** Default transcript root. */
export function claudeRoot(env = process.env) {
    const configured = env['CLAUDE_CONFIG_DIR'];
    const base = configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.claude');
    return join(base, 'projects');
}
/** Recover a working directory from Claude's dash-encoded project directory. */
function decodeProject(encoded) {
    return `/${encoded.replace(/^-+/, '').replaceAll('-', '/')}`;
}
/** Read `message.usage`, when present. */
function usageOf(message) {
    const usage = message['usage'];
    if (typeof usage !== 'object' || usage === null)
        return undefined;
    const record = usage;
    const num = (key) => typeof record[key] === 'number' ? record[key] : 0;
    return {
        input: num('input_tokens'),
        output: num('output_tokens'),
        cacheRead: num('cache_read_input_tokens'),
        cacheWrite: num('cache_creation_input_tokens'),
    };
}
/** Fold one transcript into rows and figures. */
function foldTranscript(records) {
    const rows = [];
    let index = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let turns = 0;
    let steps = 0;
    let lastPrompt;
    let model;
    const push = (row) => {
        index += 1;
        rows.push({ ...row, index });
    };
    for (const record of records) {
        const time = epochOf(record['timestamp']) ?? 0;
        const type = record['type'];
        const message = typeof record['message'] === 'object' && record['message'] !== null
            ? record['message']
            : undefined;
        if (type === 'user' && message !== undefined) {
            const content = message['content'];
            const blocks = Array.isArray(content) ? content : [];
            // Tool results ride back as user-role records; only a typed prompt opens
            // a turn, which is what keeps the turn count meaningful.
            const isToolResult = blocks.some(block => typeof block === 'object' && block !== null
                && block['type'] === 'tool_result');
            const text = flatten(content);
            if (isToolResult) {
                if (text.length > 0)
                    push({ kind: 'context', label: 'result', text, time });
            }
            else if (text.length > 0) {
                turns += 1;
                push({ kind: 'user', label: 'user', text, time });
            }
            continue;
        }
        if (type === 'assistant' && message !== undefined) {
            steps += 1;
            const declared = message['model'];
            if (typeof declared === 'string' && isRealModel(declared))
                model = declared;
            const usage = usageOf(message);
            if (usage !== undefined) {
                input += usage.input;
                output += usage.output;
                cacheRead += usage.cacheRead;
                cacheWrite += usage.cacheWrite;
                // Occupancy is the prompt side of the NEWEST request, not the running
                // total: cache reads recur every turn, so summing them measures
                // traffic over the session and exceeds any context window.
                lastPrompt = usage.input + usage.cacheRead + usage.cacheWrite;
            }
            const content = message['content'];
            const texts = [];
            for (const block of Array.isArray(content) ? content : []) {
                if (typeof block !== 'object' || block === null)
                    continue;
                const item = block;
                if (item['type'] === 'tool_use') {
                    push({
                        kind: 'tool',
                        label: typeof item['name'] === 'string' ? item['name'] : 'tool',
                        text: previewArguments(item['input']),
                        time,
                    });
                }
                else if (item['type'] === 'text' && typeof item['text'] === 'string') {
                    texts.push(item['text']);
                }
            }
            const text = texts.join(' ').replace(/\s+/g, ' ').trim();
            if (text.length > 0)
                push({ kind: 'assistant', label: 'assistant', text, time });
            continue;
        }
        if (type === 'system') {
            const text = flatten(record['content']);
            if (text.length > 0)
                push({ kind: 'context', label: 'system', text, time });
        }
    }
    const prompt = input + cacheRead + cacheWrite;
    const metrics = {
        turns,
        steps,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        ...prompt > 0 ? { cacheHitRatio: cacheRead / prompt } : {},
        ...lastPrompt === undefined ? {} : { contextTokens: lastPrompt },
        ...model === undefined ? {} : { model },
    };
    return { metrics, rows };
}
/** Build the Claude Code adapter. */
export function claudeAdapter(root = claudeRoot()) {
    return {
        id: 'claude',
        root,
        discover: () => {
            const sessions = [];
            for (const project of safeReaddir(root)) {
                const cwd = decodeProject(project);
                for (const path of jsonlFilesIn(join(root, project))) {
                    const time = modifiedAt(path);
                    if (time === undefined)
                        continue;
                    sessions.push({ harness: 'claude', id: basename(path, '.jsonl'), path, cwd, modifiedAt: time });
                }
            }
            return sessions;
        },
        read: (session) => foldTranscript(readJsonl(session.path)),
    };
}
