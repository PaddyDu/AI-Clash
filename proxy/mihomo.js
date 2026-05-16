const {spawn, execFile, execSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const {createGunzip} = require('zlib');
const {pipeline} = require('stream/promises');
const {createWriteStream, createReadStream} = require('fs');

// Fallback version if GitHub API is unreachable. Override by placing a binary at
// <userData>/mihomo/mihomo (or mihomo.exe).
const FALLBACK_VERSION = 'v1.19.10';
const RELEASE_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';

function platformInfo() {
    const platform = process.platform;
    const arch = process.arch;
    let osName, archName, ext;
    if (platform === 'darwin') {
        osName = 'darwin';
        archName = arch === 'arm64' ? 'arm64' : 'amd64';
        ext = 'gz';
    } else if (platform === 'linux') {
        osName = 'linux';
        if (arch === 'arm64') archName = 'arm64';
        else if (arch === 'arm') archName = 'armv7';
        else archName = 'amd64';
        ext = 'gz';
    } else if (platform === 'win32') {
        osName = 'windows';
        archName = arch === 'arm64' ? 'arm64' : 'amd64';
        ext = 'zip';
    } else {
        throw new Error(`Unsupported platform: ${platform}/${arch}`);
    }
    return {
        osName, archName, ext,
        binaryName: platform === 'win32' ? 'mihomo.exe' : 'mihomo'
    };
}

function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {'User-Agent': 'AI-Clash', 'Accept': 'application/vnd.github+json'},
            timeout: 15000
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.resume();
                return httpsGetJson(res.headers.location).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => req.destroy(new Error(`timeout: ${url}`)));
        req.on('error', (err) => reject(new Error(describeError(err))));
    });
}

async function resolveAsset() {
    const info = platformInfo();
    // Match e.g. "mihomo-darwin-arm64-v1.19.10.gz" — exclude "compatible" / "go120" variants.
    const prefix = `mihomo-${info.osName}-${info.archName}-`;
    const suffix = `.${info.ext}`;
    let version = FALLBACK_VERSION;
    let downloadUrl = null;
    let fileName = null;
    try {
        const release = await httpsGetJson(RELEASE_API);
        version = release.tag_name || version;
        const candidates = (release.assets || []).filter(a => {
            const n = a.name;
            return n.startsWith(prefix) && n.endsWith(suffix)
                && !n.includes('compatible') && !n.includes('go120');
        });
        // Prefer asset whose middle segment is exactly "<version>" (no extra qualifiers).
        const exact = candidates.find(a => a.name === `${prefix}${version}${suffix}`);
        const chosen = exact || candidates[0];
        if (chosen) {
            downloadUrl = chosen.browser_download_url;
            fileName = chosen.name;
        }
    } catch (e) {
        // GitHub API unreachable — fall through to constructed URL below.
    }
    if (!downloadUrl) {
        fileName = `${prefix}${version}${suffix}`;
        downloadUrl = `https://github.com/MetaCubeX/mihomo/releases/download/${version}/${fileName}`;
    }
    return {url: downloadUrl, fileName, ext: info.ext, binaryName: info.binaryName, version};
}

function describeError(err) {
    if (err && Array.isArray(err.errors)) {
        // AggregateError: surface each inner error so users see the real cause
        return err.errors.map(e => e && (e.code || e.message) || String(e)).join('; ');
    }
    return err && (err.message || String(err));
}

function formatBytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function httpsGetFollow(url, dest, onProgress, redirects = 8) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {'User-Agent': 'AI-Clash'},
            timeout: 30000
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.resume();
                if (redirects <= 0) return reject(new Error('Too many redirects'));
                const next = new URL(res.headers.location, url).toString();
                return httpsGetFollow(next, dest, onProgress, redirects - 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            let received = 0;
            let lastReport = Date.now();
            const startedAt = lastReport;
            res.on('data', (chunk) => {
                received += chunk.length;
                if (!onProgress) return;
                const now = Date.now();
                if (now - lastReport >= 300) { // throttle UI updates
                    lastReport = now;
                    const elapsed = (now - startedAt) / 1000;
                    const speed = elapsed > 0 ? received / elapsed : 0;
                    onProgress({received, total, speed});
                }
            });
            const file = createWriteStream(dest);
            res.pipe(file);
            file.on('finish', () => {
                // Final 100% tick
                if (onProgress) {
                    const elapsed = (Date.now() - startedAt) / 1000;
                    onProgress({received, total: total || received, speed: elapsed > 0 ? received / elapsed : 0, done: true});
                }
                file.close(resolve);
            });
            file.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error(`timeout fetching ${url}`)));
        req.on('error', (err) => reject(new Error(`fetch ${url} → ${describeError(err)}`)));
    });
}

// Download endpoints in priority order. China-friendly mirrors first
// (github.com directly is unusably slow / blocked for most users in China),
// then the official URL as a last-resort fallback in case every mirror is
// down at the same time.
const GITHUB_MIRRORS = [
    'https://ghfast.top/',
    'https://gh-proxy.com/',
    '' // direct github.com
];

async function tryDownload(originalUrl, dest, progressCb) {
    const errors = [];
    for (const prefix of GITHUB_MIRRORS) {
        const url = prefix ? prefix + originalUrl : originalUrl;
        const host = prefix ? new URL(prefix).host : 'github.com (direct)';
        try {
            if (progressCb) progressCb(`Downloading from ${host}...`);
            await httpsGetFollow(url, dest, (p) => {
                if (!progressCb) return;
                const pct = p.total ? `${Math.floor((p.received / p.total) * 100)}%` : '';
                const speed = p.speed > 0 ? `${formatBytes(p.speed)}/s` : '';
                const sizeInfo = p.total
                    ? `${formatBytes(p.received)} / ${formatBytes(p.total)}`
                    : formatBytes(p.received);
                progressCb(`Downloading from ${host}  ${pct}  ${sizeInfo}  ${speed}`);
            });
            return; // success
        } catch (e) {
            errors.push(`${host}: ${describeError(e)}`);
            try { fs.unlinkSync(dest); } catch (_) {}
            if (progressCb) progressCb(`${host} failed, trying next...`);
        }
    }
    throw new Error('All download endpoints failed:\n  ' + errors.join('\n  '));
}

async function gunzipFile(src, dest) {
    await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
}

async function unzipFile(src, dest, binaryName) {
    // Shell out via execFile (no shell interpolation, so apostrophes / spaces
    // in userData paths can't break the command). Windows 10 1803+ bundles
    // bsdtar at `tar.exe` which handles .zip natively.
    const tmpDir = path.join(path.dirname(dest), 'unzip-tmp');
    fs.rmSync(tmpDir, {recursive: true, force: true});
    fs.mkdirSync(tmpDir, {recursive: true});
    await new Promise((resolve, reject) => {
        const cmd = process.platform === 'win32' ? 'tar' : 'unzip';
        const args = process.platform === 'win32'
            ? ['-xf', src, '-C', tmpDir]
            : ['-o', src, '-d', tmpDir];
        execFile(cmd, args, (err, _stdout, stderr) => {
            if (err) {
                err.message = `${err.message}${stderr ? '\n' + stderr : ''}`;
                reject(err);
            } else resolve();
        });
    });
    // The mihomo Windows zip contains the binary with the full archive name,
    // e.g. "mihomo-windows-amd64.exe" — not bare "mihomo.exe". Match by prefix
    // so we tolerate any version/arch suffix.
    const found = findMihomoBinary(tmpDir, binaryName);
    if (!found) {
        const listing = listAll(tmpDir).slice(0, 10).join(', ');
        fs.rmSync(tmpDir, {recursive: true, force: true});
        throw new Error(`Binary ${binaryName} not found inside zip. Saw: ${listing}`);
    }
    fs.copyFileSync(found, dest);
    fs.rmSync(tmpDir, {recursive: true, force: true});
}

function findMihomoBinary(dir, binaryName) {
    // Exact match first, then any file starting with "mihomo" and matching the
    // platform's executable extension.
    const exact = findFile(dir, binaryName);
    if (exact) return exact;
    const isWin = binaryName.endsWith('.exe');
    for (const file of listAll(dir)) {
        const base = path.basename(file).toLowerCase();
        if (!base.startsWith('mihomo')) continue;
        if (isWin && !base.endsWith('.exe')) continue;
        if (!isWin && base.endsWith('.exe')) continue;
        return file;
    }
    return null;
}

function listAll(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listAll(full));
        else out.push(full);
    }
    return out;
}

function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(full, name);
            if (found) return found;
        } else if (entry.name === name || entry.name.toLowerCase() === name.toLowerCase()) {
            return full;
        }
    }
    return null;
}

function pidIsAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Block the current thread for `ms` milliseconds without spawning subprocesses.
// Used inside synchronous emergency cleanup (process.on('exit')) where we
// can't use timers or promises.
function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {
        // SharedArrayBuffer may be unavailable in some sandboxed contexts —
        // fall back to a brief busy-spin (caller already bounds total wait time).
        const end = Date.now() + ms;
        while (Date.now() < end) {}
    }
}

function pidIsOurMihomo(pid, binaryName) {
    if (!pidIsAlive(pid)) return false;
    try {
        if (process.platform === 'win32') {
            const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {stdio: ['ignore', 'pipe', 'ignore']}).toString();
            return new RegExp(binaryName, 'i').test(out);
        } else {
            const out = execSync(`ps -p ${pid} -o comm=`, {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
            // comm may be a full path on some systems
            return out === binaryName || out.endsWith('/' + binaryName);
        }
    } catch (_) {
        return false;
    }
}

class MihomoManager {
    constructor(userDataPath) {
        this.dir = path.join(userDataPath, 'mihomo');
        const info = platformInfo();
        this.binaryName = info.binaryName;
        this.binaryPath = path.join(this.dir, this.binaryName);
        this.configDir = path.join(this.dir, 'run');
        this.configPath = path.join(this.configDir, 'config.yaml');
        this.pidFile = path.join(this.dir, 'mihomo.pid');
        this.process = null;
        this.onLog = null; // optional callback
    }

    /**
     * If a previous app session crashed without cleaning up, the mihomo binary
     * may still be running and holding our local port. Kill it before we
     * start fresh — but only if the PID actually belongs to our mihomo binary
     * (don't shoot random PIDs that got reused).
     */
    reclaimLeftover() {
        try {
            if (!fs.existsSync(this.pidFile)) return;
            const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8').trim(), 10);
            if (pid && pidIsOurMihomo(pid, this.binaryName)) {
                if (this.onLog) this.onLog(`[reclaim] killing leftover mihomo pid=${pid}\n`);
                try { process.kill(pid, 'SIGTERM'); } catch (_) {}
                const deadline = Date.now() + 1500;
                while (Date.now() < deadline && pidIsAlive(pid)) sleepSync(100);
                if (pidIsAlive(pid)) {
                    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
                }
            }
        } catch (_) { /* best-effort */ }
        try { fs.unlinkSync(this.pidFile); } catch (_) {}
    }

    isInstalled() {
        return fs.existsSync(this.binaryPath);
    }

    async install(progressCb) {
        fs.mkdirSync(this.dir, {recursive: true});
        if (progressCb) progressCb('Resolving latest mihomo release...');
        const asset = await resolveAsset();
        const archivePath = path.join(this.dir, asset.fileName);
        if (progressCb) progressCb(`Downloading ${asset.fileName}...`);
        try {
            await tryDownload(asset.url, archivePath, progressCb);
        } catch (e) {
            throw new Error(
                `${e.message}\n\nManual install: download ${asset.fileName} from ${asset.url}, ` +
                `extract the '${this.binaryName}' binary to:\n  ${this.binaryPath}\n` +
                `then enable proxy again.`
            );
        }
        if (progressCb) progressCb('Extracting...');
        if (asset.ext === 'gz') {
            await gunzipFile(archivePath, this.binaryPath);
        } else {
            await unzipFile(archivePath, this.binaryPath, this.binaryName);
        }
        fs.unlinkSync(archivePath);
        if (process.platform !== 'win32') {
            fs.chmodSync(this.binaryPath, 0o755);
        }
        if (progressCb) progressCb(`Installed mihomo ${asset.version}.`);
    }

    async ensureInstalled(progressCb) {
        if (!this.isInstalled()) {
            await this.install(progressCb);
        }
    }

    writeConfig(yamlText) {
        fs.mkdirSync(this.configDir, {recursive: true});
        // mode 0o600 — only the current user can read. The config contains the
        // randomly-generated controller secret in plaintext.
        fs.writeFileSync(this.configPath, yamlText, {encoding: 'utf8', mode: 0o600});
    }

    isRunning() {
        return this.process !== null && !this.process.killed;
    }

    start() {
        if (this.isRunning()) return;
        if (!this.isInstalled()) throw new Error('mihomo binary not installed');
        if (!fs.existsSync(this.configPath)) throw new Error('mihomo config not written');
        // Belt-and-suspenders: reclaim before spawning, in case the user
        // disabled then re-enabled within the same session after a crash.
        this.reclaimLeftover();
        const proc = spawn(this.binaryPath, ['-d', this.configDir, '-f', this.configPath], {
            cwd: this.configDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            // Stay in our process group so OS-level parent death (e.g. SIGKILL
            // of Electron) propagates as far as the OS allows.
            detached: false
        });
        this.process = proc;
        try { fs.writeFileSync(this.pidFile, String(proc.pid), 'utf8'); } catch (_) {}
        const log = (data) => {
            const text = data.toString();
            if (this.onLog) this.onLog(text);
        };
        proc.stdout.on('data', log);
        proc.stderr.on('data', log);
        proc.on('exit', (code) => {
            if (this.onLog) this.onLog(`[mihomo exited code=${code}]\n`);
            this.process = null;
            try { fs.unlinkSync(this.pidFile); } catch (_) {}
        });
    }

    /**
     * Async stop: SIGTERM, then escalate to SIGKILL after grace period.
     */
    stop() {
        const proc = this.process;
        if (!proc) {
            try { fs.unlinkSync(this.pidFile); } catch (_) {}
            return;
        }
        this.process = null;
        const pid = proc.pid;
        try { proc.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => {
            if (pid && pidIsAlive(pid)) {
                try { process.kill(pid, 'SIGKILL'); } catch (_) {}
            }
        }, 2000).unref();
        try { fs.unlinkSync(this.pidFile); } catch (_) {}
    }

    /**
     * Synchronous stop for use inside process.on('exit') handlers where
     * timers/promises won't fire. Sends SIGTERM, briefly waits, then SIGKILL.
     */
    stopSync() {
        const proc = this.process;
        this.process = null;
        const pid = proc ? proc.pid : null;
        if (pid) {
            try { process.kill(pid, 'SIGTERM'); } catch (_) {}
            const deadline = Date.now() + 800;
            while (Date.now() < deadline && pidIsAlive(pid)) sleepSync(50);
            if (pidIsAlive(pid)) {
                try { process.kill(pid, 'SIGKILL'); } catch (_) {}
            }
        }
        try { fs.unlinkSync(this.pidFile); } catch (_) {}
    }

    /**
     * Reload by stopping + starting (mihomo also supports SIGHUP but cross-platform behavior varies).
     */
    restart() {
        this.stop();
        this.start();
    }
}

module.exports = {MihomoManager};
