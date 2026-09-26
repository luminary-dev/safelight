import "server-only";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HEADROOM_BYTES, formatBytes } from "./kinds";
import { checkDiskSpace } from "./paths";
import type { DownloadProgress, DownloadState } from "./types";

/**
 * Streaming download engine. Files stream to `<target>.part` and are renamed on
 * completion; sha256 is computed while streaming and compared when the source
 * supplied a hash. Progress lives in a module-level map polled by the API.
 */

interface DownloadRecord {
  id: string;
  file: string; // final absolute path
  partPath: string;
  received: number;
  total: number | null;
  state: DownloadState;
  error?: string;
  controller: AbortController;
}

// Next dev can instantiate a lib module once per route bundle; anchor the map
// on globalThis so /api/models/download GET/POST/DELETE all see the same one.
const globalStore = globalThis as unknown as { __safelightDownloads?: Map<string, DownloadRecord> };
const downloads: Map<string, DownloadRecord> = (globalStore.__safelightDownloads ??= new Map());

export function listDownloads(): DownloadProgress[] {
  return Array.from(downloads.values()).map(({ id, file, received, total, state, error }) => ({ id, file, received, total, state, error }));
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name.trim()).replace(/[\u0000-\u001f]/g, "");
  if (!base || base === "." || base === "..") throw new Error("Invalid file name.");
  return base;
}

/** Adds the optional HF / Civitai token for their hosts only. Tokens are never logged. */
export function authHeadersFor(url: string): Record<string, string> {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return {};
  }
  if (/(^|\.)huggingface\.co$/.test(host) && process.env.HF_TOKEN) return { authorization: `Bearer ${process.env.HF_TOKEN}` };
  if (/(^|\.)civitai\.com$/.test(host) && process.env.CIVITAI_API_TOKEN) return { authorization: `Bearer ${process.env.CIVITAI_API_TOKEN}` };
  return {};
}

export interface StartOptions {
  url: string;
  targetDir: string;
  fileName: string;
  sizeBytes?: number | null;
  sha256?: string;
}

export function startDownload(opts: StartOptions): { id: string } {
  const fileName = sanitizeFileName(opts.fileName);
  const file = path.join(opts.targetDir, fileName);

  const space = checkDiskSpace(opts.targetDir, opts.sizeBytes);
  if (!space.ok) {
    throw new Error(`Not enough disk space: ${formatBytes(space.freeBytes)} free, need ${formatBytes((opts.sizeBytes ?? 0) + HEADROOM_BYTES)} (download + 2 GB headroom).`);
  }
  if (existsSync(file)) throw new Error(`${fileName} already exists in ${opts.targetDir}.`);
  const active = Array.from(downloads.values()).find((d) => d.file === file && d.state === "downloading");
  if (active) throw new Error(`${fileName} is already downloading.`);

  const id = `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record: DownloadRecord = {
    id,
    file,
    partPath: `${file}.part`,
    received: 0,
    total: opts.sizeBytes ?? null,
    state: "downloading",
    controller: new AbortController(),
  };
  downloads.set(id, record);
  void run(record, opts.url, opts.sha256?.toLowerCase());
  return { id };
}

async function run(record: DownloadRecord, url: string, expectedSha256?: string): Promise<void> {
  const fs = await import("node:fs/promises");
  try {
    mkdirSync(path.dirname(record.partPath), { recursive: true });
    const res = await fetch(url, { headers: authHeadersFor(url), signal: record.controller.signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Download failed with HTTP ${res.status}.`);
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > 0) record.total = len;

    const hash = createHash("sha256");
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        record.received += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream), counter, createWriteStream(record.partPath), {
      signal: record.controller.signal,
    });

    const digest = hash.digest("hex");
    if (expectedSha256 && digest !== expectedSha256) {
      throw new Error("Checksum mismatch: the downloaded file's sha256 does not match the one the source published.");
    }
    await fs.rename(record.partPath, record.file);
    record.state = "done";
  } catch (err) {
    removePart(record);
    if (record.state === "cancelled" || (err instanceof Error && err.name === "AbortError")) {
      record.state = "cancelled";
    } else {
      record.state = "error";
      record.error = err instanceof Error ? err.message : "Download failed.";
    }
  }
}

function removePart(record: DownloadRecord): void {
  try {
    if (existsSync(record.partPath)) unlinkSync(record.partPath);
  } catch {
    // Best effort; a stale .part never shadows a real model file.
  }
}

/** Aborts an active download (removing its .part) or clears a finished row. */
export function cancelDownload(id: string): boolean {
  const record = downloads.get(id);
  if (!record) return false;
  if (record.state === "downloading") {
    record.state = "cancelled";
    record.controller.abort();
    removePart(record);
  } else {
    downloads.delete(id);
  }
  return true;
}
