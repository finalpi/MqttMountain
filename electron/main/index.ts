import { app } from 'electron';
import path from 'node:path';

/**
 * 必须在任何会调用 app.getPath / 打开 userData 的模块加载之前取得锁，
 * 否则第二进程可能在锁判定前就完成初始化，导致出现两个应用窗口。
 */
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    if (process.platform === 'win32') {
        try {
            require('node:child_process').execSync('cmd /c chcp 65001>nul', { stdio: 'ignore', windowsHide: true });
        } catch {}
    }

    process.env.APP_ROOT = path.join(__dirname, '../..');

    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,HardwareMediaKeyHandling');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-background-timer-throttling');
    app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

    void import('./app-entry');
}
