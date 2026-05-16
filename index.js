const {app, BrowserWindow, Menu, MenuItem, ipcMain, nativeTheme, session, shell, clipboard} = require('electron');
const path = require('path');
const fs = require('fs');
const windowStateKeeper = require('./window-state.js');
const {ProxyManager} = require('./proxy/manager.js');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_URL = 'https://perplexity.ai';
const SESSION_PARTITION = 'persist:adu-ai';

let proxyManager = null;
let settingsWindow = null;

function applyProxyToSession(proxyConfig) {
    const ses = session.fromPartition(SESSION_PARTITION);
    if (proxyConfig) {
        const {host, port} = proxyConfig;
        // mixed-port serves both HTTP CONNECT and SOCKS5 — use http for proxyRules
        return ses.setProxy({proxyRules: `http=${host}:${port};https=${host}:${port}`});
    }
    return ses.setProxy({proxyRules: ''});
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            return data;
        }
    } catch (e) {
        // ignore
    }
    return {};
}

function saveConfig(data) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        // ignore
    }
}

const createWindow = () => {
    const config = loadConfig();
    let mainWindowState = windowStateKeeper({
        defaultWidth: 1000,
        defaultHeight: 800
    });
    const win = new BrowserWindow({
        x: mainWindowState.x,
        y: mainWindowState.y,
        width: mainWindowState.width,
        height: mainWindowState.height,
        webPreferences: {
            partition: SESSION_PARTITION,
            spellcheck: true
        }
    });

    let currentRequestId = 0;  // Para rastrear

    const execSearch = () => {
        const parentBounds = win.getBounds();
        const searchWidth = 450;
        const searchHeight = 140;
        const x = parentBounds.x + (parentBounds.width - searchWidth) / 2;
        const y = parentBounds.y + (parentBounds.height - searchHeight) / 2;
        const searchWin = new BrowserWindow({
            parent: win,
            modal: true,
            title: 'Loading...',
            x: Math.round(x),
            y: Math.round(y),
            width: 500,
            height: 130,
            show: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });
        searchWin.loadFile('search.html').then(() => {
            searchWin.title = 'Find';
        });

        searchWin.once('ready-to-show', () => searchWin.show());

        // Handler da busca
        const doSearch = (event, { text, forward }) => {
            if (!text) {
                win.webContents.stopFindInPage('clearSelection');
                return;
            }
            currentRequestId = win.webContents.findInPage(text, {
                forward,
                matchCase: false
            });
        };

        ipcMain.on('search', doSearch);

        const foundHandler = (event, result) => {
            if (result.requestId === currentRequestId) {
                searchWin.webContents.send('search-result', result);
            }
        };
        win.webContents.on('found-in-page', foundHandler);

        const execQuietly = (fn) => {
            try {
                fn();
            }catch (e) {
                //
            }
        }

        const cleanup = () => {
            execQuietly(() => ipcMain.removeListener('search', doSearch));
            execQuietly(() => win.webContents.removeListener('found-in-page', foundHandler));
            execQuietly(() => win.webContents.stopFindInPage('clearSelection'));
            execQuietly(() => ipcMain.removeAllListeners('search-cancel'));
        };

        ipcMain.once('search-cancel', () => {
            searchWin.close();
        });

        win.once('closed', () => {
            searchWin.destroy();
            cleanup();
        });

        searchWin.once('closed', () => {
            searchWin.destroy();
            cleanup();
        });
    }

    let aboutWindow = null;

    async function createAboutWindow() {
        // Define our main window size
        if (aboutWindow == null) {
            aboutWindow = new BrowserWindow({
                width: 450,
                height: 550,
                show: false,
                minimizable: false,
                maximizable: false,
                parent: win
            });
            aboutWindow.setIcon(path.join(__dirname, 'img/icon.png'));

            aboutWindow.removeMenu();

            // noinspection ES6MissingAwait
            aboutWindow.loadFile(path.join(__dirname, 'about.html'));
            aboutWindow.webContents.on('dom-ready', () => {
                aboutWindow.webContents.executeJavaScript(`document.getElementById('version').innerHTML = '${app.getVersion()}';`);
                aboutWindow.show();
            });
            aboutWindow.webContents.setWindowOpenHandler(({url}) => {
                // open url in a browser and prevent default
                shell.openExternal(url);
                return {action: 'deny'};
            });
            aboutWindow.on('closed', () => {
                aboutWindow = null;
            });
        } else {
            aboutWindow.focus();
        }
    }

    ipcMain.handle('dark-mode:toggle', () => {
        if (nativeTheme.shouldUseDarkColors) {
            nativeTheme.themeSource = 'light';
        } else {
            nativeTheme.themeSource = 'dark';
        }
        return nativeTheme.shouldUseDarkColors;
    });

    ipcMain.handle('dark-mode:system', () => {
        nativeTheme.themeSource = 'system';
    });

    // Menu
    const appMenu = [
        {
            label: 'ADU AI',
            submenu: [
                {
                    label: 'Perplexity.AI',
                    accelerator: "CmdOrCtrl+P",
                    click: async () => {
                        saveConfig({...loadConfig(), lastUrl: 'https://perplexity.ai'});
                        await win.loadURL("https://perplexity.ai");
                    }
                },
                {
                    label: 'Claude.AI',
                    accelerator: "CmdOrCtrl+L",
                    click: async () => {
                        saveConfig({...loadConfig(), lastUrl: 'https://claude.ai/'});
                        await win.loadURL("https://claude.ai/");
                    }
                },
                {type: 'separator'},
                {
                    label: 'Refresh',
                    accelerator: "CmdOrCtrl+R",
                    click: async () => {
                        win.reload();
                    }
                },
                {type: 'separator'},
                {
                    label: 'Settings...',
                    accelerator: "CmdOrCtrl+,",
                    click: () => openSettingsWindow(win)
                },
                {type: 'separator'},
                {
                    label: 'Quit',
                    accelerator: "CmdOrCtrl+Q",
                    click() {
                        app.quit();
                    }
                }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                {
                    label: 'Find...',
                    accelerator: "CommandOrControl+F",
                    click() {
                        execSearch();
                    }
                },
                { type: 'separator' },
                { role: 'copy' },
                { role: 'cut' },
                { role: 'paste' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'resetZoom' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'About',
                    accelerator: "F1",
                    click: async () => {
                        await createAboutWindow();
                    }
                },
                {type: 'separator'},
                {
                    label: 'Quit',
                    accelerator: "CmdOrCtrl+Q",
                    click() {
                        app.quit();
                    }
                }
            ]
        }
    ];

    const openNewUrl = function (url, e) {
        if (
            url !== null &&
            url.indexOf("perplexity.ai") < 0 &&
            url.indexOf("claude.ai") < 0 &&
            url.indexOf("accounts.google.com") < 0 &&
            url.indexOf("appleid.apple.com") < 0
        ) {
            if (typeof e !== "undefined" && e !== null) {
                e.preventDefault();
            }
            // noinspection JSIgnoredPromiseFromCall
            shell.openExternal(url);
            return {action: 'deny'};
        } else {
            return {action: 'allow'};
        }
    }

    const handleRedirect = (e, url) => {
        openNewUrl(url, e);
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu));
    win.setIcon(path.join(__dirname, 'img/icon.png'));
    win.setTitle(app.getName() + ' - ' + app.getVersion());

    win.on('did-start-navigation', function () {
        session.defaultSession.cookies.flushStore();
    });

    win.on('did-navigate', function () {
        session.defaultSession.cookies.flushStore();
    });

    win.webContents.on('context-menu', (event, params) => {
        const menu = Menu.buildFromTemplate([
            {
                label: 'Copy',
                role: 'copy',
                enabled: params.selectionText.trim().length > 0,
            },
            {
                label: 'Cut',
                role: 'cut',
                enabled: params.editFlags.canCut,
            },
            {
                label: 'Paste',
                role: 'paste',
                enabled: params.editFlags.canPaste,
            },
            {
                label: 'Copy Link',
                visible: !!params.linkURL,
                click: () => clipboard.writeText(params.linkURL)
            }
        ]);
        if(params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
            menu.append(new MenuItem({type: 'separator'}));
            for (const suggestion of params.dictionarySuggestions) {
                menu.append(new MenuItem({
                    label: suggestion,
                    click: () => win.webContents.replaceMisspelling(suggestion)
                }))
            }
        }
        if (params.misspelledWord) {
            menu.append(
                new MenuItem({
                    label: 'Add to dictionary',
                    click: () => myWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
                })
            )
        }

        menu.popup(win);
    });
    win.webContents.on('will-navigate', handleRedirect);
    win.webContents.on('new-window', handleRedirect);
    win.webContents.setWindowOpenHandler(({url}) => {
        return openNewUrl(url);
    });

    mainWindowState.manage(win);
    win.loadURL(config.lastUrl || DEFAULT_URL);
}

function openSettingsWindow(parent) {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }
    settingsWindow = new BrowserWindow({
        width: 760,
        height: 620,
        parent,
        title: 'Settings',
        minimizable: false,
        maximizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    settingsWindow.removeMenu();
    settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
}

function registerProxyIpc() {
    ipcMain.handle('proxy:list-subscriptions', () => proxyManager.listSubscriptions());
    ipcMain.handle('proxy:list-nodes', () => {
        return proxyManager.listAllProxies().map(p => ({
            name: p.name, type: p.type, server: p.server, port: p.port,
            subId: p._subId, subName: p._subName
        }));
    });
    ipcMain.handle('proxy:get-state', () => proxyManager.getProxyState());
    ipcMain.handle('proxy:get-status', () => proxyManager.getRuntimeStatus());
    ipcMain.handle('proxy:add-subscription', async (_e, payload) => {
        await proxyManager.addSubscription(payload);
        return {ok: true};
    });
    ipcMain.handle('proxy:refresh-subscription', async (_e, id) => {
        await proxyManager.refreshSubscription(id);
        return {ok: true};
    });
    ipcMain.handle('proxy:delete-subscription', (_e, id) => {
        proxyManager.deleteSubscription(id);
        return {ok: true};
    });
    ipcMain.handle('proxy:enable', async (_e, payload) => {
        const sender = settingsWindow && settingsWindow.webContents;
        const progressCb = (msg) => sender && !sender.isDestroyed() && sender.send('proxy:progress', msg);
        try {
            return await proxyManager.start({progressCb});
        } catch (e) {
            // Unwrap AggregateError so the renderer sees a useful message,
            // not just the class name.
            const inner = Array.isArray(e.errors)
                ? e.errors.map(x => x && (x.message || String(x))).join('; ')
                : (e.message || String(e));
            throw new Error(inner);
        }
    });
    ipcMain.handle('proxy:disable', () => {
        proxyManager.stop();
        return {ok: true};
    });
    ipcMain.handle('proxy:select-node', async (_e, name) => {
        await proxyManager.selectNode(name);
        return {ok: true};
    });
    ipcMain.handle('proxy:test-node', async (_e, name) => {
        const sender = settingsWindow && settingsWindow.webContents;
        const progressCb = (msg) => sender && !sender.isDestroyed() && sender.send('proxy:progress', msg);
        try {
            // Auto-install + start mihomo if it isn't running yet, so users
            // can click Test without first toggling Enable.
            if (!proxyManager.runtime.running) {
                if (progressCb) progressCb('Starting proxy for test...');
                await proxyManager.start({progressCb});
            }
            const delay = await proxyManager.testNode(name);
            return {delay};
        } catch (e) {
            const inner = Array.isArray(e.errors)
                ? e.errors.map(x => x && (x.message || String(x))).join('; ')
                : (e.message || String(e));
            return {error: inner};
        }
    });
}

app.whenReady().then(async () => {
    proxyManager = new ProxyManager({
        userDataPath: app.getPath('userData'),
        configFile: CONFIG_FILE
    });
    // Return the promise so ProxyManager can await it — ensures session.setProxy
    // has landed before start() resolves and the renderer fires its first request.
    proxyManager.onProxyChange = (cfg) => applyProxyToSession(cfg);
    // Always sweep up any leftover mihomo from a previous crashed session,
    // even if we don't auto-start this time.
    proxyManager.mihomo.reclaimLeftover();
    registerProxyIpc();

    // If proxy was previously enabled and the binary is already installed, auto-start
    // before opening the main window so the first request goes through proxy.
    const state = proxyManager.getProxyState();
    if (state.enabled && proxyManager.mihomo.isInstalled()) {
        try {
            await proxyManager.start();
        } catch (e) {
            console.error('[startup] auto-start failed:', e.message);
        }
    }
    createWindow();
});

// --- Shutdown cleanup -------------------------------------------------------
// Multiple paths can end the app: normal Quit, Cmd+Q, window close on non-mac,
// Ctrl+C in terminal, SIGTERM from OS, or uncaught exceptions. Hook them all
// so the mihomo child process is never left dangling.
let cleanedUp = false;
function shutdown() {
    if (cleanedUp) return;
    cleanedUp = true;
    // stopForShutdown preserves the persisted enabled flag so a previously-on
    // proxy auto-resumes on next launch.
    try { if (proxyManager) proxyManager.stopForShutdown(); } catch (_) {}
}
function shutdownSync() {
    if (cleanedUp) return;
    cleanedUp = true;
    try { if (proxyManager) proxyManager.mihomo.stopSync(); } catch (_) {}
}

app.on('before-quit', shutdown);
app.on('will-quit', shutdown);
app.on('window-all-closed', () => {
    // On macOS the app stays alive after closing all windows — don't kill mihomo
    // here or a dock re-open lands in a state where toggle says Enabled but no
    // proxy is actually running. On other platforms, closing the last window
    // means quitting the app, so cleanup is appropriate.
    if (process.platform !== 'darwin') {
        shutdown();
        app.quit();
    }
});
process.on('exit', shutdownSync);
process.on('SIGINT',  () => { shutdownSync(); process.exit(0); });
process.on('SIGTERM', () => { shutdownSync(); process.exit(0); });
process.on('SIGHUP',  () => { shutdownSync(); process.exit(0); });
process.on('uncaughtException', (err) => {
    console.error('[uncaught]', err);
    shutdownSync();
    process.exit(1);
});