# Working in this repo — conventions for agents

Safelight is a small, coherent codebase (~10k lines of TypeScript under `web/src`). These
rules come from the build brief's rules of engagement and CONTRIBUTING.md; they apply to any
agent (or human) making changes. (`web/AGENTS.md` is Next.js-generated framework guidance —
this file is the repo's own conventions.)

## Read before you write

Read the module you are about to change **in full** before editing it. The code is dense and
deliberate; most functions carry a one-line comment explaining *why*, and matching the local
shape matters more than adding new abstractions.

## Match the style

- **Named exports only** — no default exports.
- **`import "server-only"`** at the top of anything that touches disk, keys, the database,
  or child processes.
- **Terse comments that explain why**, not what. No banner comments, no restating the code.
- **Semantic design tokens, never raw hex** in components — the palette lives in
  `web/src/app/globals.css` (`--paper`, `--ink`, `--terracotta`, …) and is used through
  Tailwind utility classes (`text-ink`, `bg-paper-2`, `bg-terracotta-wash`).
- Path handling goes through `safeJoin` (`lib/safelight-files.ts`) or the realpath-aware
  `resolvePath` (`lib/agent/code-tools.ts`) — never hand-rolled string checks.

## Verify before you commit

`pnpm verify` (repo root) must be green before every commit: typecheck, lint, unit tests,
production build. CI runs the same gate plus `pnpm audit --prod` on every push and PR.

## Every user-visible change gets a CHANGELOG entry

`CHANGELOG.md` follows Keep a Changelog. Add a bullet under `[Unreleased]` in the same
change; a workstream is not done until code, tests, docs, and the changelog line all land.

## Never touch user data or key material

- Do not delete or rewrite anything under `data/`, `inputs/`, or `outputs/` without asking —
  that is the user's work.
- Never print, log, echo, or commit API keys or vault contents. Keys live encrypted in
  `data/keys.enc.json`; the API only ever exposes a `…abcd` hint, and any code you write must
  preserve that property. `data/*.migrated` files may still hold old plaintext — leave them
  alone.
- Ask before destructive or outward-facing steps: publishing, registering domains, spending
  money on third-party APIs, force-pushing.

## ComfyUI is supervised, not vendored

ComfyUI is GPL-3.0. It stays a separately-installed process the app supervises over HTTP
(`comfyui/` is gitignored and must never be committed or bundled into a distributed binary).
See [docs/adr/0001](docs/adr/0001-comfyui-is-supervised-not-vendored.md) before touching
anything that packages or redistributes.

## Other invariants

- Local-first: every mode must keep working with zero API keys and no network.
- Nothing leaves the machine without the user sending it; no silent outbound calls.
- The UI never talks to a provider directly — always through an API route.
- Agents ask before acting irreversibly: the Code-mode approval flow is the model for any
  new destructive capability.
