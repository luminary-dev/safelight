# Providers and keys

Safelight is fully functional with zero API keys: ComfyUI renders images, Ollama serves chat
models. OpenAI, Anthropic, Gemini, OpenRouter, and Groq are opt-in accelerants — all five
add chat models (with streaming and agent-mode tool calling; OpenRouter and Groq speak the
OpenAI-compatible wire format), OpenAI and Gemini add image models. Code:
`web/src/lib/providers/` and `web/src/lib/secrets/vault.ts`.

## The key vault

Keys are stored encrypted at rest in `data/keys.enc.json` (AES-256-GCM). The vault key is
resolved in order:

1. `SAFELIGHT_VAULT_KEY` — 64 hex chars, mainly for tests and headless setups
2. the **macOS Keychain** (`security` generic password, service `safelight-vault`) — created
   automatically on first use, so nothing sensitive sits in a readable file on macOS
3. a generated mode-600 key file `data/.vault-key`, as a last resort on other platforms

A pre-vault plaintext `data/keys.json` migrates automatically on first read and is kept as
`keys.json.migrated` — **rotate those keys, then delete the file.**

Keys are only ever used server-side. The API never returns a key: `GET /api/keys` reports
per-provider status with at most a `…abcd` hint and whether the key came from the vault or
the environment.

## Setting keys

Sidebar → key icon opens the Keys dialog. On save the key is **validated with one cheap
authenticated call** (a models listing) and the dialog reports "Key works", "The provider
rejected this key", quota problems, or unreachability — instead of failing silently at use
time. Saving also refreshes the model catalog.

Environment variables work as fallbacks when no vault entry exists:

| Provider | Env var | Adds |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | chat + image models |
| Anthropic | `ANTHROPIC_API_KEY` | chat models |
| Gemini | `GEMINI_API_KEY` | chat + image models |
| OpenRouter | `OPENROUTER_API_KEY` | chat models (full catalog, labels from its API) |
| Groq | `GROQ_API_KEY` | chat models |

## Custom base URLs

Each provider accepts a custom endpoint for Azure OpenAI, self-hosted vLLM, LiteLLM proxies,
and similar gateways. Resolution order: the `SAFELIGHT_<PROVIDER>_BASE_URL` env var first
(`SAFELIGHT_OPENAI_BASE_URL`, `SAFELIGHT_ANTHROPIC_BASE_URL`, `SAFELIGHT_GEMINI_BASE_URL`,
`SAFELIGHT_OPENROUTER_BASE_URL`, `SAFELIGHT_GROQ_BASE_URL`), then a `baseUrl`
stored alongside the key in the vault (settable through `POST /api/keys` with
`{ provider, key, baseUrl }`; the Keys dialog does not expose a field for it yet). Defaults:
`https://api.openai.com/v1`, `https://api.anthropic.com`,
`https://generativelanguage.googleapis.com`, `https://openrouter.ai/api/v1`,
`https://api.groq.com/openai/v1`.

## Local backends

- **ComfyUI** — `COMFY_URL` (default `http://127.0.0.1:8188`); the browser's live-progress
  WebSocket uses `NEXT_PUBLIC_COMFY_WS` (default `ws://127.0.0.1:8188`).
- **Ollama** — `OLLAMA_URL` (default `http://127.0.0.1:11434`). Pulled models appear in the
  picker tagged with their reported capabilities (`vision`, `tools`).

## Search providers (Design mode)

- `BRAVE_SEARCH_API_KEY` — Brave Search API, preferred when set
- `TAVILY_API_KEY` — Tavily, second in the chain
- no key — the DuckDuckGo HTML fallback still works

## All environment variables

| Variable | Purpose | Default |
|---|---|---|
| `SAFELIGHT_DATA_DIR` | data root (DB, keys, backups) | `<repo>/data` |
| `SAFELIGHT_VAULT_KEY` | vault key override (64 hex) | keychain / key file |
| `SAFELIGHT_KEYS_FILE` | encrypted keys file path | `data/keys.enc.json` |
| `SAFELIGHT_SESSIONS_FILE` | legacy sessions.json path for the one-shot import | `data/sessions.json` |
| `SAFELIGHT_ALLOWED_HOSTS` | extra hostnames allowed to reach the API (comma-separated) | localhost only |
| `SAFELIGHT_BROWSE_ROOTS` | extra folder-browser roots (colon-separated absolute paths) | home directory |
| `SAFELIGHT_OPENAI_BASE_URL` etc. | per-provider gateway URLs | provider defaults |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` | key fallbacks | — |
| `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` | search providers | DDG fallback |
| `COMFY_URL` / `NEXT_PUBLIC_COMFY_WS` / `COMFY_PORT` | ComfyUI endpoints | `127.0.0.1:8188` |
| `COMFY_OUTPUT_DIR` / `COMFY_INPUT_DIR` | render and upload folders | `<repo>/outputs`, `<repo>/inputs` |
| `OLLAMA_URL` | Ollama endpoint | `http://127.0.0.1:11434` |

(The pre-rename `STUDIO_SESSIONS_FILE` / `STUDIO_KEYS_FILE` are still accepted for the
legacy migration paths.)
