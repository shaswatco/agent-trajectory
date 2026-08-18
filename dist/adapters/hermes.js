/**
 * Hermes adapter.
 *
 * Each session is one JSON document holding the whole conversation, so there
 * is no append-only tail to follow: a poll re-reads the file and sees the
 * writer's latest complete save. The format records `messages`, `model` and
 * `tools` but no token accounting or step timing, so this adapter contributes
 * rows and turn counts and leaves every token and latency figure undefined.
 */
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { epochOf, flatten, modifiedAt, previewArguments, readText, recordAt, safeReaddir } from './util.js';
/** Default session directory. */
export function hermesRoot(env = process.env) {
    const configured = env['HERMES_HOME'];
    const base = configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.hermes');
    return join(base, 'sessions');
}
/** Fold one session document into rows and figures. */
function foldDocument(document, fallbackTime) {
    const rows = [];
    const messages = Array.isArray(document['messages']) ? document['messages'] : [];
    const time = epochOf(document['last_updated']) ?? fallbackTime;
    let turns = 0;
    let steps = 0;
    let index = 0;
    const push = (row) => {
        index += 1;
        rows.push({ ...row, index });
    };
    for (const entry of messages) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const message = entry;
        const text = flatten(message['content']);
        switch (message['role']) {
            case 'user':
                turns += 1;
                if (text.length > 0)
                    push({ kind: 'user', label: 'user', text, time });
                break;
            case 'assistant': {
                steps += 1;
                const calls = message['tool_calls'];
                for (const call of Array.isArray(calls) ? calls : []) {
                    if (typeof call !== 'object' || call === null)
                        continue;
                    const named = recordAt(call, 'function');
                    push({
                        kind: 'tool',
                        label: typeof named?.['name'] === 'string' ? named['name'] : 'tool',
                        text: previewArguments(named?.['arguments']),
                        time,
                    });
                }
                if (text.length > 0)
                    push({ kind: 'assistant', label: 'assistant', text, time });
                break;
            }
            case 'system':
                if (text.length > 0)
                    push({ kind: 'context', label: 'system', text, time });
                break;
            case 'tool':
                if (text.length > 0)
                    push({ kind: 'context', label: 'result', text, time });
                break;
            default:
                break;
        }
    }
    return { metrics: { turns, steps }, rows };
}
/** Build the Hermes adapter. */
export function hermesAdapter(root = hermesRoot()) {
    return {
        id: 'hermes',
        root,
        discover: () => {
            const sessions = [];
            for (const name of safeReaddir(root)) {
                // The directory also holds `request_dump_*.json` diagnostics, which
                // are single requests rather than conversations.
                if (!name.startsWith('session_') || !name.endsWith('.json'))
                    continue;
                const path = join(root, name);
                const time = modifiedAt(path);
                if (time === undefined)
                    continue;
                sessions.push({
                    harness: 'hermes',
                    id: basename(name, '.json').replace(/^session_/, ''),
                    path,
                    modifiedAt: time,
                });
            }
            return sessions;
        },
        read: (session) => {
            const text = readText(session.path);
            if (text === undefined)
                return { metrics: {}, rows: [] };
            let document;
            try {
                const parsed = JSON.parse(text);
                if (typeof parsed !== 'object' || parsed === null)
                    return { metrics: {}, rows: [] };
                document = parsed;
            }
            catch {
                // A whole-document format has no partial-read recovery: a save in
                // flight yields invalid JSON, and the next poll reads it complete.
                return { metrics: {}, rows: [] };
            }
            if (typeof document['model'] === 'string')
                session.title = document['model'];
            return foldDocument(document, session.modifiedAt);
        },
    };
}
