import { reactive, readonly } from 'vue';
import { useToast } from '@/composables/useToast';
import { rewriteReplayPayloadTimestamps, type ReplayMessage, type ReplayTimestampRewrite } from '@/utils/replay';

export type ReplaySpeed = 'instant' | '1x' | '2x' | '5x' | '10x';

export interface ReplayRunOptions {
    connectionId: string;
    rows: ReplayMessage[];
    speed: ReplaySpeed;
    /** 将每条 JSON payload 内形似 Unix 时间的数字改为当前时间（毫秒或秒） */
    timestampRewrite?: ReplayTimestampRewrite;
}

interface ReplayState {
    running: boolean;
    connectionId: string | null;
    sourceName: string;
    total: number;
    sent: number;
    failed: number;
    startedAt: number;
    lastError: string;
    stopRequested: boolean;
}

const state = reactive<ReplayState>({
    running: false,
    connectionId: null,
    sourceName: '',
    total: 0,
    sent: 0,
    failed: 0,
    startedAt: 0,
    lastError: '',
    stopRequested: false
});

const speedMap: Record<ReplaySpeed, number> = {
    instant: 0,
    '1x': 1,
    '2x': 2,
    '5x': 5,
    '10x': 10
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForDelta(prev: ReplayMessage, next: ReplayMessage, speed: ReplaySpeed): Promise<void> {
    const factor = speedMap[speed];
    if (factor <= 0) return;
    const delta = Math.max(0, next.time - prev.time);
    if (delta <= 0) return;
    await sleep(Math.min(60_000, Math.round(delta / factor)));
}

export function useMqttReplay() {
    const toast = useToast();

    async function start(sourceName: string, options: ReplayRunOptions): Promise<void> {
        if (state.running) throw new Error('已有回放任务正在运行');
        if (!options.rows.length) throw new Error('没有可回放的数据');

        state.running = true;
        state.connectionId = options.connectionId;
        state.sourceName = sourceName;
        state.total = options.rows.length;
        state.sent = 0;
        state.failed = 0;
        state.startedAt = Date.now();
        state.lastError = '';
        state.stopRequested = false;

        try {
            for (let i = 0; i < options.rows.length; i++) {
                if (state.stopRequested) break;
                const row = options.rows[i];
                if (i > 0) {
                    await waitForDelta(options.rows[i - 1], row, options.speed);
                    if (state.stopRequested) break;
                }
                const tw = options.timestampRewrite ?? 'off';
                const payload = rewriteReplayPayloadTimestamps(row.payload, tw);
                const result = await window.api.mqttPublish({
                    connectionId: options.connectionId,
                    topic: row.topic,
                    payload,
                    qos: row.qos,
                    retain: row.retain
                });
                if (result.success) {
                    state.sent++;
                } else {
                    state.failed++;
                    state.lastError = result.message || '发布失败';
                }
            }

            if (state.stopRequested) {
                toast.info(`已停止回放：${state.sent}/${state.total}`);
            } else if (state.failed > 0) {
                toast.warning(`回放完成，成功 ${state.sent} 条，失败 ${state.failed} 条`);
            } else {
                toast.success(`回放完成：${state.sent} 条`);
            }
        } finally {
            state.running = false;
            state.stopRequested = false;
        }
    }

    function stop(): void {
        if (!state.running) return;
        state.stopRequested = true;
    }

    return {
        state: readonly(state),
        start,
        stop
    };
}
