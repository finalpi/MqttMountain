<script setup lang="ts">
import { computed } from 'vue';
import { useUpdater } from '@/composables/useUpdater';

const updater = useUpdater();

const title = computed(() => {
    const info = updater.state.info;
    if (!info) return '';
    return `发现新版本 v${info.latestVersion}`;
});
</script>

<template>
    <Teleport to="body">
        <div v-if="updater.state.visible && updater.state.info" class="update-notice">
            <div class="info">
                <div class="title">{{ title }}</div>
                <div class="desc">
                    当前版本 v{{ updater.state.info.currentVersion }}，可前往 GitHub Releases 下载更新包。
                </div>
            </div>
            <div class="actions">
                <button class="btn btn-mini btn-primary" @click="updater.openDownload">去下载</button>
                <button class="btn btn-mini" @click="updater.dismiss">稍后</button>
            </div>
        </div>
    </Teleport>
</template>

<style lang="scss" scoped>
.update-notice {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 9998;
    width: min(420px, calc(100vw - 36px));
    display: flex;
    gap: 14px;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border: 1px solid rgba(125, 211, 252, 0.38);
    border-radius: 14px;
    background: rgba(15, 23, 42, 0.96);
    box-shadow: 0 24px 70px -22px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(56, 189, 248, 0.14) inset;
    color: var(--text-0);
    backdrop-filter: blur(16px);
}

.info {
    min-width: 0;
}

.title {
    font-size: 14px;
    font-weight: 800;
    color: #e0f2fe;
}

.desc {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-2);
}

.actions {
    display: flex;
    gap: 8px;
    flex: 0 0 auto;
}
</style>
