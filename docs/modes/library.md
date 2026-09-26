# Library

Everything ever rendered, as a calm grid.
Component: `web/src/components/Library.tsx`. Backend: `GET /api/gallery`, which walks the
`outputs/` folder (local renders and `outputs/cloud/` results alike) and returns the newest
400 images.

> **TODO(screenshot):** the Library grid and the full-size viewer.

## What it does

- A responsive grid (2–4 columns) of every PNG/JPEG/WebP under `outputs/`, newest first,
  with the count in the sidebar's Library row.
- Click a print for a **full-size viewer** (Escape closes).
- Hover actions on every image:
  - **Edit in Image** — switches to Image mode in From-image mode with this render attached
    as the reference.
  - **Save** — downloads the file.
  - **Delete** — removes the file from `outputs/` after confirmation (the deletion also
    cleans the render out of any session's job history).

## What it is not (yet)

The Library reads the filesystem directly — there is no index, search, tagging,
favourites, or metadata sidecar yet, and listings cap at 400 items. Turning it into a real
asset manager (SQLite index, FTS search by prompt/model/seed, thumbnails, collections) is
planned in build brief Workstream L.

Renders are plain files: deleting a session never deletes its images, and you can manage
`outputs/` with any file manager — the Library reflects whatever is there on the next load.
