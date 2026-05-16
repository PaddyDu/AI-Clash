// Minimal drop-in replacement for `electron-window-state`. Inlined because the
// upstream package's CJS dependency chain breaks Electron 33's ESM loader.
const {app, screen} = require('electron');
const path = require('path');
const fs = require('fs');

module.exports = function windowStateKeeper(options = {}) {
    const config = {
        file: 'window-state.json',
        path: app.getPath('userData'),
        maximize: true,
        fullScreen: true,
        ...options
    };
    const storeFile = path.join(config.path, config.file);
    const eventHandlingDelay = 100;
    let state;
    let winRef;
    let stateChangeTimer;

    function isNormal(win) {
        return !win.isMaximized() && !win.isMinimized() && !win.isFullScreen();
    }

    function hasBounds() {
        return state &&
            Number.isInteger(state.x) && Number.isInteger(state.y) &&
            Number.isInteger(state.width) && state.width > 0 &&
            Number.isInteger(state.height) && state.height > 0;
    }

    function resetStateToDefault() {
        const displayBounds = screen.getPrimaryDisplay().bounds;
        state = {
            width: config.defaultWidth || 800,
            height: config.defaultHeight || 600,
            x: 0, y: 0, displayBounds
        };
    }

    function windowWithinBounds(bounds) {
        return state.x >= bounds.x &&
            state.y >= bounds.y &&
            state.x + state.width <= bounds.x + bounds.width &&
            state.y + state.height <= bounds.y + bounds.height;
    }

    function ensureWindowVisibleOnSomeDisplay() {
        const visible = screen.getAllDisplays().some(d => windowWithinBounds(d.bounds));
        if (!visible) resetStateToDefault();
    }

    function validateState() {
        const isValid = state && (hasBounds() || state.isMaximized || state.isFullScreen);
        if (!isValid) { state = null; return; }
        if (hasBounds() && state.displayBounds) ensureWindowVisibleOnSomeDisplay();
    }

    function updateState(win) {
        win = win || winRef;
        if (!win) return;
        try {
            const winBounds = win.getBounds();
            if (isNormal(win)) {
                state.x = winBounds.x;
                state.y = winBounds.y;
                state.width = winBounds.width;
                state.height = winBounds.height;
            }
            state.isMaximized = win.isMaximized();
            state.isFullScreen = win.isFullScreen();
            state.displayBounds = screen.getDisplayMatching(winBounds).bounds;
        } catch (e) {/* window may be closed */}
    }

    function saveState(win) {
        if (win) updateState(win);
        try {
            fs.mkdirSync(path.dirname(storeFile), {recursive: true});
            fs.writeFileSync(storeFile, JSON.stringify(state, null, 2), 'utf8');
        } catch (e) {/* don't care */}
    }

    function stateChangeHandler() {
        clearTimeout(stateChangeTimer);
        stateChangeTimer = setTimeout(updateState, eventHandlingDelay);
    }

    function closeHandler() { updateState(); }
    function closedHandler() { unmanage(); saveState(); }

    function manage(win) {
        if (config.maximize && state.isMaximized) win.maximize();
        if (config.fullScreen && state.isFullScreen) win.setFullScreen(true);
        win.on('resize', stateChangeHandler);
        win.on('move', stateChangeHandler);
        win.on('close', closeHandler);
        win.on('closed', closedHandler);
        winRef = win;
    }

    function unmanage() {
        if (!winRef) return;
        winRef.removeListener('resize', stateChangeHandler);
        winRef.removeListener('move', stateChangeHandler);
        clearTimeout(stateChangeTimer);
        winRef.removeListener('close', closeHandler);
        winRef.removeListener('closed', closedHandler);
        winRef = null;
    }

    // Load previous state
    try {
        state = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    } catch (e) {/* don't care */}

    validateState();

    state = {
        width: config.defaultWidth || 800,
        height: config.defaultHeight || 600,
        ...state
    };

    return {
        get x() { return state.x; },
        get y() { return state.y; },
        get width() { return state.width; },
        get height() { return state.height; },
        get displayBounds() { return state.displayBounds; },
        get isMaximized() { return state.isMaximized; },
        get isFullScreen() { return state.isFullScreen; },
        saveState, unmanage, manage, resetStateToDefault
    };
}
