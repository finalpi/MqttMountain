import { reactive, watch } from 'vue';

/** UI 偏好：右栏当前展开面板（手风琴，同时只开一项） + 消息字号 */
export type RightPanelKey = 'sub' | 'pub' | 'settings' | null;

interface UiPrefs {
    activeRight: RightPanelKey;
    fontSize: number;
}

const STORAGE_KEY = 'mm_ui_prefs';

function load(): UiPrefs {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const p = JSON.parse(raw) as Partial<UiPrefs> & { subOpen?: boolean; pubOpen?: boolean; settingsOpen?: boolean };
            // 旧版三个独立开关 → 迁移到 activeRight
            let active: RightPanelKey = (p.activeRight === 'sub' || p.activeRight === 'pub' || p.activeRight === 'settings' || p.activeRight === null)
                ? p.activeRight
                : 'sub';
            if (p.activeRight === undefined) {
                if (p.subOpen) active = 'sub';
                else if (p.pubOpen) active = 'pub';
                else if (p.settingsOpen) active = 'settings';
            }
            return {
                activeRight: active,
                fontSize: Math.min(22, Math.max(10, Number(p.fontSize) || 13))
            };
        }
    } catch {}
    return { activeRight: 'sub', fontSize: 13 };
}

const prefs = reactive<UiPrefs>(load());

function applyFontSize(): void {
    const f = prefs.fontSize;
    document.documentElement.style.setProperty('--fs-msg', `${f}px`);
    document.documentElement.style.setProperty('--fs-msg-meta', `${Math.max(10, f - 2)}px`);
    document.documentElement.style.setProperty('--fs-msg-topic', `${Math.max(10, f - 1)}px`);
}
applyFontSize();

watch(
    () => ({ ...prefs }),
    (v) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
        } catch {}
        applyFontSize();
    },
    { deep: true }
);

function toggleRight(key: Exclude<RightPanelKey, null>): void {
    prefs.activeRight = prefs.activeRight === key ? null : key;
}

export function useUiPrefs() {
    return { prefs, toggleRight };
}
