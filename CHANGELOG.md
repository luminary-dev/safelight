# Changelog

All notable changes to Safelight are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com); versions follow SemVer once releases begin.

## [Unreleased]

### Added
- Security hardening (Workstream P): Host allowlist and cross-origin rejection on every API
  route (DNS-rebinding and CSRF defense), `/api/code/browse` confined to the home subtree
  (`SAFELIGHT_BROWSE_ROOTS` to extend) with a SQLite-backed rate limit, a DNS-resolving SSRF
  guard with per-redirect re-checks for the design agent's fetches, symlink-aware
  (realpath) workspace confinement in the code tools, a Content-Security-Policy, and a
  dependency audit step in CI.
- Key vault (Workstream D): provider keys are encrypted at rest with AES-256-GCM under a key
  held in the macOS Keychain (env `SAFELIGHT_VAULT_KEY` or a mode-600 key file elsewhere).
  A plaintext `keys.json` migrates automatically and is kept as `keys.json.migrated` — rotate
  your keys, then delete it. Keys are validated with one cheap authenticated call on save, and
  each provider accepts a custom base URL for Azure/vLLM/LiteLLM-style gateways.
- SQLite data layer (`data/safelight.db`, WAL): migrations, a one-shot importer for the old
  `sessions.json` and `data/themes/*.json` (originals kept as `*.migrated`), daily local
  backups via `VACUUM INTO` (newest 7 kept), and `/api/export` / `/api/import` for full data
  portability. The repositories keep the old store's signatures, so no route changed.
  (Workstream C)
- Verification gate: `pnpm verify` (typecheck, lint, 94 unit tests, production build) and a
  GitHub Actions workflow running it on every push and PR. (Workstream B)
- Safelight mark as the favicon and sidebar logo, replacing the placeholder H2O icon.
- LICENSE (Business Source License 1.1), SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md,
  and architecture decision records under `docs/adr/`. (Workstream A)

### Changed
- Identity rename completed: components, libraries, localStorage keys (`studio.*` →
  `safelight.*` with a read-old-write-new migration shim), env vars (`SAFELIGHT_SESSIONS_FILE`
  / `SAFELIGHT_KEYS_FILE` preferred, old names still accepted), client ids, and new render
  and upload folders (`outputs/safelight/`, `inputs/safelight/` — files under the old
  `studio/` subfolders remain readable). (Workstream A)
- The stale duplicate mode toggle in the old header component was removed with the component;
  the left rail is the only mode switcher.

### Fixed
- `safeJoin` refused legitimate folder names beginning with `..` (e.g. `..a`) because it
  matched `..` as a string prefix rather than a path segment. Found by the new test suite.

## Pre-changelog history

The prototype phase (initial commit through Design mode) predates this changelog; see
`git log` for the narrative.
