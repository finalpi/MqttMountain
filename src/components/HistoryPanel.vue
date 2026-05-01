
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useToast } from '@/composables/useToast';
import { useFormatViewer } from '@/composables/useFormatViewer';
import { useMqttReplay, type ReplaySpeed } from '@/composables/useMqttReplay';
import type { HistoryMessage } from '@shared/types';
import { datetimeLocalToTs, formatTime, shortTime, tsToDatetimeLocal } from '@/utils/format';
import { exportMqttxJson, exportGroupedZip } from '@/utils/exporter';
import { parseReplayFile, replayRowsFromHistory, type ReplayMessage } from '@/utils/replay';
import { highlight, normalize, type SearchLogic } from '@/utils/filter';

const formatViewer = useFormatViewer();
const replay = useMqttReplay();
const conn = useConnectionStore();
const toast = useToast();

type KeywordJoin = SearchLogic | 'not';
interface KeywordCondition {
    term: string;
    join: KeywordJoin;
}

const startTime = ref<string>('');
const endTime = ref<string>('');
const keywordConditions = ref<KeywordCondition[]>([{ term: '', join: 'and' }]);
const scope = ref<'current' | 'all'>('current');
const rows = ref<HistoryMessage[]>([]);
const dataSource = ref<'history' | 'imported'>('history');
const selectedTopic = ref<string | null>(null);
const loading = ref(false);

const replayQos = ref<0 | 1 | 2>(0);
const replayRetain = ref(false);
const replaySpeed = ref<ReplaySpeed>('1x');
const replayLoop = ref(false);
const replayRewriteTimestamps = ref(false);
const importedRows = ref<ReplayMessage[]>([]);
const importedName = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

type TopicSort = 'name' | 'count' | 'recent';
const topicSort = ref<TopicSort>('name');

interface TopicGroup {
    topic: string;
    items: HistoryMessage[];
    lastTime: number;
}

const canReplayToMqtt = computed(() => Boolean(conn.selectedId) && conn.selectedState === 'connected');
const replaySourceRows = ref<HistoryMessage[]>([]);
const importedHistoryRows = computed<HistoryMessage[]>(() => importedRows.value.map((row) => ({
    connectionId: conn.selectedId || 'imported',
    topic: row.topic,
    payload: row.payload,
    time: row.time
})));
const replayPreviewRows = computed<HistoryMessage[]>(() => {
    if (!replay.state.running || replaySourceRows.value.length === 0) return [];
    const end = replay.state.currentIndex >= 0 ? Math.min(replay.state.currentIndex + 1, replaySourceRows.value.length) : 0;
    return replaySourceRows.value.slice(0, end);
});
const displayRows = computed<HistoryMessage[]>(() => {
    if (replay.state.running) return replayPreviewRows.value;
    return dataSource.value === 'imported' ? importedHistoryRows.value : rows.value;
});
const replayHint = computed(() => {
    if (!conn.selectedId) return '请先选择一个目标连接';
    if (conn.selectedState !== 'connected') return '目标连接需要处于已连接状态';
    return `将真实发布到当前连接：${conn.selected?.name || conn.selectedId}`;
});

const grouped = computed<TopicGroup[]>(() => {
    const m = new Map<string, { items: HistoryMessage[]; lastTime: number }>();
    for (const r of displayRows.value) {
        let g = m.get(r.topic);
        if (!g) {
            g = { items: [], lastTime: 0 };
            m.set(r.topic, g);
        }
        g.items.push(r);
        if (r.time > g.lastTime) g.lastTime = r.time;
    }
    const list: TopicGroup[] = [];
    for (const [topic, g] of m) list.push({ topic, items: g.items, lastTime: g.lastTime });
    switch (topicSort.value) {
        case 'count': list.sort((a, b) => b.items.length - a.items.length); break;
        case 'recent': list.sort((a, b) => b.lastTime - a.lastTime); break;
        case 'name':
        default: list.sort((a, b) => a.topic.localeCompare(b.topic)); break;
    }
    return list;
});

const detail = computed<HistoryMessage[]>(() => {
    if (!selectedTopic.value) return [];
    const matched = displayRows.value.filter((r) => r.topic === selectedTopic.value);
    return replay.state.running ? matched.slice().reverse() : matched;
});
const visibleCountLabel = computed(() => displayRows.value.length);
const dataSourceLabel = computed(() => {
    if (replay.state.running) return `回放预览：${replay.state.sourceName}`;
    return dataSource.value === 'imported' ? `导入数据：${importedName.value || '未命名文件'}` : '历史查询结果';
});

function matchesKeywordConditions(row: HistoryMessage): boolean {
    const active = keywordConditions.value
        .map((item) => ({ join: item.join, term: normalize(item.term.trim()) }))
        .filter((item) => item.term);
    if (active.length === 0) return true;
    const hay = normalize(row.topic + row.payload);
    let result = hay.includes(active[0].term);
    for (let i = 1; i < active.length; i++) {
        const item = active[i];
        const hit = hay.includes(item.term);
        if (item.join === 'or') result = result || hit;
        else if (item.join === 'not') result = result && !hit;
        else result = result && hit;
    }
    return result;
}

async function query(): Promise<void> {
    const st = datetimeLocalToTs(startTime.value);
    const et = datetimeLocalToTs(endTime.value);
    loading.value = true;
    const r = await window.api.historyQuery({
        connectionId: scope.value === 'current' ? conn.selectedId : null,
        startTime: st || undefined,
        endTime: et || undefined,
        limit: 500_000
    });
    loading.value = false;
    if (r.success && r.data) {
        rows.value = r.data.filter(matchesKeywordConditions);
        dataSource.value = 'history';
        selectedTopic.value = rows.value.length > 0 ? rows.value[0].topic : null;
        if (rows.value.length === 0) toast.info('无匹配结果');
        else toast.success(`找到 ${rows.value.length} 条`);
    } else {
        toast.error('查询失败：' + (r.message || ''));
    }
}

function addKeywordCondition(): void {
    keywordConditions.value.push({ term: '', join: 'and' });
}

function removeKeywordCondition(index: number): void {
    if (keywordConditions.value.length <= 1) {
        keywordConditions.value[0].term = '';
        keywordConditions.value[0].join = 'and';
        return;
    }
    keywordConditions.value.splice(index, 1);
}

let appStart = 0;
async function init(): Promise<void> {
    const r = await window.api.appGetStartTime();
    if (r.success && r.data) {
        appStart = r.data;
        startTime.value = tsToDatetimeLocal(r.data);
    }
    endTime.value = tsToDatetimeLocal(Date.now());
}

function setEndNow(): void {
    endTime.value = tsToDatetimeLocal(Date.now());
}

interface Quick {
    key: string;
    label: string;
    apply: () => void;
}

function startOfDay(ts: number): number {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

const quickRanges: Quick[] = [
    { key: '5m', label: '5 分钟', apply: () => setLast(5 * 60 * 1000) },
    { key: '15m', label: '15 分钟', apply: () => setLast(15 * 60 * 1000) },
    { key: '1h', label: '1 小时', apply: () => setLast(60 * 60 * 1000) },
    { key: '6h', label: '6 小时', apply: () => setLast(6 * 60 * 60 * 1000) },
    { key: '24h', label: '24 小时', apply: () => setLast(24 * 60 * 60 * 1000) },
    { key: '7d', label: '7 天', apply: () => setLast(7 * 24 * 60 * 60 * 1000) },
    { key: '30d', label: '30 天', apply: () => setLast(30 * 24 * 60 * 60 * 1000) },
    { key: 'today', label: '今天', apply: () => setRange(startOfDay(Date.now()), Date.now()) },
    {
        key: 'yesterday',
        label: '昨天',
        apply: () => {
            const todayStart = startOfDay(Date.now());
            setRange(todayStart - 86_400_000, todayStart - 1);
        }
    },
    {
        key: 'boot',
        label: '本次启动',
        apply: () => setRange(appStart || Date.now() - 3600_000, Date.now())
    },
    { key: 'all', label: '全部', apply: () => setRange(0, Date.now()) }
];
const activeQuick = ref<string>('boot');

function setLast(ms: number): void {
    const now = Date.now();
    setRange(now - ms, now);
}
function setRange(st: number, et: number): void {
    startTime.value = st > 0 ? tsToDatetimeLocal(st) : '';
    endTime.value = tsToDatetimeLocal(et);
}
function pickQuick(q: Quick): void {
    activeQuick.value = q.key;
    q.apply();
}

async function exportJson(): Promise<void> {
    if (!displayRows.value.length) { toast.warning('没有结果可导出'); return; }
    exportMqttxJson(displayRows.value, `history-${Date.now()}.json`);
    toast.success(`已导出 ${displayRows.value.length} 条`);
}
async function exportZip(): Promise<void> {
    if (!displayRows.value.length) { toast.warning('没有结果可导出'); return; }
    await exportGroupedZip(displayRows.value, `history-grouped-${Date.now()}.zip`);
    toast.success(`已导出 ${displayRows.value.length} 条`);
}

async function startReplayRows(sourceName: string, replayRows: ReplayMessage[]): Promise<void> {
    if (!conn.selectedId) {
        toast.error('请先选择目标连接');
        return;
    }
    if (conn.selectedState !== 'connected') {
        toast.error('目标连接未连接，无法真实重放');
        return;
    }
    if (!replayRows.length) {
        toast.warning('没有可回放的数据');
        return;
    }
    try {
        replaySourceRows.value = replayRows.map((row) => ({
            connectionId: conn.selectedId || 'replay',
            topic: row.topic,
            payload: row.payload,
            time: row.time
        }));
        selectedTopic.value = replaySourceRows.value[0]?.topic ?? null;
        await replay.start(sourceName, {
            connectionId: conn.selectedId,
            rows: replayRows,
            speed: replaySpeed.value,
            loop: replayLoop.value,
            timestampRewrite: replayRewriteTimestamps.value ? 'on' : 'off'
        });
    } catch (error) {
        toast.error((error as Error).message || '回放启动失败');
    }
}

async function replayHistoryRows(): Promise<void> {
    await startReplayRows('历史查询结果', replayRowsFromHistory(rows.value, replayQos.value, replayRetain.value));
}

function openImport(): void {
    fileInput.value?.click();
}

async function onImportChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
        importedRows.value = await parseReplayFile(file);
        importedName.value = file.name;
        dataSource.value = 'imported';
        selectedTopic.value = importedHistoryRows.value[0]?.topic ?? null;
        toast.success(`已导入 ${importedRows.value.length} 条回放数据`);
    } catch (error) {
        importedRows.value = [];
        importedName.value = '';
        toast.error((error as Error).message || '导入失败');
    } finally {
        input.value = '';
    }
}

async function replayImportedRows(): Promise<void> {
    await startReplayRows(importedName.value || '导入文件', importedRows.value);
}

async function replayPreferredRows(): Promise<void> {
    if (dataSource.value === 'imported' && importedRows.value.length) {
        await replayImportedRows();
        return;
    }
    await replayHistoryRows();
}

onMounted(init);

watch(
    () => replay.state.running,
    (running) => {
        if (running) return;
        replaySourceRows.value = [];
        const sourceRows = dataSource.value === 'imported' ? importedHistoryRows.value : rows.value;
        selectedTopic.value = sourceRows[0]?.topic ?? null;
    }
);
</script>

<template>
    <section class="panel">
        <div class="panel-head">
            <h2>历史查询</h2>
            <span class="spacer"></span>
            <button v-if="displayRows.length" class="btn btn-mini" @click="exportJson" title="导出完整 JSON">导出 JSON</button>
            <button v-if="displayRows.length" class="btn btn-mini" @click="exportZip" title="按主题分组 ZIP">导出 ZIP</button>
        </div>
        <div class="panel-body">
            <div class="controls">
                <div class="controls-main">
                    <div class="field">
                        <label>开始时间</label>
                        <input type="datetime-local" step="1" v-model="startTime" @input="activeQuick = ''" @keydown.enter="query" />
                    </div>
                    <div class="field">
                        <label>结束时间</label>
                        <div class="inline">
                            <input type="datetime-local" step="1" v-model="endTime" @input="activeQuick = ''" @keydown.enter="query" />
                            <button class="btn btn-mini" @click="setEndNow(); activeQuick = ''">当前</button>
                        </div>
                    </div>
                    <div class="field">
                        <label>连接范围</label>
                        <select v-model="scope" @keydown.enter="query">
                            <option value="current">当前连接</option>
                            <option value="all">全部连接</option>
                        </select>
                    </div>
                    <button class="btn btn-primary query-btn" :disabled="loading" @click="query">
                        {{ loading ? '查询中...' : '查询' }}
                    </button>
                </div>
                <div class="field keyword-field">
                    <label>关键字</label>
                    <div class="filter-builder">
                        <div class="logic-anchor">条件</div>
                        <div class="filter-conditions">
                            <div v-for="(item, index) in keywordConditions" :key="index" class="filter-condition">
                                <span v-if="index === 0" class="condition-index">条件 1</span>
                                <div v-else class="logic-segment" role="tablist" :aria-label="`条件 ${index + 1} 逻辑`">
                                    <button class="seg-btn" :class="{ active: item.join === 'and' }" @click="item.join = 'and'">且</button>
                                    <button class="seg-btn" :class="{ active: item.join === 'or' }" @click="item.join = 'or'">或</button>
                                    <button class="seg-btn" :class="{ active: item.join === 'not' }" @click="item.join = 'not'">非</button>
                                </div>
                                <input v-model="item.term" placeholder="主题或内容" @keydown.enter="query" />
                                <button class="condition-btn" title="删除条件" @click="removeKeywordCondition(index)">×</button>
                            </div>
                        </div>
                        <button class="condition-add" title="添加过滤条件" @click="addKeywordCondition">+ 添加条件</button>
                    </div>
                </div>
            </div>
            <div class="quick-bar">
                <span class="quick-label">快速选择</span>
                <button
                    v-for="q in quickRanges"
                    :key="q.key"
                    class="chip"
                    :class="{ active: activeQuick === q.key }"
                    @click="pickQuick(q)"
                >{{ q.label }}</button>
            </div>

            <div class="replay-panel">
                <div class="replay-head">
                    <strong>真实 MQTT 重放</strong>
                    <span class="replay-hint">{{ replayHint }}</span>
                </div>
                <div class="replay-grid">
                    <div class="field small">
                        <label>QoS</label>
                        <select v-model.number="replayQos">
                            <option :value="0">0</option>
                            <option :value="1">1</option>
                            <option :value="2">2</option>
                        </select>
                    </div>
                    <div class="field small">
                        <label>Retain</label>
                        <select :value="replayRetain ? 'true' : 'false'" @change="replayRetain = ($event.target as HTMLSelectElement).value === 'true'">
                            <option value="false">false</option>
                            <option value="true">true</option>
                        </select>
                    </div>
                    <div class="field small">
                        <label>节奏</label>
                        <select v-model="replaySpeed">
                            <option value="instant">立即发送</option>
                            <option value="10x">10x</option>
                            <option value="5x">5x</option>
                            <option value="2x">2x</option>
                            <option value="1x">1x</option>
                        </select>
                    </div>
                    <div class="replay-toggle-group">
                        <div
                            class="replay-switch-row"
                        >
                            <span class="replay-switch-label">
                                时间戳→当前
                                <span
                                    class="help-dot"
                                    title="仅对合法 JSON 生效：把 payload 里像 Unix 时间戳的数字改成发送当下的时间。毫秒级(≥1e12)改为当前毫秒，秒级(1e9~1e12)改为当前秒。"
                                >?</span>
                            </span>
                            <label class="switch" :title="replayRewriteTimestamps ? '已开启' : '已关闭'">
                                <input v-model="replayRewriteTimestamps" type="checkbox" />
                                <span class="slider" :class="{ on: replayRewriteTimestamps }"></span>
                            </label>
                        </div>
                        <div class="replay-switch-row" title="到最后一条后重新从头开始，直到手动停止">
                            <span class="replay-switch-label">循环播放</span>
                            <label class="switch" :title="replayLoop ? '已开启' : '已关闭'">
                                <input v-model="replayLoop" type="checkbox" />
                                <span class="slider" :class="{ on: replayLoop }"></span>
                            </label>
                        </div>
                    </div>
                    <div class="replay-actions">
                        <button class="btn" :disabled="replay.state.running" @click="openImport">导入文件</button>
                        <button
                            class="btn btn-primary replay-start"
                            :disabled="(!rows.length && !importedRows.length) || !canReplayToMqtt || replay.state.running"
                            @click="replayPreferredRows"
                        >开始重放</button>
                        <button class="btn btn-warning" :disabled="!replay.state.running" @click="replay.togglePause()">
                            {{ replay.state.paused ? '继续' : '暂停' }}
                        </button>
                        <button class="btn btn-danger" :disabled="!replay.state.running" @click="replay.stop()">停止</button>
                    </div>
                    <input ref="fileInput" type="file" accept=".json,.jsonl,.zip" class="hidden-file" @change="onImportChange" />
                </div>
                <div class="replay-meta">
                    <span>{{ dataSourceLabel }} / {{ visibleCountLabel }} 条</span>
                    <span v-if="replay.state.paused" class="replay-paused">已暂停</span>
                    <span v-if="replay.state.running">运行中：第 {{ replay.state.rounds }} 轮，已发送 {{ replay.state.sent }} 条，本轮总数 {{ replay.state.total }}，失败 {{ replay.state.failed }}</span>
                    <span v-else-if="replay.state.total">上次任务：{{ replay.state.sourceName }}，共发送 {{ replay.state.sent }} 条，本轮基数 {{ replay.state.total }}</span>
                    <span v-if="replay.state.lastError" class="replay-error">最近错误：{{ replay.state.lastError }}</span>
                </div>
            </div>

            <div v-if="displayRows.length === 0" class="empty">
                <div v-if="loading">查询中，请稍候...</div>
                <div v-else>设置时间范围和关键字后点击“查询”，或导入回放文件</div>
            </div>

            <div v-else class="split">
                <div class="topic-list">
                    <div class="t-head">
                        <span>主题（{{ grouped.length }}）</span>
                        <select class="sort-select" v-model="topicSort" title="排序方式">
                            <option value="name">主题名</option>
                            <option value="recent">最近活跃</option>
                            <option value="count">消息量</option>
                        </select>
                    </div>
                    <div class="scroll-area">
                        <div class="t-list">
                            <div
                                v-for="g in grouped"
                                :key="g.topic"
                                class="t-item"
                                :class="{ active: selectedTopic === g.topic }"
                                @click="selectedTopic = g.topic"
                            >
                                <div class="t-name" v-html="highlight(g.topic, keywordConditions.map((item) => item.term))"></div>
                                <div class="t-meta">
                                    <span class="count">{{ g.items.length }} 条</span>
                                    <span class="ago">{{ shortTime(g.lastTime) }}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="topic-detail">
                    <div class="t-head">
                        <template v-if="selectedTopic">
                            <span class="t-head-name" :title="selectedTopic">{{ selectedTopic }}</span>
                            <span class="t-head-count">{{ detail.length }} 条</span>
                        </template>
                        <span v-else class="sub-empty">请从左侧选择主题</span>
                    </div>
                    <div v-if="selectedTopic" class="scroll-area">
                        <div v-if="detail.length === 0" class="empty small">该主题无匹配消息</div>
                        <div v-else class="msg-list">
                            <div
                                v-for="m in detail"
                                :key="m.topic + '|' + m.time + '|' + m.payload.length"
                                class="msg-card cv-auto"
                                @contextmenu.prevent="formatViewer.open({ topic: m.topic, time: m.time, raw: m.payload })"
                            >
                                <div class="msg-head">
                                    <span class="time">{{ formatTime(m.time) }}</span>
                                    <span class="msg-hint">右键格式化</span>
                                </div>
                                <pre class="msg-body" v-html="highlight(m.payload, keywordConditions.map((item) => item.term))"></pre>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>
</template>

<style lang="scss" scoped>
.panel-body {
    min-height: 0;
}

.controls {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-bottom: 6px;
}

.controls-main {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) minmax(220px, 1fr) minmax(140px, 180px) auto;
    gap: 8px;
    align-items: end;

    .inline {
        display: flex;
        gap: 4px;
        align-items: center;
        input {
            flex: 1;
            min-width: 0;
        }
    }

    .query-btn {
        align-self: end;
        height: 34px;
        padding: 0 18px;
    }

    .keyword-field {
        min-width: 0;
    }
}

.filter-builder {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
}

.logic-anchor {
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 58px;
    padding: 0 10px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 700;
}

.filter-conditions {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 6px;
    align-items: stretch;
    flex-wrap: wrap;
}

.filter-condition {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
    min-width: 240px;
    max-width: 360px;
    flex: 1 1 280px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.02);

    input {
        min-width: 0;
    }
}

.condition-index {
    color: var(--text-3);
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
    padding: 0 8px;
}

.logic-segment {
    display: inline-flex;
    align-items: center;
    padding: 2px;
    height: 34px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
}

.seg-btn {
    min-width: 34px;
    height: 28px;
    padding: 0 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    line-height: 28px;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;

    &:hover {
        color: var(--text-0);
    }

    &.active {
        background: rgba(124, 92, 255, 0.28);
        color: #fff;
    }
}

.filter-condition input {
    height: 34px;
    padding: 0 12px;
}

.condition-btn,
.condition-add {
    height: 34px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--input-bg);
    color: var(--text-2);
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;

    &:hover {
        color: var(--text-0);
        border-color: var(--border-strong);
    }
}

.condition-btn {
    width: 30px;
}

.condition-add {
    padding: 0 10px;
    align-self: start;
}

@media (max-width: 1200px) {
    .controls-main {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        .query-btn {
            grid-column: 1 / -1;
        }
    }

    .filter-builder {
        grid-template-columns: 1fr;
        align-items: stretch;
    }

    .condition-add {
        justify-self: start;
    }
}

@media (max-width: 760px) {
    .controls-main {
        grid-template-columns: 1fr;
    }
}

.quick-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 4px 2px 8px;
    border-bottom: 1px dashed var(--border);
    margin-bottom: 10px;

    .quick-label {
        font-size: 11px;
        color: var(--text-3);
        margin-right: 2px;
    }

    .chip {
        background: var(--input-bg);
        border: 1px solid var(--border);
        color: var(--text-2);
        font-size: 11px;
        font-family: inherit;
        padding: 3px 10px;
        border-radius: 999px;
        cursor: pointer;

        &:hover {
            background: var(--card-hover-bg);
            color: var(--text-0);
            border-color: var(--border-strong);
        }
        &.active {
            background: rgba(124, 92, 255, 0.28);
            border-color: rgba(124, 92, 255, 0.55);
            color: #fff;
        }
    }
}

.replay-panel {
    margin-bottom: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel-body-bg);
}

.replay-head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
    margin-bottom: 8px;
}

.replay-hint {
    color: var(--text-3);
    font-size: 12px;
}

.replay-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: end;
}

.replay-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-left: auto;
}

.field.small {
    min-width: 110px;
}

.replay-toggle-group {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}

.replay-switch-row {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--input-bg);
}

.replay-grid > .btn {
    min-width: 120px;
}

.replay-start {
    min-width: 132px;
    font-weight: 700;
    text-align: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.replay-switch-label {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-2);
    white-space: nowrap;
}

.help-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    margin-left: 4px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    color: var(--text-2);
    font-size: 10px;
    line-height: 1;
    cursor: help;
}

.replay-switch-row .switch {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    user-select: none;

    input {
        display: none;
    }

    .slider {
        width: 36px;
        height: 20px;
        border-radius: 999px;
        background: var(--border-strong);
        position: relative;
        transition: background 0.15s;

        &::after {
            content: '';
            position: absolute;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #fff;
            top: 2px;
            left: 2px;
            transition: left 0.15s;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
        }

        &.on {
            background: linear-gradient(135deg, #7c5cff, #5b8def);

            &::after {
                left: 18px;
            }
        }
    }
}

.hidden-file {
    display: none;
}

.replay-meta {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 8px;
    color: var(--text-2);
    font-size: 12px;
    padding-top: 8px;
    border-top: 1px dashed var(--border);
}

.replay-error {
    color: #fca5a5;
}

.replay-paused {
    color: #fcd34d;
    font-weight: 700;
}

.split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(240px, 0.42fr) 1fr;
    gap: 12px;
}

.topic-list,
.topic-detail {
    background: var(--panel-body-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.t-head {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-2);
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex: 0 0 auto;
}
.t-head-name {
    flex: 1;
    min-width: 0;
    color: var(--accent-2);
    font-family: 'JetBrains Mono', Consolas, monospace;
    user-select: text;
    cursor: text;
    word-break: break-all;
    line-height: 1.4;
}
.t-head-count {
    flex: 0 0 auto;
    font-weight: 400;
    color: var(--text-3);
    font-size: 11px;
}

.sort-select {
    background: var(--input-bg);
    border: 1px solid var(--border);
    color: var(--text-1);
    border-radius: 6px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
    &:focus {
        border-color: var(--accent);
    }
}

.sub-empty {
    color: var(--text-3);
    font-weight: 400;
}

.scroll-area {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
}

.cv-auto {
    content-visibility: auto;
    contain-intrinsic-size: auto 80px;
}

.t-list {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.t-item {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card-bg);
    cursor: pointer;

    &:hover {
        background: var(--card-hover-bg);
        border-color: var(--border-strong);
    }
    &.active {
        background: rgba(124, 92, 255, 0.2);
        border-color: rgba(124, 92, 255, 0.55);
    }
    &.replaying {
        border-color: rgba(16, 185, 129, 0.45);
        box-shadow: inset 0 0 0 1px rgba(16, 185, 129, 0.18);
    }

    .t-name {
        font-size: var(--fs-msg-topic);
        font-family: 'JetBrains Mono', Consolas, monospace;
        color: var(--text-0);
        line-height: 1.45;
        word-break: break-all;
        user-select: text;
        cursor: text;
    }
    .t-meta {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--text-3);
        margin-top: 4px;
        .count {
            color: var(--accent-2);
            font-weight: 600;
        }
        .ago {
            font-family: 'JetBrains Mono', Consolas, monospace;
        }
    }
}

.msg-list {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.msg-card {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card-bg);
    user-select: text;
    cursor: text;

    &:hover {
        border-color: var(--border-strong);
        background: var(--card-hover-bg);
    }
    &.replaying {
        border-color: rgba(16, 185, 129, 0.55);
        background: rgba(16, 185, 129, 0.08);
        box-shadow: inset 0 0 0 1px rgba(16, 185, 129, 0.18);
    }

    .msg-head {
        font-size: var(--fs-msg-meta);
        display: flex;
        align-items: baseline;
        gap: 10px;

        .time {
            color: var(--text-3);
            font-family: 'JetBrains Mono', Consolas, monospace;
        }
        .msg-hint {
            margin-left: auto;
            color: var(--text-3);
            font-size: 10px;
            opacity: 0;
            transition: opacity 0.15s;
            user-select: none;
        }
    }
    &:hover .msg-head .msg-hint {
        opacity: 0.7;
    }
    .msg-body {
        margin: 4px 0 0;
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-size: var(--fs-msg);
        color: var(--text-1);
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-all;
        background: transparent;
        padding: 0;
    }
}

.empty {
    color: var(--text-3);
    font-size: 12px;
    text-align: center;
    padding: 40px 20px;

    &.small {
        padding: 16px 10px;
    }
}
</style>
