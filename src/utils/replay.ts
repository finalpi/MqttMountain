import JSZip from 'jszip';
import type { HistoryMessage } from '@shared/types';

export interface ReplayMessage {
    topic: string;
    payload: string;
    time: number;
    qos: 0 | 1 | 2;
    retain: boolean;
}

/** 回放时是否把 payload 里形似 Unix 时间的数字改为「当前时刻」（秒形→当前秒，毫秒形→当前毫秒） */
export type ReplayTimestampRewrite = 'off' | 'on';

/** 形似毫秒级 Unix 时间 → 当前毫秒；形似秒级 → 当前秒；否则不替换 */
function replaceLikelyUnixEpoch(n: number): number | null {
    if (!Number.isFinite(n)) return null;
    const x = Math.abs(n);
    if (x >= 1e12 && x < 1e15) return Date.now();
    if (x >= 1e9 && x < 1e12) return Math.floor(Date.now() / 1000);
    return null;
}

/**
 * 对 JSON payload 深度遍历：形似 Unix 毫秒(≥1e12)的数字替换为 Date.now()；
 * 形似 Unix 秒(1e9~1e12)的数字替换为 floor(Date.now()/1000)。非 JSON 则原样返回。
 */
export function rewriteReplayPayloadTimestamps(payload: string, mode: ReplayTimestampRewrite): string {
    if (mode === 'off' || !payload.trim()) return payload;
    try {
        const root = JSON.parse(payload) as unknown;
        if (typeof root !== 'object' || root === null) return payload;
        const rewrite = (value: unknown): void => {
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    const el = value[i];
                    if (typeof el === 'number') {
                        const next = replaceLikelyUnixEpoch(el);
                        if (next !== null) value[i] = next;
                        else rewrite(el);
                    } else {
                        rewrite(el);
                    }
                }
                return;
            }
            if (value && typeof value === 'object') {
                const o = value as Record<string, unknown>;
                for (const k of Object.keys(o)) {
                    const el = o[k];
                    if (typeof el === 'number') {
                        const next = replaceLikelyUnixEpoch(el);
                        if (next !== null) o[k] = next;
                        else rewrite(el);
                    } else {
                        rewrite(el);
                    }
                }
            }
        };
        rewrite(root);
        return JSON.stringify(root);
    } catch {
        return payload;
    }
}

interface LooseRow {
    topic?: unknown;
    Topic?: unknown;
    payload?: unknown;
    Payload?: unknown;
    time?: unknown;
    createAt?: unknown;
    qos?: unknown;
    QoS?: unknown;
    retain?: unknown;
    Retain?: unknown;
}

function toNumber(value: unknown, fallback: number): number {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

function toQos(value: unknown): 0 | 1 | 2 {
    const next = Number(value);
    return next === 1 || next === 2 ? next : 0;
}

function toBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
    return Boolean(value);
}

function normalizeReplayRow(raw: LooseRow, fallbackTime: number): ReplayMessage | null {
    const topic = String(raw.topic ?? raw.Topic ?? '').trim();
    if (!topic) return null;
    const payload = String(raw.payload ?? raw.Payload ?? '');
    const time = toNumber(raw.time ?? raw.createAt, fallbackTime);
    return {
        topic,
        payload,
        time,
        qos: toQos(raw.qos ?? raw.QoS),
        retain: toBoolean(raw.retain ?? raw.Retain)
    };
}

function sortRows(rows: ReplayMessage[]): ReplayMessage[] {
    return rows.slice().sort((a, b) => a.time - b.time);
}

export function replayRowsFromHistory(rows: HistoryMessage[], qos: 0 | 1 | 2, retain: boolean): ReplayMessage[] {
    return sortRows(rows.map((row) => ({
        topic: row.topic,
        payload: row.payload,
        time: row.time,
        qos,
        retain
    })));
}

export function parseReplayJsonText(text: string): ReplayMessage[] {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
        throw new Error('JSON 文件必须是数组');
    }
    const base = Date.now();
    const rows = parsed
        .map((item, index) => normalizeReplayRow((item ?? {}) as LooseRow, base + index))
        .filter((item): item is ReplayMessage => Boolean(item));
    if (!rows.length) throw new Error('没有识别到可回放的消息');
    return sortRows(rows);
}

export function parseReplayJsonlText(text: string, sourceName = 'JSONL'): ReplayMessage[] {
    const lines = text
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    const base = Date.now();
    const rows: ReplayMessage[] = [];
    for (let i = 0; i < lines.length; i++) {
        try {
            const parsed = JSON.parse(lines[i]) as LooseRow;
            const row = normalizeReplayRow(parsed, base + i);
            if (row) rows.push(row);
        } catch {
            throw new Error(`${sourceName} 第 ${i + 1} 行不是合法 JSON`);
        }
    }
    if (!rows.length) throw new Error('没有识别到可回放的消息');
    return sortRows(rows);
}

export async function parseReplayZipFile(file: File): Promise<ReplayMessage[]> {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const rows: ReplayMessage[] = [];
    const tasks: Array<Promise<void>> = [];
    zip.forEach((relativePath, entry) => {
        if (entry.dir) return;
        const name = relativePath.toLowerCase();
        if (!name.endsWith('.jsonl') && !name.endsWith('.json')) return;
        tasks.push((async () => {
            const text = await entry.async('text');
            const parsed = name.endsWith('.jsonl')
                ? parseReplayJsonlText(text, relativePath)
                : parseReplayJsonText(text);
            rows.push(...parsed);
        })());
    });
    await Promise.all(tasks);
    if (!rows.length) throw new Error('ZIP 中没有找到可回放的 JSON/JSONL 数据');
    return sortRows(rows);
}

export async function parseReplayFile(file: File): Promise<ReplayMessage[]> {
    const name = file.name.toLowerCase();
    if (name.endsWith('.zip')) return parseReplayZipFile(file);
    const text = await file.text();
    if (name.endsWith('.jsonl')) return parseReplayJsonlText(text, file.name);
    if (name.endsWith('.json')) return parseReplayJsonText(text);
    throw new Error('仅支持 .json / .jsonl / .zip 文件');
}
