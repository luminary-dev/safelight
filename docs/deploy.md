# Deploying Safelight with Docker Compose

This is the **server / headless path**: one Linux box (ideally with an NVIDIA
GPU) running all three services, reached from browsers on the LAN. For the
desktop path see [desktop-plan.md](./desktop-plan.md).

## The honest macOS note

Docker on macOS runs containers inside a Linux VM with **no GPU passthrough**
— no Metal, no MPS. A containerised ComfyUI on a Mac renders on CPU and is
unusably slow for image models. On this Mac, the recommended setup stays
native:

- `scripts/comfy.sh` — ComfyUI in its own venv on Metal (port 8188)
- `pnpm --dir web dev` or `scripts/dev.sh` — the app (port 3001)
- Ollama.app — local chat models (port 11434)

Compose on macOS is still useful for testing the `web` image itself.

## Licensing boundary (read before touching images)

ComfyUI is GPL-3.0 and is **never redistributed** with Safelight
([ADR 0001](./adr/0001-comfyui-is-supervised-not-vendored.md)). The compose
setup respects this strictly:

- `comfyui.Dockerfile` copies **only `requirements.txt`** (a dependency list)
  from your clone; the image contains Python + pip packages, zero ComfyUI code.
- The service **bind-mounts your local `./comfyui` clone** into the container
  at start (`./comfyui:/app`).
- **Never push or publish any image built from this repo's compose file.**

You must have cloned ComfyUI into `./comfyui` yourself (see
[getting-started.md](./getting-started.md)) before `docker compose up`.

## What runs where

| Service   | Image                              | Port  | Role |
|-----------|------------------------------------|-------|------|
| `web`     | built from `./web` (Next.js standalone, node:22-slim, non-root) | 3001 | The Safelight app and API |
| `comfyui` | built from `comfyui.Dockerfile` (python:3.12-slim, deps only) + your `./comfyui` mount | 8188 | Image/video rendering |
| `ollama`  | `ollama/ollama:latest`             | 11434 | Local chat models |

Wiring (set in `docker-compose.yml`):

- `web → comfyui`: server-side over the compose network, `COMFY_URL=http://comfyui:8188`.
- `web → ollama`: server-side, `OLLAMA_URL=http://ollama:11434`.
- **browser → comfyui**: the render-progress WebSocket (`NEXT_PUBLIC_COMFY_WS`)
  is opened by the *browser*, not the server. It is a **build-time** value
  (Next.js inlines `NEXT_PUBLIC_*` into the client bundle), so it must point
  at the ComfyUI port as reachable from the browser — the server's LAN
  address, not the compose hostname. That is why port 8188 is published.

## First run (Linux server)

```sh
git clone <safelight> && cd safelight
git clone https://github.com/comfyanonymous/ComfyUI comfyui   # your own clone
cp .env.example .env
```

Edit `.env`:

```sh
# hostnames browsers will use — anything else gets 403 from the middleware
SAFELIGHT_ALLOWED_HOSTS=192.168.1.10,safelight.lan
# browser-reachable ComfyUI WebSocket (build-time!)
NEXT_PUBLIC_COMFY_WS=ws://192.168.1.10:8188
# pin the vault key so encrypted provider keys survive volume moves
SAFELIGHT_VAULT_KEY=<openssl rand -hex 32>
```

Then:

```sh
docker compose up -d --build
curl http://localhost:3001/api/health
```

`SAFELIGHT_VAULT_KEY` must be added under `web.environment` in the compose
file or an override if you set it (the shipped file passes only
`SAFELIGHT_ALLOWED_HOSTS` through). Without it, Linux containers fall back to
a generated `/data/.vault-key` file inside the data volume, which also works
— just back the volume up as a unit.

### GPU (NVIDIA)

1. Install the NVIDIA driver + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
2. In `comfyui.Dockerfile`, switch the torch install to the CUDA block (comments inline) and remove `--cpu` from the CMD.
3. Uncomment the `deploy.resources.reservations.devices` blocks on `comfyui` (and optionally `ollama`) in `docker-compose.yml`.
4. `docker compose up -d --build comfyui`.

The default definition is CPU-only so `docker compose config` and first runs
work anywhere; treat CPU rendering as a smoke test, not a deployment.

## LAN access and the host allowlist

Two layers must both allow the client:

1. **Middleware host allowlist** (`web/src/middleware.ts`): every `/api/*`
   request whose `Host` is not `localhost`/`127.0.0.1`/`[::1]` or listed in
   `SAFELIGHT_ALLOWED_HOSTS` is rejected with 403. This is the DNS-rebinding
   defence — list every hostname/IP users will type, without ports.
2. **Origin check on mutating requests**: cross-origin POST/PUT/PATCH/DELETE
   are rejected unless the Origin's host is allowlisted. Same variable.

Known limitation for LAN browsers (needs a source change, out of scope for
the deploy work): the CSP in `web/next.config.ts` allows WebSocket/connect
targets only on `localhost`/`127.0.0.1`, so the browser's direct ComfyUI
WebSocket (`ws://<server-ip>:8188`) is blocked by CSP when the app is opened
from another machine. Rendering still works (the server drives ComfyUI);
what degrades is live progress streaming in the browser. Track this as a
follow-up: extend `connect-src` (and `NEXT_PUBLIC_COMFY_WS`) for the
configured LAN host.

Do **not** expose port 3001 to the internet. There is no authentication
(future work). If you need remote access, put it behind a
VPN (Tailscale/WireGuard) and allowlist that hostname.

## Volumes and backups

| Volume / mount        | Contents | Backup |
|-----------------------|----------|--------|
| `safelight-data` (named volume → `/data`) | SQLite DB (`safelight.db`), encrypted key vault (`keys.enc.json`), `.vault-key` fallback, sessions | **Yes — this is the important one.** `docker run --rm -v safelight_safelight-data:/data -v "$PWD":/backup alpine tar czf /backup/safelight-data.tgz -C /data .` (stop `web` first, or rely on SQLite journaling). The app's own `/api/export` also produces a portable export. |
| `./outputs` (bind → `/outputs`) | Rendered images/videos | rsync like any folder |
| `./inputs` (bind → `/inputs`)  | Uploads | rsync |
| `./comfyui` (bind → `/app` in comfyui, `/comfyui` ro in web) | Your ComfyUI clone incl. `models/` | Models are re-downloadable; back up `extra_model_paths.yaml` and any local patches (e.g. the `convert.py` GGUF patch — see README) |
| `ollama-models` (named volume) | Pulled Ollama models | Re-pullable; skip unless bandwidth matters |

Restore = recreate volumes, untar into `/data`, `docker compose up -d`. If
you restore `/data` onto a machine without the same `SAFELIGHT_VAULT_KEY`
(or the same `.vault-key` file), the encrypted provider keys are
undecryptable — re-enter them in Settings.

Note on the shared model tree: `comfyui/extra_model_paths.yaml` may point at
an absolute host path (e.g. `~/models`). Inside the container that path does
not exist unless you mount it at the **same absolute path** on both services,
or keep models under `comfyui/models/` (covered by the clone mount).

## Health checks

- `web`: `GET /api/health` via node fetch — also reports ComfyUI, Ollama,
  disk and provider status as JSON; the sidebar polls the same endpoint.
- `comfyui`: `GET /system_stats` via python urllib.
- `ollama`: `ollama ps` inside the container.

`docker compose ps` shows all three; `web` starts even while its siblings are
still coming up and reports them as down in `/api/health` until they are ready.

## Ports summary

- `3001` — Safelight (the only port users need)
- `8188` — ComfyUI (published for the browser WebSocket; remove the mapping
  if you accept losing browser-side progress streaming)
- `11434` — Ollama (published for host-side `ollama` CLI debugging only;
  safe to remove)
