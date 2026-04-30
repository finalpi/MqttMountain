
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useConnectionStore } from '@/stores/connection';
import { useToast } from '@/composables/useToast';
import { useFormatViewer } from '@/composables/useFormatViewer';
import { useMqttReplay, type ReplaySpeed } from '@/composables/useMqttReplay';
import type { HistoryMessage } from '@shared/types';
import { datetimeLocalToTs, formatTime, shortTime, tsToDatetimeLocal } from '@/utils/format';
import { exportMqttxJson, exportGroupedZip } from '@/utils/exporter';
import { parseReplayFile, replayRowsFromHistory, type ReplayMessage } from '@/utils/replay';
import { highlight, type SearchLogic } from '@/utils/filter';

const formatViewer = useFormatViewer();
const replay = useMqttReplay();
const conn = useConnectionStore();
const toast = useToast();

const startTime = ref<string>('');
const endTime = ref<string>('');
const keywordInputs = ref<string[]>(['']);
const keywordLogic = ref<SearchLogic>('and');
const scope = ref<'current' | 'all'>('current');
const rows = ref<HistoryMessage[]>([]);
const selectedTopic = ref<string | null>(null);
const loading = ref(false);

const replayQos = ref<0 | 1 | 2>(0);
const replayRetain = ref(false);
const replaySpeed = ref<ReplaySpeed>('10x');
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
const replayHint = computed(() => {
    if (!conn.selectedId) return '请先选择一个目标连接';
    if (conn.selectedState !== 'connected') return '目标连接需要处于已连接状态';
    return `将真实发布到当前连接：${conn.selected?.name || conn.selectedId}`;
});

const grouped = computed<TopicGroup[]>(() => {
    const m = new Map<string, { items: HistoryMessage[]; lastTime: number }>();
    for (const r of rows.value) {
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
    return rows.value.filter((r) => r.topic === selectedTopic.value);
});

async function query(): Promise<void> {
    const st = datetimeLocalToTs(startTime.value);
    const et = datetimeLocalToTs(endTime.value);
    const keywords = keywordInputs.value.map((v) => v.trim()).filter(Boolean);
    loading.value = true;
    const r = await window.api.historyQuery({
        connectionId: scope.value === 'current' ? conn.selectedId : null,
        startTime: st || undefined,
        endTime: et || undefined,
        keyword: keywords[0] || undefined,
        keywords: keywords.length ? keywords : undefined,
        keywordLogic: keywordLogic.value,
        limit: 500_000
    });
    loading.value = false;
    if (r.success && r.data) {
        rows.value = r.data;
        selectedTopic.value = r.data.length > 0 ? r.data[0].topic : null;
        if (rows.value.length === 0) toast.info('无匹配结果');
        else toast.success(`找到 ${rows.value.length} 条`);
    } else {
        toast.error('查询失败：' + (r.message || ''));
    }
}

function addKeywordCondition(): void {
    keywordInputs.value.push('');
}

function removeKeywordCondition(index: number): void {
    if (keywordInputs.value.length <= 1) {
        keywordInputs.value[0] = '';
        return;
    }
    keywordInputs.value.splice(index, 1);
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
    if (!rows.value.length) { toast.warning('没有结果可导出'); return; }
    exportMqttxJson(rows.value, `history-${Date.now()}.json`);
    toast.success(`已导出 ${rows.value.length} 条`);
}
async function exportZip(): Promise<void> {
    if (!rows.value.length) { toast.warning('没有结果可导出'); return; }
    await exportGroupedZip(rows.value, `history-grouped-${Date.now()}.zip`);
    toast.success(`已导出 ${rows.value.length} 条`);
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
        await replay.start(sourceName, {
            connectionId: conn.selectedId,
            rows: replayRows,
            speed: replaySpeed.value,
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

onMounted(init);
</script>

<template>
    <section class="panel">
        <div class="panel-head">
            <h2>历史查询</h2>
            <span class="spacer"></span>
            <button v-if="rows.length" class="btn btn-mini" @click="exportJson" title="导出完整 JSON">导出 JSON</button>
            <button v-if="rows.length" class="btn btn-mini" @click="exportZip" title="按主题分组 ZIP">导出 ZIP</button>
        </div>
        <div class="panel-body">
            <div class="controls">
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
                <div class="field keyword-field">
                    <label>关键字</label>
                    <div class="filter-builder">
                        <div class="logic-toggle">
                            <button class="tgl" :class="{ active: keywordLogic === 'and' }" @click="keywordLogic = 'and'">且</button>
                            <button class="tgl" :class="{ active: keywordLogic === 'or' }" @click="keywordLogic = 'or'">或</button>
                        </div>
                        <div class="filter-conditions">
                            <div v-for="(_, index) in keywordInputs" :key="index" class="filter-condition">
                                <span v-if="index > 0" class="logic-label">{{ keywordLogic === 'and' ? '且' : '或' }}</span>
                                <input v-model="keywordInputs[index]" placeholder="主题或内容" @keydown.enter="query" />
                                <button class="condition-btn" title="删除条件" @click="removeKeywordCondition(index)">x</button>
                            </div>
                            <button class="condition-add" title="添加过滤条件" @click="addKeywordCondition">+ 条件</button>
                        </div>
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
                <div class="replay-controls">
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
                    <div
                        class="replay-switch-row"
                        title="仅对合法 JSON：毫秒级(≥1e12)→当前毫秒；秒级(1e9~1e12)→当前秒"
                    >
                        <span class="replay-switch-label">时间戳→当前</span>
                        <label class="switch" :title="replayRewriteTimestamps ? '已开启' : '已关闭'">
                            <input v-model="replayRewriteTimestamps" type="checkbox" />
                            <span class="slider" :class="{ on: replayRewriteTimestamps }"></span>
                        </label>
                    </div>
                    <button class="btn" :disabled="!rows.length || !canReplayToMqtt || replay.state.running" @click="replayHistoryRows">重放查询结果</button>
                    <button class="btn" :disabled="replay.state.running" @click="openImport">导入文件</button>
                    <button class="btn" :disabled="!importedRows.length || !canReplayToMqtt || replay.state.running" @click="replayImportedRows">重放导入数据</button>
                    <button class="btn btn-danger" :disabled="!replay.state.running" @click="replay.stop()">停止</button>
                    <input ref="fileInput" type="file" accept=".json,.jsonl,.zip" class="hidden-file" @change="onImportChange" />
                </div>
                <div class="replay-meta">
                    <span v-if="importedRows.length">已导入：{{ importedName }} / {{ importedRows.length }} 条</span>
                    <span v-if="replay.state.running">运行中：{{ replay.state.sent }}/{{ replay.state.total }}，失败 {{ replay.state.failed }}</span>
                    <span v-else-if="replay.state.total">上次任务：{{ replay.state.sourceName }}，成功 {{ replay.state.sent }} / {{ replay.state.total }}</span>
                    <span v-if="replay.state.lastError" class="replay-error">最近错误：{{ replay.state.lastError }}</span>
                </div>
            </div>

            <div v-if="rows.length === 0" class="empty">
                <div v-if="loading">查询中，请稍候...</div>
                <div v-else>设置时间范围和关键字后点击“查询”</div>
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
                                <div class="t-name" v-html="highlight(g.topic, keywordInputs)"></div>
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
                                :key="m.time + '|' + m.payload.length"
                                class="msg-card cv-auto"
                                @contextmenu.prevent="formatViewer.open({ topic: m.topic, time: m.time, raw: m.payload })"
                            >
                                <div class="msg-head">
                                    <span class="time">{{ formatTime(m.time) }}</span>
                                    <span class="msg-hint">右键格式化</span>
                                </div>
                                <pre class="msg-body" v-html="highlight(m.payload, keywordInputs)"></pre>
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
    display: grid;
    grid-template-columns: repeat(4, minmax(150px, 1fr)) auto;
    gap: 8px;
    align-items: end;
    padding-bottom: 6px;

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
        grid-column: span 2;
    }
}

.filter-builder {
    display: flex;
    gap: 8px;
    align-items: flex-start;
}

.logic-toggle {
    display: inline-flex;
    flex: 0 0 auto;
    padding: 2px;
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 8px;

    .tgl {
        background: transparent;
        border: none;
        color: var(--text-2);
        font-size: 12px;
        padding: 5px 9px;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;

        &.active {
            background: rgba(124, 92, 255, 0.28);
            color: #fff;
        }
    }
}

.filter-conditions {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
}

.filter-condition {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 210px;
    flex: 1 1 240px;

    input {
        min-width: 0;
    }
}
.logic-label {
    color: var(--text-3);
    font-size: 12px;
    white-space: nowrap;
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
}

@media (max-width: 1200px) {
    .controls {
        grid-template-columns: repeat(2, 1fr);
        .query-btn {
            grid-column: 1 / -1;
        }
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

.replay-controls {
    display: flex;
    gap: 8px;
    align-items: end;
    flex-wrap: wrap;
}

.field.small {
    min-width: 110px;
}

.replay-switch-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 2px;
}

.replay-switch-label {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-2);
    white-space: nowrap;
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
}

.replay-error {
    color: #fca5a5;
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
