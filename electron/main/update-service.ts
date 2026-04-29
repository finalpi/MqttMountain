import { shell, app } from 'electron';
import https from 'node:https';

const RELEASES_LATEST_URL = 'https://github.com/finalpi/MQTTMountain/releases/latest';
const RELEASES_PAGE_URL = 'https://github.com/finalpi/MQTTMountain/releases';
const REQUEST_TIMEOUT_MS = 10000;

export interface UpdateInfo {
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    releaseUrl: string;
    releaseName?: string;
    publishedAt?: string;
    body?: string;
}

interface HttpTextResponse {
    status: number;
    headers: NodeJS.Dict<string | string[]>;
    body: string;
}

interface ReleasePageInfo {
    latestVersion: string;
    releaseUrl: string;
}

function normalizeVersion(version: string): string {
    return version.trim().replace(/^v/i, '');
}

function compareVersion(left: string, right: string): number {
    const a = normalizeVersion(left).split(/[.-]/);
    const b = normalizeVersion(right).split(/[.-]/);
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
        const av = a[i] ?? '0';
        const bv = b[i] ?? '0';
        const an = Number(av);
        const bn = Number(bv);
        if (Number.isFinite(an) && Number.isFinite(bn)) {
            if (an !== bn) return an > bn ? 1 : -1;
            continue;
        }
        if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
}

function requestText(url: string, accept: string): Promise<HttpTextResponse> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                Accept: accept,
                'User-Agent': `MQTTMountain/${app.getVersion()}`
            }
        }, (res) => {
            const status = res.statusCode ?? 0;
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                raw += chunk;
            });
            res.on('end', () => {
                resolve({ status, headers: res.headers, body: raw });
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('检查更新超时'));
        });
        req.on('error', reject);
    });
}

function parseVersionFromUrl(url: string): string {
    const match = url.match(/\/releases\/tag\/([^/?#]+)/);
    return normalizeVersion(match?.[1] || '');
}

function releaseUrl(version: string): string {
    return `${RELEASES_PAGE_URL}/tag/v${normalizeVersion(version)}`;
}

function parseLatestFromHtml(html: string): ReleasePageInfo | null {
    const match = html.match(/\/finalpi\/MQTTMountain\/releases\/tag\/(v?\d+\.\d+\.\d+(?:[-.\w]*)?)/);
    const latestVersion = normalizeVersion(match?.[1] || '');
    if (!latestVersion) return null;
    return {
        latestVersion,
        releaseUrl: releaseUrl(latestVersion)
    };
}

async function readLatestFromReleasePage(): Promise<ReleasePageInfo> {
    const res = await requestText(RELEASES_PAGE_URL, 'text/html');
    if (res.status >= 200 && res.status < 300) {
        const parsed = parseLatestFromHtml(res.body);
        if (parsed) return parsed;
    }

    const latestRes = await requestText(RELEASES_LATEST_URL, 'text/html');
    const location = Array.isArray(latestRes.headers.location) ? latestRes.headers.location[0] : latestRes.headers.location;
    const tagUrl = location
        ? new URL(location, RELEASES_LATEST_URL).toString()
        : '';
    const latestVersion = parseVersionFromUrl(tagUrl) || parseVersionFromUrl(latestRes.body);
    if (!latestVersion) throw new Error(`GitHub Releases 返回 ${latestRes.status}，未解析到最新版本`);
    return {
        latestVersion,
        releaseUrl: tagUrl || releaseUrl(latestVersion)
    };
}

export async function checkForUpdates(): Promise<UpdateInfo> {
    const currentVersion = app.getVersion();
    const release = await readLatestFromReleasePage();
    const latestVersion = normalizeVersion(release.latestVersion);
    if (!latestVersion) throw new Error('未获取到最新版本号');
    return {
        currentVersion,
        latestVersion,
        hasUpdate: compareVersion(latestVersion, currentVersion) > 0,
        releaseUrl: release.releaseUrl
    };
}

export async function openReleasesPage(url = RELEASES_PAGE_URL): Promise<void> {
    await shell.openExternal(url || RELEASES_PAGE_URL);
}
