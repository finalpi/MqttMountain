<script setup lang="ts">
import { computed } from 'vue';
import { formatTime } from '@/utils/format';

defineOptions({ name: 'JsonTreeView' });

interface JsonChild {
    path: string;
    key: string;
    value: unknown;
}

interface TimestampHit {
    unit: 's' | 'ms';
    local: string;
    iso: string;
}

const props = withDefaults(defineProps<{
    value: unknown;
    path?: string;
    depth?: number;
    comma?: boolean;
    collapsedPaths: Set<string>;
}>(), {
    path: '$',
    depth: 0,
    comma: false
});

const emit = defineEmits<{
    toggle: [path: string];
}>();

function jsonType(value: unknown): 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null' {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value === 'object' ? 'object' : typeof value as 'string' | 'number' | 'boolean';
}

function childPath(parent: string, key: string, isArray: boolean): string {
    return isArray ? `${parent}[${key}]` : `${parent}.${encodeURIComponent(key)}`;
}

function primitiveText(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    return String(value);
}

function timestampToMs(value: unknown): { ms: number; unit: 's' | 'ms' } | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    const abs = String(Math.abs(value));
    if (abs.length === 10) return { ms: value * 1000, unit: 's' };
    if (abs.length === 13) return { ms: value, unit: 'ms' };
    return null;
}

function isReasonableTimestamp(ms: number): boolean {
    return ms >= Date.UTC(2000, 0, 1) && ms <= Date.UTC(2100, 0, 1);
}

const kind = computed(() => jsonType(props.value));
const isBranch = computed(() => kind.value === 'array' || kind.value === 'object');
const isCollapsed = computed(() => props.collapsedPaths.has(props.path));
const openMark = computed(() => kind.value === 'array' ? '[' : '{');
const closeMark = computed(() => kind.value === 'array' ? ']' : '}');

const children = computed<JsonChild[]>(() => {
    if (Array.isArray(props.value)) {
        return props.value.map((value, index) => ({
            path: childPath(props.path, String(index), true),
            key: String(index),
            value
        }));
    }
    if (props.value && typeof props.value === 'object') {
        return Object.entries(props.value as Record<string, unknown>).map(([key, value]) => ({
            path: childPath(props.path, key, false),
            key,
            value
        }));
    }
    return [];
});

const childCountText = computed(() => {
    const unit = kind.value === 'array' ? 'items' : 'keys';
    return `${children.value.length} ${unit}`;
});

const valueClass = computed(() => `json-${kind.value}`);
const timestamp = computed<TimestampHit | null>(() => {
    const converted = timestampToMs(props.value);
    if (!converted || !isReasonableTimestamp(converted.ms)) return null;
    return {
        unit: converted.unit,
        local: formatTime(converted.ms),
        iso: new Date(converted.ms).toISOString()
    };
});
</script>

<template>
    <div class="json-node">
        <div class="json-line" :style="{ paddingLeft: `${depth * 18}px` }">
            <button
                v-if="isBranch"
                class="json-toggle"
                type="button"
                :aria-label="isCollapsed ? '展开 JSON 节点' : '折叠 JSON 节点'"
                @click.stop="emit('toggle', path)"
            >
                {{ isCollapsed ? '▶' : '▼' }}
            </button>
            <span v-else class="json-toggle-spacer"></span>

            <span v-if="path !== '$' && !path.endsWith(']')" class="json-key">{{ JSON.stringify(decodeURIComponent(path.split('.').pop() || '')) }}</span>
            <span v-if="path !== '$' && !path.endsWith(']')" class="json-colon">: </span>

            <template v-if="isBranch">
                <span class="json-bracket">{{ openMark }}</span>
                <span v-if="isCollapsed" class="json-summary">{{ childCountText }}</span>
                <span v-if="isCollapsed" class="json-bracket">{{ closeMark }}</span>
            </template>
            <span v-else :class="[valueClass, { 'json-time': timestamp }]">
                {{ primitiveText(value) }}
                <span v-if="timestamp" class="time-pop">
                    <span>{{ timestamp.local }}</span>
                    <span>{{ timestamp.iso }}</span>
                    <span>{{ timestamp.unit === 'ms' ? 'millisecond timestamp' : 'second timestamp' }}</span>
                </span>
            </span>
            <span v-if="comma && (!isBranch || isCollapsed)" class="json-comma">,</span>
        </div>

        <template v-if="isBranch && !isCollapsed">
            <JsonTreeView
                v-for="(child, index) in children"
                :key="child.path"
                :value="child.value"
                :path="child.path"
                :depth="depth + 1"
                :comma="index < children.length - 1"
                :collapsed-paths="collapsedPaths"
                @toggle="emit('toggle', $event)"
            />
            <div class="json-line" :style="{ paddingLeft: `${depth * 18}px` }">
                <span class="json-toggle-spacer"></span>
                <span class="json-bracket">{{ closeMark }}</span>
                <span v-if="comma" class="json-comma">,</span>
            </div>
        </template>
    </div>
</template>
