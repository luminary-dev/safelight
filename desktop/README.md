# Safelight Desktop (Tauri 2)

The desktop shell from [docs/desktop-plan.md](../docs/desktop-plan.md): a WebView
onto the local app plus a supervisor for the web server. v1 implements
plan Workstream 1's core; see "Not yet" below for the rest.

## What it does

- **Attach or spawn**: probes 3001 → 3210 → 3220. A healthy Safelight server
  (e.g. your dev server) is attached to, never touched on quit. Otherwise the
  shell extracts the bundled web build into app data and starts its own server
  with `SAFELIGHT_DATA_DIR`, outputs/inputs, and logs under
  `~/Library/Application Support/com.luminary.safelight/`.
- **Own data**: the packaged app keeps its own SQLite DB and folders — it never
  reads the repo's `data/`.
- **ComfyUI / Ollama**: attach-only. If they run (any install), the app uses
  them; if not, the UI reports them down honestly.
- **Clean shutdown**: quitting kills the spawned server (attached ones are left
  alone).

## Build

```sh
rustup toolchain: stable (>= 1.77)   # rustup.rs
pnpm --dir web build                 # standalone output
pnpm --dir desktop install
pnpm --dir desktop assemble          # packs web.tar (pnpm symlinks survive tar, not resource copies)
pnpm --dir desktop tauri build       # .app in src-tauri/target/release/bundle/macos
```

DMG (Tauri's Finder-scripted DMG needs a GUI session; this doesn't):

```sh
cd desktop/src-tauri/target/release/bundle
mkdir dmg-stage && cp -R macos/Safelight.app dmg-stage/ && ln -s /Applications dmg-stage/Applications
hdiutil create -volname Safelight -srcfolder dmg-stage -ov -format UDZO Safelight_$(date +%Y%m%d).dmg
rm -rf dmg-stage
```

## Env

- `SAFELIGHT_DESKTOP_PORT` — preferred port (default **3210**, the app's own production
  server). Set `3001` explicitly to attach to a running dev server — note WKWebView renders
  Turbopack dev output as a white page, so that is for server-side testing, not for using
  the app. The bundle carries an ATS `NSAllowsLocalNetworking` exception so plain
  http://127.0.0.1 loads at all in a release WebView.
- `SAFELIGHT_NODE` — node binary override; otherwise a login-shell
  `command -v node`, then Homebrew paths.

## Known limitations

Killing the shell with SIGTERM/`pkill` (instead of quitting normally) orphans a spawned
web server; the next launch attaches to it, so behavior stays correct, but the process
lingers until killed. Process-group shutdown is on the plan (Workstream 1).

## Not yet (per the plan)

Node sidecar (system Node 22+ is required today), ComfyUI first-run install
(Workstream 2), keyring vault command, dialogs/notifications/tray
(Workstream 3), updater + signing + CI matrix (Workstream 4), first-run wizard
(Workstream 5). The bundle is unsigned: right-click → Open on first launch.
