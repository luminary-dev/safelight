#!/usr/bin/env bash
# Runs ComfyUI and the Next.js UI together. Ctrl-C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/comfy.sh" &
COMFY_PID=$!
trap 'kill $COMFY_PID 2>/dev/null || true' EXIT INT TERM
cd "$ROOT/web" && pnpm dev
