# Safelight Desktop — Tauri 2 plan 

**Status: Workstream 1 core shipped** (2026-09-26, `desktop/` — attach-or-spawn
supervisor, tar-shipped web build materialized into app data, clean shutdown,
verified .app + hdiutil DMG; see `desktop/README.md`). Workstreams 2–5 below
remain the roadmap. The Docker Compose path ([deploy.md](./deploy.md)) covers
servers; this covers the download-and-double-click install.

## Goal

A signed, auto-updating desktop app for macOS/Windows/Linux whose shell
supervises three child processes — the Next.js server, ComfyUI, and
(optionally) Ollama — so a person who does not know what `pnpm` is can
install Safelight. The GPL boundary from
[ADR 0001](./adr/0001-comfyui-is-supervised-not-vendored.md) holds: ComfyUI
is **installed from upstream on first run**, never bundled in the app binary
or installer. Legal review before shipping is still required by the ADR.

## Architecture

```
Tauri shell (Rust)
├─ WebView → http://127.0.0.1:3001  (the existing UI, unchanged)
├─ Supervisor (Rust)
│   ├─ node server.js        (Next standalone build, port 3001)
│   ├─ <venv>/python main.py (ComfyUI, port 8188, installed on first run)
│   └─ ollama serve          (only if we installed it; else attach to existing)
├─ Tauri plugins: dialog, notification, updater, shell/process
└─ First-run wizard (a route in the existing Next app, driven via Tauri IPC)
```

The web app stays the product; Tauri adds supervision and OS integration.
No UI rewrite.

## Workstream 1 — Process supervision (the core)

Rust `Supervisor` managing three `ManagedProcess` entries, each with:

- spawn spec (binary, args, env, cwd), log capture to
  `$APPDATA/safelight/logs/<name>.log` (rotating)
- readiness probe: `GET /api/health` (next), `GET /system_stats` (comfy),
  `GET /api/version` (ollama)
- restart policy: exponential backoff, max 5 restarts / 10 min, then surface
  a native notification + status page
- clean shutdown: SIGTERM, 10 s grace, SIGKILL; kill the whole process group
  so Comfy's workers die too (Windows: Job Objects)
- port conflict handling: probe 3001/8188/11434 before spawn; if occupied by
  a *healthy* instance of the right service, attach instead of spawn (this is
  how a dev's native Ollama keeps working)

Child specs:

- **Next server**: ship the `web` standalone build (`.next/standalone`) as a
  Tauri resource plus a pinned Node runtime (or `node` sidecar binary ~50 MB;
  alternative: try Bun/pkg later, not v1). Env: `PORT=3001`,
  `HOSTNAME=127.0.0.1` (never 0.0.0.0 in desktop),
  `SAFELIGHT_DATA_DIR=$APPDATA/safelight/data`,
  `COMFY_OUTPUT_DIR/INPUT_DIR` under the same root, `COMFY_URL`, `OLLAMA_URL`.
- **ComfyUI**: run from the app-managed install (Workstream 2) with the same
  flags as `scripts/comfy.sh` (`--listen 127.0.0.1 --port 8188
  --enable-cors-header http://localhost:3001 --output-directory …`).
- **Ollama**: detect an existing install (`~/.ollama`, PATH, launchd); offer
  to download the official installer if missing; never bundle.

## Workstream 2 — Python side, installed on first run (GPL-safe)

First run (or repair), the shell:

1. Downloads `uv` (single static binary, permissive license — this *can* be
   bundled) if not present.
2. `uv venv` in `$APPDATA/safelight/comfyui/.venv`, pinned Python (3.12).
3. Clones/downloads a **pinned ComfyUI release tag** from upstream GitHub
   into `$APPDATA/safelight/comfyui` + installs ComfyUI-GGUF custom node,
   `uv pip install -r requirements.txt` (CUDA/MPS/CPU torch chosen from
   detected hardware).
4. Applies `patches/comfyui-gguf-convert.patch` — the local `convert.py` fix
   the README currently says to re-apply by hand (it silently breaks
   Qwen-Image 2.1 GGUF loading after a re-clone). **Codebase change: create
   this patch file in the repo** (`git diff` of the current hand-edit) so it
   is versioned; re-check upstream each release and drop it when fixed.
5. Verifies with a no-op ComfyUI boot + `/system_stats`.

Everything downloaded lands in app data, not in the app bundle — the
installer we sign and distribute contains zero GPL code.

## Workstream 3 — OS integration

- **Keychain**: the vault (`web/src/lib/secrets/vault.ts`) already prefers
  the macOS keychain via the `security` CLI and falls back to a key file.
  Desktop change: implement a small `GET/SET vault key` Tauri command using
  the `keyring` crate (macOS Keychain, Windows Credential Manager, libsecret)
  and have the shell inject the key as `SAFELIGHT_VAULT_KEY` into the Next
  child's env. **Codebase change: none required** (the env path already
  wins in `vaultKey()`); optionally later delete the `security` CLI branch.
- **File dialogs**: replace path-typing in Code mode with
  `tauri-plugin-dialog`. **Codebase change:** a `isTauri()` runtime check in
  the folder-picker UI; picked paths must then be added to
  `SAFELIGHT_BROWSE_ROOTS` (or a successor DB setting) so the browse API
  accepts them — today the roots come from env at boot, so either restart the
  child with updated env or (better) move browse roots into the settings DB
  (small `web/src/app/api/code/browse` change).
- **Notifications**: `tauri-plugin-notification` for render-complete /
  agent-finished. **Codebase change:** the web app emits these via a tiny
  `window.__TAURI__`-aware helper; falls back to the Web Notifications API in
  plain browsers.
- **Menu/tray**: status of the three children, "Open logs", "Restart
  ComfyUI", quit.

## Workstream 4 — Auto-update, signing, release

- `tauri-plugin-updater` with a static JSON feed on GitHub Releases; updater
  keypair generated once and stored in CI secrets. Updates replace only the
  shell + web build; the Python side is versioned separately by Workstream 2
  (a `comfyui.lock` file records tag + patch hashes, migrated on app update).
- Signing: macOS Developer ID + notarisation (`tauri build` handles stapling),
  Windows Authenticode (EV cert or Azure Trusted Signing), Linux AppImage +
  `.deb` (signed repo optional later).
- CI: tag → matrix build (macos-14 arm64 + x86_64, windows, ubuntu) →
  `tauri-action` → GitHub Release with notes from `CHANGELOG.md` → update
  feed. Release automation.

## Workstream 5 — First-run wizard

A `/welcome` route in the existing Next app, shown by the shell when
`$APPDATA/safelight/.initialized` is absent: detect hardware (via a Tauri
command reporting RAM/GPU), recommend a model set, drive model downloads
through the existing model manager, check/offer Ollama, collect optional API
keys (into the vault), pick a theme.

## Required codebase changes (summary for the executing session)

1. `web`: keep `output: "standalone"` (done for Docker; the desktop build
   reuses it).
2. Repo: add `patches/comfyui-gguf-convert.patch` + apply/verify script.
3. Move Code-mode browse roots from env to the settings DB (enables dialog-
   picked folders without child restart).
4. Notification helper with Tauri/browser fallback.
5. New top-level `desktop/` Tauri 2 project (`pnpm create tauri-app`,
   Rust ≥ 1.77): `supervisor.rs`, `python_install.rs`, `vault.rs`, tray,
   updater config. Do not scaffold until Rust is installed.
6. CI workflows for the matrix build + release feed.

## Non-goals for v1

Windows GPU auto-setup beyond CUDA detection, Linux distro packages beyond
AppImage/deb, bundling Node alternatives, multi-instance support.

## Open questions

- Node sidecar vs. system Node: sidecar (pinned, ~50 MB) is the plan; verify
  notarisation of the extra binary.
- Ollama license permits redistribution (MIT), but the installer-download
  approach keeps our bundle small — decide by first beta.
- Legal review checkpoint from ADR 0001 before the first public installer.
