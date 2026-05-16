const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const {randomUUID} = require('crypto');
const yaml = require('js-yaml');
const {MihomoManager} = require('./mihomo.js');

// User-Agent that subscription providers recognize as a Clash client (so they return YAML).
const SUB_UA = 'clash-verge/v2.0.0';

function fetchUrl(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, {headers: {'User-Agent': SUB_UA}}, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                if (redirects <= 0) {
                    res.resume();
                    return reject(new Error('Too many redirects'));
                }
                const next = new URL(res.headers.location, url).toString();
                res.resume();
                return fetchUrl(next, redirects - 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
            }
            const headers = res.headers;
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({body: Buffer.concat(chunks).toString('utf8'), headers}));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

function parseSubscriptionUserinfo(headerValue) {
    if (!headerValue) return null;
    const out = {};
    for (const part of headerValue.split(';')) {
        const [k, v] = part.split('=').map(s => s && s.trim());
        if (k && v) out[k] = Number(v);
    }
    return out;
}

function parseClashYaml(text) {
    const doc = yaml.load(text);
    if (!doc || typeof doc !== 'object') throw new Error('Subscription is not a YAML mapping');
    const proxies = Array.isArray(doc.proxies) ? doc.proxies : [];
    if (!proxies.length) throw new Error('No proxies found in subscription (only Clash YAML format is supported)');
    // Sanitize: ensure each has unique name
    const seen = new Set();
    const cleaned = [];
    for (const p of proxies) {
        if (!p || typeof p !== 'object' || !p.name || !p.type || !p.server || !p.port) continue;
        let name = String(p.name);
        if (seen.has(name)) {
            let i = 2;
            while (seen.has(`${name} (${i})`)) i++;
            name = `${name} (${i})`;
        }
        seen.add(name);
        cleaned.push({...p, name});
    }
    if (!cleaned.length) throw new Error('Subscription proxies are empty after parsing');
    return cleaned;
}

function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

const PROXY_GROUP = 'AI-Clash';

function buildMihomoConfig({proxies, selectedNode, mixedPort, controllerPort, secret}) {
    const proxyNames = proxies.map(p => p.name);
    const config = {
        'mixed-port': mixedPort,
        'allow-lan': false,
        'bind-address': '127.0.0.1',
        'mode': 'rule',
        'log-level': 'warning',
        'external-controller': `127.0.0.1:${controllerPort}`,
        'secret': secret,
        'dns': {
            'enable': true,
            'listen': '127.0.0.1:0',
            'enhanced-mode': 'fake-ip',
            // Domestic resolvers first so direct rules still work fast in China,
            // then DoH for upstream lookups. mihomo picks the fastest responder.
            'nameserver': [
                '223.5.5.5',
                '119.29.29.29',
                'https://1.1.1.1/dns-query',
                'https://8.8.8.8/dns-query'
            ]
        },
        'proxies': proxies,
        'proxy-groups': [
            {
                name: PROXY_GROUP,
                type: 'select',
                proxies: proxyNames
            }
        ],
        'rules': [
            `MATCH,${PROXY_GROUP}`
        ]
    };
    if (selectedNode && proxyNames.includes(selectedNode)) {
        // Put the selected proxy first so mihomo defaults to it.
        config['proxy-groups'][0].proxies = [selectedNode, ...proxyNames.filter(n => n !== selectedNode)];
    }
    return yaml.dump(config, {lineWidth: -1, noRefs: true});
}

class ProxyManager {
    constructor({userDataPath, configFile}) {
        this.userDataPath = userDataPath;
        this.configFile = configFile;
        this.subsDir = path.join(userDataPath, 'subscriptions');
        fs.mkdirSync(this.subsDir, {recursive: true});
        this.mihomo = new MihomoManager(userDataPath);
        this.installLog = '';
        this.mihomo.onLog = (line) => {
            this.installLog = (this.installLog + line).slice(-4000);
        };
        this.runtime = {
            mixedPort: null,
            controllerPort: null,
            secret: null,
            running: false
        };
        this.onProxyChange = null; // (proxyConfig | null) => void
    }

    // --- persistence -------------------------------------------------------

    loadConfig() {
        try {
            if (fs.existsSync(this.configFile)) {
                return JSON.parse(fs.readFileSync(this.configFile, 'utf8')) || {};
            }
        } catch (e) {/* ignore */}
        return {};
    }

    saveConfig(data) {
        // Atomic: write to a temp file in the same dir, then rename. Prevents
        // a partial write from corrupting the JSON and silently wiping all
        // subscriptions on next load.
        const tmp = this.configFile + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, this.configFile);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (_) {}
        }
    }

    getProxyState() {
        const cfg = this.loadConfig();
        return cfg.proxy || {enabled: false, subscriptions: [], selectedNode: null};
    }

    setProxyState(proxy) {
        const cfg = this.loadConfig();
        cfg.proxy = proxy;
        this.saveConfig(cfg);
    }

    // --- subscription CRUD -------------------------------------------------

    subFile(id) {
        return path.join(this.subsDir, `${id}.yaml`);
    }

    readSubProxies(id) {
        const file = this.subFile(id);
        if (!fs.existsSync(file)) return [];
        try {
            return parseClashYaml(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            return [];
        }
    }

    listSubscriptions() {
        const state = this.getProxyState();
        return (state.subscriptions || []).map(sub => ({
            ...sub,
            nodeCount: this.readSubProxies(sub.id).length
        }));
    }

    listAllProxies() {
        const state = this.getProxyState();
        const out = [];
        for (const sub of state.subscriptions || []) {
            for (const p of this.readSubProxies(sub.id)) {
                out.push({...p, _subId: sub.id, _subName: sub.name});
            }
        }
        return out;
    }

    async addSubscription({name, url}) {
        if (!url) throw new Error('Subscription URL required');
        const id = randomUUID();
        const sub = {
            id,
            name: name || 'Untitled',
            url,
            createdAt: new Date().toISOString(),
            updatedAt: null,
            userInfo: null
        };
        await this._refreshSubscription(sub);
        const state = this.getProxyState();
        state.subscriptions = [...(state.subscriptions || []), sub];
        this.setProxyState(state);
        return this.listSubscriptions();
    }

    async refreshSubscription(id) {
        const state = this.getProxyState();
        const sub = (state.subscriptions || []).find(s => s.id === id);
        if (!sub) throw new Error('Subscription not found');
        await this._refreshSubscription(sub);
        this.setProxyState(state);
        if (this.runtime.running) await this._reloadRunningConfig();
        return this.listSubscriptions();
    }

    async _refreshSubscription(sub) {
        const {body, headers} = await fetchUrl(sub.url);
        // Validate YAML before saving so we don't overwrite a working sub with garbage.
        parseClashYaml(body);
        fs.writeFileSync(this.subFile(sub.id), body, 'utf8');
        sub.updatedAt = new Date().toISOString();
        sub.userInfo = parseSubscriptionUserinfo(headers['subscription-userinfo']);
    }

    deleteSubscription(id) {
        const state = this.getProxyState();
        const subs = (state.subscriptions || []).filter(s => s.id !== id);
        state.subscriptions = subs;
        // Clear selection if the node belonged to this sub
        const remaining = subs.flatMap(s => this.readSubProxies(s.id).map(p => p.name));
        if (state.selectedNode && !remaining.includes(state.selectedNode)) {
            state.selectedNode = null;
        }
        this.setProxyState(state);
        try { fs.unlinkSync(this.subFile(id)); } catch (e) {/* ignore */}
        return this.listSubscriptions();
    }

    // --- runtime: start/stop mihomo ----------------------------------------

    async start({progressCb} = {}) {
        // Concurrency guard: if a start is already in flight, return the same
        // promise so spam-clicking Enable doesn't spawn two mihomo processes.
        if (this._startPromise) return this._startPromise;
        this._startPromise = this._doStart({progressCb}).finally(() => {
            this._startPromise = null;
        });
        return this._startPromise;
    }

    async _doStart({progressCb}) {
        // Reset the cached install/runtime log so previous attempts don't
        // confuse the next progress display.
        this.installLog = '';
        await this.mihomo.ensureInstalled(progressCb);
        const proxies = this.listAllProxies();
        if (!proxies.length) throw new Error('No proxies available — add a subscription first');
        const state = this.getProxyState();
        const selectedNode = state.selectedNode && proxies.some(p => p.name === state.selectedNode)
            ? state.selectedNode
            : proxies[0].name;

        // Strip our internal _subId/_subName before passing to mihomo
        const cleanProxies = proxies.map(({_subId, _subName, ...rest}) => rest);
        const mixedPort = await findFreePort();
        const controllerPort = await findFreePort();
        const secret = randomUUID();
        const yamlText = buildMihomoConfig({
            proxies: cleanProxies, selectedNode, mixedPort, controllerPort, secret
        });
        // Write the config with 0600 so other local users can't read the
        // controller secret (mihomo persists it in plaintext).
        this.mihomo.writeConfig(yamlText);
        this.mihomo.start();
        this.runtime = {mixedPort, controllerPort, secret, running: true};

        // Wait for mihomo's HTTP API to come up before declaring victory.
        // 10s accounts for first-run geo* downloads on slower networks.
        try {
            await this._waitForController(10000);
        } catch (e) {
            this._stopRuntime();
            throw e;
        }

        // Persist state
        const newState = {...state, enabled: true, selectedNode};
        this.setProxyState(newState);
        // Await onProxyChange so callers (createWindow, first loadURL) don't
        // race with session.setProxy. If the renderer's setProxy is slow, the
        // first request still goes through the proxy.
        if (this.onProxyChange) {
            try { await this.onProxyChange({host: '127.0.0.1', port: mixedPort}); }
            catch (_) {/* don't fail start if the hook throws */}
        }
        return {mixedPort, selectedNode};
    }

    /**
     * User-initiated stop. Persists enabled=false so the next launch stays off.
     */
    stop() {
        this._stopRuntime();
        const state = this.getProxyState();
        this.setProxyState({...state, enabled: false});
        if (this.onProxyChange) this.onProxyChange(null);
    }

    /**
     * Shutdown stop used by app exit handlers. Kills the mihomo subprocess
     * but leaves the persisted enabled flag alone, so a previously-on proxy
     * comes back automatically on next launch.
     */
    stopForShutdown() {
        this._stopRuntime();
        // Don't touch persisted state. Don't fire onProxyChange — the
        // session is being torn down with the app anyway.
    }

    _stopRuntime() {
        this.mihomo.stop();
        this.runtime = {mixedPort: null, controllerPort: null, secret: null, running: false};
    }

    async selectNode(nodeName) {
        const state = this.getProxyState();
        const proxies = this.listAllProxies();
        if (!proxies.some(p => p.name === nodeName)) {
            throw new Error('Node not found in current subscriptions');
        }
        this.setProxyState({...state, selectedNode: nodeName});
        if (!this.runtime.running) return;
        // Use mihomo's external-controller to switch without restart
        await this._controllerRequest('PUT', `/proxies/${encodeURIComponent(PROXY_GROUP)}`, {name: nodeName});
    }

    async testNode(nodeName) {
        if (!this.runtime.running) throw new Error('Proxy not running');
        const enc = encodeURIComponent(nodeName);
        const path = `/proxies/${enc}/delay?timeout=5000&url=${encodeURIComponent('https://www.gstatic.com/generate_204')}`;
        const res = await this._controllerRequest('GET', path);
        return res.delay; // ms
    }

    async _reloadRunningConfig() {
        // Easiest path: kill the mihomo runtime then re-start. Crucially we use
        // _stopRuntime (not stop()) so the persisted enabled flag isn't flipped
        // to false in between — otherwise a failed restart leaves the user
        // looking disabled even though they never asked to disable.
        if (!this.runtime.running) return;
        this._stopRuntime();
        try {
            await this.start();
        } catch (e) {
            // Re-start failed — surface the error to the caller.
            throw e;
        }
    }

    _controllerRequest(method, urlPath, body, {timeoutMs = 8000} = {}) {
        return new Promise((resolve, reject) => {
            if (!this.runtime.controllerPort) return reject(new Error('Controller not running'));
            const data = body ? JSON.stringify(body) : null;
            const req = http.request({
                hostname: '127.0.0.1',
                port: this.runtime.controllerPort,
                path: urlPath,
                method,
                timeout: timeoutMs,
                headers: {
                    'Authorization': `Bearer ${this.runtime.secret}`,
                    'Content-Type': 'application/json',
                    ...(data ? {'Content-Length': Buffer.byteLength(data)} : {})
                }
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try { resolve(text ? JSON.parse(text) : null); }
                        catch (e) { resolve(text); }
                    } else {
                        reject(new Error(`Controller HTTP ${res.statusCode}: ${text}`));
                    }
                });
            });
            req.on('timeout', () => req.destroy(new Error(`controller request timeout: ${urlPath}`)));
            req.on('error', reject);
            if (data) req.write(data);
            req.end();
        });
    }

    async _waitForController(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        let lastErr = null;
        while (Date.now() < deadline) {
            // Bail early if mihomo already died — no point waiting full timeout.
            if (!this.mihomo.isRunning()) {
                throw new Error(`mihomo exited during startup. Log tail:\n${this.installLog.slice(-1000)}`);
            }
            try {
                await this._controllerRequest('GET', '/version', null, {timeoutMs: 1500});
                return;
            } catch (e) {
                lastErr = e;
                await new Promise(r => setTimeout(r, 150));
            }
        }
        throw new Error(`mihomo did not become ready in ${timeoutMs}ms: ${lastErr && lastErr.message}`);
    }

    getRuntimeStatus() {
        return {
            running: this.runtime.running,
            mixedPort: this.runtime.mixedPort,
            installed: this.mihomo.isInstalled(),
            log: this.installLog
        };
    }
}

module.exports = {ProxyManager};
