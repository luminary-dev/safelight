# Changelog

All notable changes to Safelight are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com); versions follow SemVer once releases begin.

## [Unreleased]

### Added
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
