# ADU AI

Desktop client for Perplexity.AI and Claude.AI, with a built-in Clash-style proxy (mihomo core) scoped only to this app.

## Features

- **Perplexity / Claude in one window** — switch via menu or `Cmd/Ctrl+P` / `Cmd/Ctrl+L`. Last selected URL persists across launches.
- **Per-app proxy via Clash subscription** — add any Clash subscription URL, pick a node, toggle on. Traffic from this app routes through mihomo's local mixed-port; the system proxy and other apps are untouched.
  - Supports SS / VMess / Trojan / Hysteria / etc. (everything mihomo supports)
  - Switches nodes live via mihomo's REST API — no process restart
  - First-run downloads mihomo via China-friendly mirrors (`ghfast.top` → `gh-proxy.com` → `github.com`), with a real-time progress bar
  - Auto-restarts mihomo on next launch if proxy was on; cleans up the child process on exit, force-quit, and crash
- **Persistent window state** — size and display preference remembered.
- **Find in page**, spell-check, context-menu copy/cut/paste, zoom controls.

## Develop

```sh
npm install
npm start
```

> On macOS, if your shell exports `ELECTRON_RUN_AS_NODE=1`, every Electron app launches as plain Node and breaks silently. The `start` script clears it defensively, but unsetting it globally (`unset ELECTRON_RUN_AS_NODE`) is recommended.

## Build

```sh
# macOS (universal lipo on Tahoe is broken — we build per-arch instead)
npm run pack-mac        # → /tmp/adu-ai-builds/ADU AI-1.0.0-{x64,arm64}.dmg

# Windows (portable, no installer)
npm run pack-win        # → /tmp/adu-ai-builds/ADU AI-1.0.0-{x64,arm64}.exe

# Linux
npm run pack-linux
```

### macOS code signing & notarization

For Mac builds, electron-builder reads three environment variables to sign and notarize automatically:

```sh
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"  # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="XXXXXXXXXX"
```

Prerequisites: a **Developer ID Application** certificate installed in the login keychain. After building, the `.app` inside each DMG is notarized; the DMG containers can be stapled separately with `xcrun stapler staple`.

### Build caveats

- Build output goes to `/tmp/adu-ai-builds` because iCloud-synced directories (e.g. `~/Desktop`) stamp `com.apple.FinderInfo` on every helper bundle, which codesign rejects.
- `scripts/after-pack.js` clears extended attributes on the packaged `.app` before signing, also necessary on macOS Sequoia/Tahoe.
- See [PACKAGING.md](./PACKAGING.md) for the full notarization + stapling walkthrough.

## Architecture

| Path | Role |
|------|------|
| [`index.js`](./index.js) | Electron main process: windows, menus, IPC, session proxy, shutdown cleanup |
| [`window-state.js`](./window-state.js) | Inlined replacement for `electron-window-state` (the upstream's CJS deps trip Electron's ESM loader) |
| [`proxy/mihomo.js`](./proxy/mihomo.js) | mihomo binary lifecycle: download (with mirror fallback), extract, start/stop, PID-file recovery on crashed sessions |
| [`proxy/manager.js`](./proxy/manager.js) | Subscription CRUD, node selection, runtime config generation, controller REST client |
| [`settings.html`](./settings.html) | Settings window UI: subscriptions, nodes, proxy toggle, download progress |
| [`scripts/after-pack.js`](./scripts/after-pack.js) | electron-builder hook: strip xattrs before codesign |
| [`build/entitlements.mac.plist`](./build/entitlements.mac.plist) | Hardened-runtime entitlements (JIT, network, etc.) |

## Acknowledgements

This project is a fork of [**Wiselabs/simplexity**](https://github.com/Wiselabs/simplexity) by Franklin Ronald — the original Perplexity / Claude Electron wrapper. The Clash-style proxy and related rework on top of it are new.

The mihomo (Clash.Meta) core powering the proxy is from [**MetaCubeX/mihomo**](https://github.com/MetaCubeX/mihomo).

Shared & promoted on [**LINUX DO**](https://linux.do) — discussion thread: [linux.do/t/topic/2187361](https://linux.do/t/topic/2187361).

## License

BSD-3-Clause

