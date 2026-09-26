# ADR 0001 — ComfyUI is supervised over HTTP, never redistributed

ComfyUI is GPL-3.0. Safelight keeps it as a separately-installed process that the app
supervises over HTTP (localhost:8188): the `comfyui/` clone is gitignored, never committed,
and must never be bundled into a distributed Safelight binary. Setup instructions install it
from upstream. Legal review is required before any packaging work (Workstream Q) changes this
boundary.
