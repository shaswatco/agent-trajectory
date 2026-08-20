/**
 * Filesystem and decoding helpers shared by the adapters. No dependencies:
 * Zstandard comes from `node:zlib` on Node 22.15+.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
/** Directory entries, or an empty list when the directory is absent. */
export function safeReaddir(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        // An absent agent home is an empty listing: this tool supports four
        // agents and expects most machines to have installed fewer.
        return [];
    }
}
/** File modification time in epoch ms, or undefined when unreadable. */
export function modifiedAt(path) {
    try {
        return statSync(path).mtimeMs;
    }
    catch {
        // Raced deletion between listing and stat; the entry is dropped.
        return undefined;
    }
}
/**
 * Parsed-content cache keyed by identity, so the poll loop re-parses only the
 * files that actually changed. Session logs are append-only and can reach
 * megabytes; re-reading every one of them each second is the difference
 * between an idle monitor and a warm laptop.
 */
const cache = new Map();
/** Identity of a file for cache purposes, or undefined when unreadable. */
function identity(path) {
    try {
        const stats = statSync(path);
        return { size: stats.size, mtime: stats.mtimeMs };
    }
    catch {
        // Raced deletion; the caller falls back to a fresh read that also fails.
        return undefined;
    }
}
/**
 * Return the cached parse for `path`, or compute and store one.
 * @param path - file whose parse is cached.
 * @param compute - parser run only when the file changed.
 * @returns the cached or freshly computed value.
 */
export function cached(path, compute) {
    const now = identity(path);
    const hit = cache.get(path);
    if (now !== undefined && hit !== undefined && hit.size === now.size && hit.mtime === now.mtime) {
        return hit.value;
    }
    const value = compute();
    if (now !== undefined)
        cache.set(path, { ...now, value });
    return value;
}
/** Read a file as text, or undefined when unreadable. */
export function readText(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        // Unreadable artifact (permissions, deletion mid-poll): an empty
        // trajectory renders as "no activity" rather than failing the view.
        return undefined;
    }
}
/**
 * Read the start of a text file without retaining or parsing its full body.
 *
 * Session metadata appears in the first records for Claude Code and Codex.
 * Discovery uses this bounded read so cwd filtering does not have to derive a
 * path from a lossy directory-name encoding or parse every full transcript.
 */
export function readTextPrefix(path, bytes = 131_072) {
    let descriptor;
    try {
        descriptor = openSync(path, 'r');
        const buffer = Buffer.allocUnsafe(bytes);
        const read = readSync(descriptor, buffer, 0, bytes, 0);
        return buffer.subarray(0, read).toString('utf8');
    }
    catch {
        // The writer may have removed or rotated the artifact between discovery
        // and its metadata read. Treat it as unavailable for this poll.
        return undefined;
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
}
/** Every `*.jsonl` directly under `dir`. */
export function jsonlFilesIn(dir) {
    return safeReaddir(dir).filter(name => name.endsWith('.jsonl')).map(name => join(dir, name));
}
/** Parse JSONL text into records, skipping lines a writer left torn. */
export function parseJsonl(text) {
    const records = [];
    for (const line of text.split('\n')) {
        if (line.length === 0)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (typeof parsed === 'object' && parsed !== null)
                records.push(parsed);
        }
        catch {
            // A live writer's trailing partial line; the next poll sees it whole.
            continue;
        }
    }
    return records;
}
/** Read and parse a JSONL file, reusing the previous parse when unchanged. */
export function readJsonl(path) {
    return cached(path, () => {
        const text = readText(path);
        return text === undefined ? [] : parseJsonl(text);
    });
}
/** Parse the complete JSONL lines in one bounded file prefix. */
export function readJsonlPrefix(path) {
    const text = readTextPrefix(path);
    if (text === undefined)
        return [];
    // The final line can be cut mid-record, and parseJsonl deliberately ignores
    // that same live-writer condition.
    return parseJsonl(text);
}
/** Zstandard frame magic (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/**
 * Decode a file of concatenated Zstandard frames.
 *
 * `zstdDecompressSync` stops after the first frame, so frames are located by
 * magic and decoded one at a time. The magic can also occur inside compressed
 * data, so a slice that fails to decode is extended to the next candidate
 * boundary and retried; a frame that never decodes is a torn tail from a
 * writer mid-append and is skipped, not an error.
 */
export function decodeZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
    const offsets = [];
    for (let at = buffer.indexOf(ZSTD_MAGIC, 0); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + 4)) {
        offsets.push(at);
    }
    if (offsets.length === 0)
        return '';
    const parts = [];
    let cursor = 0;
    while (cursor < offsets.length) {
        const start = offsets[cursor];
        let decoded;
        let consumedThrough = cursor;
        for (let candidate = cursor + 1; candidate <= offsets.length; candidate += 1) {
            const end = candidate < offsets.length ? offsets[candidate] : buffer.length;
            try {
                decoded = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
                consumedThrough = candidate;
                break;
            }
            catch {
                // Either a false-positive magic inside this frame, or the frame is
                // still being written. Extend to the next boundary and retry.
                continue;
            }
        }
        if (decoded === undefined)
            break;
        parts.push(decoded);
        cursor = consumedThrough;
        if (parts.length >= maxFrames)
            break;
    }
    return parts.join('');
}
/** Epoch ms for an ISO timestamp, or undefined when unparseable. */
export function epochOf(value) {
    if (typeof value !== 'string')
        return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}
/** Collapse arbitrary message content into one line of text. */
export function flatten(value) {
    if (typeof value === 'string')
        return value.replace(/\s+/g, ' ').trim();
    if (Array.isArray(value)) {
        return value.map(item => flatten(item)).filter(part => part.length > 0).join(' ');
    }
    if (typeof value === 'object' && value !== null) {
        const record = value;
        if (typeof record['text'] === 'string')
            return flatten(record['text']);
        if (record['content'] !== undefined)
            return flatten(record['content']);
    }
    return '';
}
/** A numeric field of a record. */
export function numberAt(source, key) {
    const value = source?.[key];
    return typeof value === 'number' ? value : undefined;
}
/** A nested record field. */
export function recordAt(source, key) {
    const value = source?.[key];
    return typeof value === 'object' && value !== null ? value : undefined;
}
/** Compact a JSON argument string or object into a readable preview. */
export function previewArguments(raw) {
    if (typeof raw === 'object' && raw !== null) {
        return Object.entries(raw)
            .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    if (typeof raw !== 'string')
        return '';
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (!collapsed.startsWith('{'))
        return collapsed;
    try {
        return previewArguments(JSON.parse(collapsed));
    }
    catch {
        // Arguments a model emitted as invalid JSON still deserve a preview.
        return collapsed;
    }
}
