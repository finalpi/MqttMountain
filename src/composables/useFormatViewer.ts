import { reactive } from 'vue';

export interface FormatViewerState {
    visible: boolean;
    topic: string;
    time: number;
    raw: string;
    editable: boolean;
    draftTopic: string;
    draftRaw: string;
    publishable: boolean;
    history: FormatViewerHistoryItem[];
    connectionId: string | null;
    publishTracking: FormatViewerPublishTracking | null;
}

export interface FormatViewerHistoryItem {
    topic: string;
    payload: string;
    qos: number;
    retain: boolean;
    time: number;
}

export interface FormatViewerDraft {
    topic: string;
    raw: string;
    qos?: number;
    retain?: boolean;
}

export interface FormatViewerPublishTracking {
    connectionId: string;
    sinceTime: number;
}

const state = reactive<FormatViewerState>({
    visible: false,
    topic: '',
    time: 0,
    raw: '',
    editable: false,
    draftTopic: '',
    draftRaw: '',
    publishable: false,
    history: [],
    connectionId: null,
    publishTracking: null
});

let applyHandler: ((draft: FormatViewerDraft) => void) | null = null;
let publishHandler: ((draft: FormatViewerDraft) => void | Promise<void>) | null = null;

export function useFormatViewer() {
    function open(payload: {
        topic: string;
        time: number;
        raw: string;
        autoFormat?: boolean;
        editable?: boolean;
        publishable?: boolean;
        history?: FormatViewerHistoryItem[];
        connectionId?: string | null;
        onApply?: (draft: FormatViewerDraft) => void;
        onPublish?: (draft: FormatViewerDraft) => void | Promise<void>;
    }): void {
        const raw = payload.autoFormat ? formatJsonText(payload.raw) : payload.raw;
        state.topic = payload.topic;
        state.time = payload.time;
        state.raw = raw;
        state.editable = !!payload.editable;
        state.draftTopic = payload.topic;
        state.draftRaw = raw;
        state.publishable = !!payload.publishable;
        state.history = payload.history ?? [];
        state.connectionId = payload.connectionId ?? null;
        state.publishTracking = null;
        applyHandler = payload.onApply ?? null;
        publishHandler = payload.onPublish ?? null;
        state.visible = true;
    }
    function close(): void {
        state.visible = false;
        state.raw = '';
        state.editable = false;
        state.draftTopic = '';
        state.draftRaw = '';
        state.publishable = false;
        state.history = [];
        state.connectionId = null;
        state.publishTracking = null;
        applyHandler = null;
        publishHandler = null;
    }
    function applyDraft(): void {
        const draft = { topic: state.draftTopic, raw: state.draftRaw };
        state.topic = draft.topic;
        state.raw = draft.raw;
        applyHandler?.(draft);
    }
    async function publishDraft(): Promise<void> {
        const draft = { topic: state.draftTopic, raw: state.draftRaw };
        applyDraft();
        await publishHandler?.(draft);
    }
    function markPublished(tracking: FormatViewerPublishTracking): void {
        state.connectionId = tracking.connectionId;
        state.publishTracking = tracking;
    }
    function repeatHistory(item: FormatViewerHistoryItem): void {
        state.draftTopic = item.topic;
        state.draftRaw = item.payload;
        state.topic = item.topic;
        state.raw = item.payload;
        state.time = item.time;
        state.publishTracking = null;
        applyHandler?.({ topic: item.topic, raw: item.payload, qos: item.qos, retain: item.retain });
    }
    return { state, open, close, applyDraft, publishDraft, markPublished, repeatHistory };
}

function formatJsonText(raw: string): string {
    if (!raw.trim()) return raw;
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}
