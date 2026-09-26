import { createHash } from "node:crypto";
import { http, HttpResponse, type HttpHandler } from "msw";
import civitaiModels from "../fixtures/models/civitai-models.json";
import hfSearch from "../fixtures/models/hf-search.json";
import hfTree from "../fixtures/models/hf-tree.json";
import { startFakeServer, type FakeServer } from "./http";

/**
 * Model-manager fakes: Hugging Face + Civitai search (MSW handlers on their
 * real hosts, which the clients hardcode) and a local download file server
 * (plain http on 127.0.0.1, because the download engine takes any URL).
 *
 * Search scripting:
 *   const handlers = hfCivitaiHandlers({ hf: { status: 500 } });
 *   hfCivitaiHandlers({ hf: { treeStatus: 401 } })   // gated repo: tree refuses
 *
 * Download scripting:
 *   const files = await startModelFileServer({ "model.safetensors": data });
 *   files.urlFor("model.safetensors")                 // full happy download, Range supported
 *   files.script("model.safetensors", { truncateAfter: 100 });  // connection dies at byte 100
 *   files.script("model.safetensors", { rangeStatus: 416 });    // resume refused
 *   sha256Of(data)      // the advertised hash for the happy path
 *   wrongSha256Of(data) // valid-looking hash that will NOT match (checksum-mismatch case)
 */

export interface HfCivitaiScript {
  hf?: { status?: number; treeStatus?: number; search?: unknown; tree?: unknown };
  civitai?: { status?: number; models?: unknown };
}

export function hfCivitaiHandlers(script: HfCivitaiScript = {}): HttpHandler[] {
  return [
    http.get("https://huggingface.co/api/models", () => {
      const s = script.hf ?? {};
      if (s.status) return HttpResponse.json({ error: "scripted" }, { status: s.status });
      return HttpResponse.json(s.search ?? hfSearch);
    }),
    // Repo ids contain a slash, so the tree path needs a wildcard.
    http.get("https://huggingface.co/api/models/*", ({ request }) => {
      const s = script.hf ?? {};
      if (!new URL(request.url).pathname.includes("/tree/")) return HttpResponse.json({ error: "not found" }, { status: 404 });
      if (s.treeStatus) return HttpResponse.json({ error: "gated" }, { status: s.treeStatus });
      return HttpResponse.json(s.tree ?? hfTree);
    }),
    http.get("https://civitai.com/api/v1/models", () => {
      const s = script.civitai ?? {};
      if (s.status) return HttpResponse.json({ error: "scripted" }, { status: s.status });
      return HttpResponse.json(s.models ?? civitaiModels);
    }),
  ];
}

export function sha256Of(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A well-formed sha256 that is guaranteed not to match `data`. */
export function wrongSha256Of(data: Buffer | string): string {
  const real = sha256Of(data);
  return (real[0] === "0" ? "1" : "0") + real.slice(1);
}

export interface FileScript {
  /** Send this many bytes, then destroy the connection (truncated download). */
  truncateAfter?: number;
  /** Answer any Range request with this status (416 = resume refused). */
  rangeStatus?: number;
  /** Answer every request with this status. */
  status?: number;
}

export interface FakeModelFileServer extends FakeServer {
  urlFor(name: string): string;
  script(name: string, s: FileScript): void;
  /** Range headers seen per file, for resume assertions. */
  rangeRequests: { name: string; range: string }[];
}

export async function startModelFileServer(files: Record<string, Buffer | string>): Promise<FakeModelFileServer> {
  const store = new Map<string, Buffer>(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]));
  const scripts = new Map<string, FileScript>();
  const rangeRequests: { name: string; range: string }[] = [];

  const base = await startFakeServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const name = decodeURIComponent(url.pathname.replace(/^\/files\//, ""));
    const data = store.get(name);
    if (!data) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no such file");
      return;
    }
    const s = scripts.get(name) ?? {};
    if (s.status) {
      res.writeHead(s.status, { "content-type": "text/plain" });
      res.end(`scripted ${s.status}`);
      return;
    }
    const range = req.headers.range;
    if (range) {
      rangeRequests.push({ name, range });
      if (s.rangeStatus) {
        res.writeHead(s.rangeStatus, { "content-range": `bytes */${data.length}` });
        res.end();
        return;
      }
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : data.length - 1;
        const slice = data.subarray(start, end + 1);
        res.writeHead(206, {
          "content-type": "application/octet-stream",
          "content-length": String(slice.length),
          "content-range": `bytes ${start}-${end}/${data.length}`,
        });
        res.end(slice);
        return;
      }
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(data.length) });
    if (s.truncateAfter !== undefined && s.truncateAfter < data.length) {
      // Flush the partial bytes, then close the socket: content-length is now
      // violated, so the client's body read fails mid-transfer — a real
      // truncated download, not a connection that never answered.
      res.write(data.subarray(0, s.truncateAfter), () => res.socket?.end());
      return;
    }
    res.end(data);
  });

  return {
    ...base,
    rangeRequests,
    urlFor: (name) => `${base.url}/files/${encodeURIComponent(name)}`,
    script: (name, s) => {
      scripts.set(name, s);
    },
  };
}
