import { computed, reactive } from 'vue';
import type { UpdateInfo } from '@shared/types';

const state = reactive<{
    checking: boolean;
    checked: boolean;
    visible: boolean;
    info: UpdateInfo | null;
    error: string;
}>({
    checking: false,
    checked: false,
    visible: false,
    info: null,
    error: ''
});

async function check(options: { silent?: boolean } = {}): Promise<UpdateInfo | null> {
    if (state.checking) return state.info;
    state.checking = true;
    state.error = '';
    try {
        const result = await window.api.appCheckForUpdates();
        state.checked = true;
        if (!result.success || !result.data) {
            state.error = result.message || '检查更新失败';
            return null;
        }
        state.info = result.data;
        state.visible = result.data.hasUpdate;
        return result.data;
    } catch (e) {
        state.error = e instanceof Error ? e.message : '检查更新失败';
        return null;
    } finally {
        state.checking = false;
        if (options.silent && !state.info?.hasUpdate) state.visible = false;
    }
}

async function openDownload(): Promise<void> {
    await window.api.appOpenReleasesPage(state.info?.releaseUrl);
}

export function useUpdater() {
    return {
        state,
        hasUpdate: computed(() => !!state.info?.hasUpdate),
        check,
        openDownload,
        dismiss: () => {
            state.visible = false;
        }
    };
}
