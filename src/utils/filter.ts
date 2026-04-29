/** 忽略各种 Unicode 空白后小写化（与主进程 SQLite 查询策略一致） */
export function normalize(s: string): string {
    if (!s) return '';
    return s.replace(/\s+/gu, '').toLowerCase();
}

export type SearchLogic = 'and' | 'or';

/** 搜索条件：由 UI 显式添加，不把单个输入里的空格拆成多个条件 */
export function normalizeSearchTerms(input: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of input) {
        const term = normalize(String(part || '').trim());
        if (!term || seen.has(term)) continue;
        seen.add(term);
        out.push(term);
    }
    return out;
}

export function matchesSearchTerms(src: string, terms: string[], logic: SearchLogic = 'and'): boolean {
    if (terms.length === 0) return true;
    const hay = normalize(src);
    return logic === 'or'
        ? terms.some((term) => hay.includes(term))
        : terms.every((term) => hay.includes(term));
}

/** 轻量 HTML 转义 */
export function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return c;
        }
    });
}

/**
 * 在 src 中高亮出现的关键字（大小写与空白不敏感，显示时保留原文）。
 * 策略：先对 src 计算 `normalized -> origIndex` 映射，在 normalized 里 indexOf，再把 match 区间映射回原字符串。
 */
export function highlight(src: string, keyword: string | string[]): string {
    const terms = normalizeSearchTerms(Array.isArray(keyword) ? keyword : [keyword]);
    if (terms.length === 0) return escapeHtml(src);

    const norm: string[] = [];
    const map: number[] = [];
    for (let i = 0; i < src.length; i++) {
        const c = src.charAt(i);
        if (!/\s/.test(c)) {
            norm.push(c.toLowerCase());
            map.push(i);
        }
    }
    const ns = norm.join('');
    const ranges: { start: number; end: number }[] = [];
    for (const k of terms) {
        let startPos = 0;
        while (true) {
            const found = ns.indexOf(k, startPos);
            if (found < 0) break;
            ranges.push({
                start: map[found],
                end: map[found + k.length - 1] + 1
            });
            startPos = found + k.length;
        }
    }
    if (ranges.length === 0) return escapeHtml(src);

    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: { start: number; end: number }[] = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r.start <= last.end) {
            last.end = Math.max(last.end, r.end);
        } else {
            merged.push({ ...r });
        }
    }

    let out = '';
    let lastOrig = 0;
    for (const r of merged) {
        out += escapeHtml(src.slice(lastOrig, r.start));
        out += '<mark class="highlight">' + escapeHtml(src.slice(r.start, r.end)) + '</mark>';
        lastOrig = r.end;
    }
    out += escapeHtml(src.slice(lastOrig));
    return out;
}

/** 主题是否符合 MQTT 通配符订阅（仅用于订阅列表匹配显示用） */
export function topicMatches(filter: string, topic: string): boolean {
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
        const seg = f[i];
        if (seg === '#') return true;
        if (seg === '+') {
            if (t[i] == null) return false;
            continue;
        }
        if (t[i] !== seg) return false;
    }
    return f.length === t.length;
}
