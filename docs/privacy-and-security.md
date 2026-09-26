# Privacy and security

The product promise is that nothing leaves the machine that you did not send. This page
states exactly what leaves and when, and how the localhost app is hardened. Everything here
is checkable in the code paths named.

## What leaves the machine, and when

| Action | What goes out | Where |
|---|---|---|
| Chat / agent run on a **cloud model** | your messages, attached images, and tool results | the provider you picked (OpenAI / Anthropic / Gemini), or your custom base URL |
| Chat / agent run on an **Ollama model** | nothing — `127.0.0.1:11434` | — |
| **Local render** | nothing — `127.0.0.1:8188` | — |
| **Cloud render** | the prompt (and reference images in edit mode) | OpenAI or Gemini |
| **Key save** | one authenticated validation call | that key's own provider |
| Design **`search_web`** | the search query | Brave or Tavily when their key is set, else DuckDuckGo's HTML endpoint |
| Design **`fetch_page`** | a GET request | the public URL the agent chose (SSRF-guarded, below) |

There is no telemetry, no analytics, no update check, and no other outbound call. With zero
keys configured, everything runs against localhost — the DuckDuckGo search fallback and page
fetches in Design mode are the only keyless features that touch the internet, and only when
you use that mode.

Keys never leave the machine except to their own provider, are never logged, and are never
returned over HTTP (the API exposes a `…abcd` hint at most). At rest they are AES-256-GCM
encrypted with a key held in the macOS Keychain — see
[providers-and-keys.md](providers-and-keys.md).

## Host and origin middleware

`web/src/middleware.ts` runs on every `/api/*` request:

- **Host allowlist** — the `Host` header must be `localhost`, `127.0.0.1`, or `[::1]`
  (extend with `SAFELIGHT_ALLOWED_HOSTS`), which stops DNS-rebinding pages from reaching the
  API through a hostname they control.
- **Origin check on mutating methods** — POST/PUT/PATCH/DELETE with a cross-origin `Origin`
  header is rejected (403), so a hostile web page cannot CSRF renders, key writes, or file
  edits. Requests without an Origin (curl, scripts, same-origin) pass; browsers always send
  Origin on cross-site mutations.

`web/next.config.ts` additionally sets a Content-Security-Policy,
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` on every response.

## SSRF guard on agent fetches

`lib/agent/design-tools.ts` guards every `fetch_page`:

- http/https only; `localhost`, `.local`, `.internal`, and literal private/loopback hosts
  refused up front (`guardUrl`);
- the hostname is **DNS-resolved** and refused if *any* address is loopback, private
  (10/8, 172.16/12, 192.168/16), link-local (169.254 — which covers cloud metadata
  endpoints), CGNAT (100.64/10), unspecified, or an IPv6 ULA / link-local / mapped
  equivalent (`isForbiddenAddress`, unit-tested);
- redirects are followed **by hand, max 4 hops, with the full guard re-applied on every
  hop**, so a public URL cannot bounce the fetch onto 127.0.0.1;
- 15 s timeout, HTML/text content types only, response body capped (800 KB read, 8 KB of
  text returned to the model).

## Filesystem confinement

- **Code agent:** every tool path resolves against the workspace root with `realpath` on
  both sides, so symlinks cannot smuggle access in either direction; anything outside root
  (or the user's prior grants) pauses for an explicit Allow/Deny that times out to deny.
  Read/write/listing sizes are capped. See [modes/code.md](modes/code.md).
- **Folder browser:** `GET /api/code/browse` lists directories only, confined to the home
  subtree plus `SAFELIGHT_BROWSE_ROOTS`, hides dotfiles, and is rate-limited (SQLite token
  bucket, 120/min, burst 40).
- **Images:** gallery, view, and generate routes join paths through `safeJoin`
  (`lib/safelight-files.ts`), which refuses any traversal out of `outputs/` / `inputs/`;
  filenames and subfolders containing `..` are rejected at the route too.

## Model output is untrusted

A model that has read a web page or a repo file can be carrying a prompt injection. The
mitigations in place: file writes outside the workspace require the visible approval prompt
with the exact path, the code agent cannot execute commands at all, design fetches cannot
reach private networks, and tool arguments are shown on the tool cards. Treat agent output
with the same scepticism you would any untrusted text.

## Known limitations (honest list)

- No authentication on `:3001` — safety relies on Next binding to localhost and the
  middleware above. Do not bind to `0.0.0.0`.
- Anyone with local access to the browser can use your configured providers.
- `data/*.migrated` files may retain pre-vault plaintext keys until you delete them.
- Local auth/passcode, per-route spend limits, and a "local only" master switch are planned
  (build brief Workstreams P, N, V) but not yet built.

Security reports: see [SECURITY.md](../SECURITY.md).
