# Design mode

A design scout: an agent that explores the live web for real visual references, then designs
UI themes grounded in what it finds.
Component: `web/src/components/DesignWorkspace.tsx` → `ChatMode.tsx` with
`agentEndpoint="/api/design"`. Backend: `POST /api/design` (NDJSON); tools in
`web/src/lib/agent/design-tools.ts`.

> **TODO(screenshot):** a design session with a fetched reference and a theme swatch card.

## The tools

- **`search_web`** — runs through a provider chain (`lib/search/chain.ts`): Brave Search API
  when `BRAVE_SEARCH_API_KEY` is set, then Tavily when `TAVILY_API_KEY` is set, then the
  keyless DuckDuckGo HTML fallback. Results are cached in SQLite for one hour keyed by the
  normalised query, and the tool card names which provider answered.
- **`fetch_page`** — fetches a public page and returns its readable text plus every hex
  color and `font-family` found in the source (up to 24 colors and 12 fonts). Fetches are
  guarded against SSRF: URL sanity checks, DNS resolution with rejection of loopback /
  private / link-local / CGNAT / ULA / metadata addresses, redirects followed by hand with
  the guard re-applied on every hop, a 15 s timeout, and HTML/text content types only. See
  [../privacy-and-security.md](../privacy-and-security.md).
- **`save_theme`** — stores a finished theme in the database (`themes` table in
  `data/safelight.db`): a kebab-case name, one-line description, six hex colors (`bg`,
  `surface`, `text`, `muted`, `accent`, `accentText`) and font choices (display, body,
  mono). Colors are validated as 6-digit hex server-side, and **WCAG AA contrast is
  enforced in code** (`lib/theme/contrast.ts`): a theme whose text-on-background,
  text-on-surface, or accent-text-on-accent pair falls below 4.5:1 is rejected with the
  failing ratios named, never stored.

## Theme cards

A saved theme renders in the conversation as a live swatch card in the theme's own colors —
name, font pairing, description, a sample button and card, and the six swatches. The system
prompt asks the model to cite what inspired each choice; contrast is enforced at save time
(above), so every card you see already passes AA.

From the card a theme can be **applied live to Safelight itself** — persisted, restored on
boot, with a Reset control to return to the stock themes (`POST /api/themes/<name>` with
`{action:"apply"|"clear"}`, `lib/theme/apply.ts`) — and **exported** as plain CSS custom
properties, a Tailwind v4 `@theme` block, or W3C DTCG design-tokens JSON
(`GET /api/themes/<name>?format=css|tailwind|tokens`).

Saved themes are included in `/api/export` and imported by `/api/import`.

## Sessions

Design sessions are always in agent mode (no toggle), keep their own model and messages, and
title themselves from your first request. Only tool-capable models are offered.
