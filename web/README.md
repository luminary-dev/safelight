# Safelight web

The Next.js 16 app (App Router, React 19, Tailwind v4, shadcn/ui) that is Safelight's entire
product surface, served on **http://localhost:3001**. It talks to ComfyUI on :8188 and
Ollama on :11434 over HTTP; see the root [README](../README.md) for setup and
[../docs/architecture.md](../docs/architecture.md) for the module map.

Scripts (run here, or via the repo root):

- `pnpm dev` — dev server with Turbopack on port 3001
- `pnpm build` / `pnpm start` — production build and server
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — eslint
- `pnpm test` / `pnpm test:watch` — vitest unit tests
- root `pnpm verify` — typecheck + lint + test + build, the pre-commit gate

Conventions for working in this package are in the root [AGENTS.md](../AGENTS.md).
