#!/usr/bin/env bash
# Starts the ComfyUI backend on port 8188 using the project venv.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/comfyui"
exec .venv/bin/python main.py \
  --listen 127.0.0.1 \
  --port "${COMFY_PORT:-8188}" \
  --enable-cors-header "http://localhost:3001" \
  --preview-method auto \
  --output-directory "$ROOT/outputs" \
  --input-directory "$ROOT/inputs" \
  "$@"
