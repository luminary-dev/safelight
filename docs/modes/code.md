# Code mode

A workspace-scoped coding agent: point a session at a folder, and a tool-capable model can
explore and edit files inside it — and nowhere else, without asking.
Component: `web/src/components/CodeWorkspace.tsx` → `ChatMode.tsx` with
`agentEndpoint="/api/code"`. Backend: `POST /api/code` (NDJSON) +
`POST /api/code/approve`; tools in `web/src/lib/agent/code-tools.ts`.

> **TODO(screenshot):** a code session with an approval prompt and "Also allowed" chips.

## The workspace folder

Type an absolute path or pick one with the folder browser (backed by `GET /api/code/browse`,
which is confined to your home subtree — extend with `SAFELIGHT_BROWSE_ROOTS` — and
rate-limited). The route refuses relative paths, the filesystem root, and folders that do not
exist. Each code session remembers its root, model, messages, and approved paths.

## The tools

All file tools resolve paths against the workspace root with symlink-aware (`realpath`)
confinement:

| Tool | What it does | Limits |
|---|---|---|
| `list_files` | recursive listing, optional substring filter | 400 entries, depth 6, skips `.git`/`node_modules`/`.next`/`.venv`/`dist`/`build`/… |
| `glob` | match paths by pattern (`*`, `**`, `?`) | 400 results |
| `grep` | regex search over file contents | 200 matches, skips binaries and files > 512 KB |
| `read_file` | numbered lines with offset/limit paging (`totalLines` returned) | 256 KB per file, refuses binaries |
| `edit_file` | exact string replacement; must be unique unless `replace_all` | — |
| `multi_edit` | a batch of exact replacements, possibly across files, validated first and applied all-or-nothing | — |
| `write_file` | create or overwrite, parents created | 512 KB |
| `delete_file` / `move_file` | remove or relocate one file | — |
| `run_command` | one shell command (`/bin/sh -c`) with the workspace as cwd; returns exit code, stdout, stderr | **every call pauses for your approval of the exact command**; scrubbed child environment; timeout 60 s default, 300 s max |

**Command execution is approval-gated, always.** There is no allowlist and no "remember
this command": each `run_command` call shows the exact command in an Allow/Deny card
before anything runs.

## The approval flow

Any path that resolves outside the workspace root pauses the run: the server emits an
`approval` event, and the conversation shows a card — *"The agent wants read file access
outside the workspace: /the/real/path"* — with **Allow** and **Deny** buttons that answer
via `POST /api/code/approve`. Approvals time out to deny after 180 s so an abandoned run
never hangs, and a denial surfaces to the model as an error it must work around.

Allowed paths (files or whole subtrees) are remembered on the session and shown as
**"Also allowed"** chips under the workspace bar; click a chip's × to revoke it. Approved
paths are sent with each run, so they persist across runs and reloads — the in-flight
question itself does not survive a server restart.

## Runs

Code runs get a larger loop budget than chat (60 rounds vs the default 24), stream as NDJSON
tool cards, retry transient provider failures with backoff, and can be stopped mid-run — the
abort propagates into the provider call and tool loop. Only tool-capable models are offered
in the picker.
