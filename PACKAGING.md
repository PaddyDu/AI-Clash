# Packaging ADU AI

End-to-end instructions for producing signed + notarized macOS DMGs and portable Windows EXEs.

## Output layout

```
/tmp/adu-ai-builds/
├── ADU AI-1.0.0-x64.dmg       macOS Intel       (notarized, stapled)
├── ADU AI-1.0.0-arm64.dmg     macOS Apple Silicon (notarized, stapled)
├── ADU AI-1.0.0-x64.exe       Windows x64 portable
└── ADU AI-1.0.0-arm64.exe     Windows ARM64 portable
```

## macOS

### 1. One-time: certificate + notarization credentials

1. **Developer ID Application certificate** — create via Keychain Access → Certificate Assistant → "Request a Certificate From a Certificate Authority" (save to disk), then upload at https://developer.apple.com/account/resources/certificates/list → `+` → **Developer ID Application**. Download and double-click the `.cer` to install.

   Verify: `security find-identity -v -p codesigning` should list `Developer ID Application: …`.

2. **App-Specific Password** — generate at https://account.apple.com → App-Specific Passwords. Save it to your local keychain via notarytool (optional but recommended):
   ```sh
   xcrun notarytool store-credentials AC_PASSWORD \
     --apple-id "your-apple-id@example.com" \
     --team-id "XXXXXXXXXX" \
     --password "xxxx-xxxx-xxxx-xxxx"
   ```

3. **Environment** — electron-builder reads these three on build (add to `~/.zshrc`):
   ```sh
   export APPLE_ID="your-apple-id@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="XXXXXXXXXX"
   ```

### 2. Build

```sh
npm run pack-mac
```

Per arch this runs: pack → afterPack (clear xattrs) → codesign → notarize (uploads `.app.zip`, waits) → build DMG. Both archs take ~25-45 minutes total depending on Apple notary queue.

### 3. Staple the DMG itself

`pack-mac` notarizes the `.app` inside each DMG but doesn't staple the DMG container. To make first-mount work offline:

```sh
xcrun notarytool submit "/tmp/adu-ai-builds/ADU AI-1.0.0-x64.dmg" \
    --keychain-profile AC_PASSWORD --wait
xcrun stapler staple "/tmp/adu-ai-builds/ADU AI-1.0.0-x64.dmg"

xcrun notarytool submit "/tmp/adu-ai-builds/ADU AI-1.0.0-arm64.dmg" \
    --keychain-profile AC_PASSWORD --wait
xcrun stapler staple "/tmp/adu-ai-builds/ADU AI-1.0.0-arm64.dmg"
```

### 4. Verify

```sh
xcrun stapler validate "/tmp/adu-ai-builds/ADU AI-1.0.0-x64.dmg"
# Mount and check Gatekeeper acceptance
hdiutil attach "/tmp/adu-ai-builds/ADU AI-1.0.0-x64.dmg" -nobrowse -quiet
spctl --assess --type execute --verbose "/Volumes/ADU AI 1.0.0/ADU AI.app"
# Expect: "accepted  source=Notarized Developer ID"
hdiutil detach "/Volumes/ADU AI 1.0.0" -quiet
```

### Known issues on macOS Sequoia / Tahoe

- **Universal builds fail to codesign.** The `lipo` merge step combined with `com.apple.provenance` xattr that SIP refuses to let us strip results in `codesign: resource fork, Finder information, or similar detritus not allowed`. Workaround: build per-arch (`--arm64 --x64`) instead of `--universal`.
- **iCloud-synced directories pollute helpers.** Builds under `~/Desktop` or `~/Documents` get `com.apple.FinderInfo` added by the iCloud File Provider on every write, breaking codesign. We build into `/tmp/adu-ai-builds` instead (configured in `package.json` → `build.directories.output`).
- **`scripts/after-pack.js`** runs `xattr -c` on every directory inside the packaged `.app` before signing — required even on /tmp.

## Windows

No code signing (we don't have a Windows certificate). Output is a portable EXE — users run it directly, no installer.

```sh
npm run pack-win                                # both archs at once
# or
npx electron-builder --win=portable --x64       # x64 only
npx electron-builder --win=portable --arm64     # arm64 only
```

electron-builder generates three files per multi-arch run: per-arch EXEs and a fat combined EXE (~160 MB). Delete the combined one if you only need per-arch:

```sh
rm "/tmp/adu-ai-builds/ADU AI-1.0.0.exe"   # the fat one
```

### Windows caveats

- **SmartScreen warning** — without a code-signing cert, first launch shows "Windows protected your PC". Users click **More info → Run anyway**. To remove this, a Windows code-signing cert (~$80-200/yr from DigiCert, Sectigo, etc.) is required.
- **Icon cache** — if a previous build with the same filename was opened on the target machine, Windows may still show the old icon. Either rename the file or clear the icon cache:
  ```cmd
  taskkill /im explorer.exe /f
  del /a /q "%localappdata%\IconCache.db" "%localappdata%\Microsoft\Windows\Explorer\iconcache_*.db"
  start explorer.exe
  ```

## Linux

```sh
npm run pack-linux
```

Produces an AppImage. No signing needed.
