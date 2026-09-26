import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sha256Of, startModelFileServer, wrongSha256Of, type FakeModelFileServer } from "@/test/fakes/hf-civitai";
import { cancelDownload, listDownloads, startDownload } from "./download";

/**
 * The download engine against a real HTTP server (the Tier-0 fake), not a
 * stubbed fetch: full matrix of checksum verify/mismatch, truncated transfer,
 * HTTP failure, and progress accounting (TEST-BRIEF §10).
 *
 * NOT REACHABLE (documented): resume. The engine has no resume path — it never
 * sends a Range header and always restarts a download from byte zero — so the
 * fake's 416/206 scripting cannot be exercised from the engine's side. The
 * "never asks for a Range" test below pins that, and will fail the day resume
 * lands so this file gets the real 416-refused/206-continue matrix.
 */

const PAYLOAD = Buffer.from("model weights ".repeat(4096)); // ~56 KB, streams in several chunks

let files: FakeModelFileServer;
let tmp: string;

beforeAll(async () => {
  files = await startModelFileServer({
    "good.safetensors": PAYLOAD,
    "bad-hash.safetensors": PAYLOAD,
    "truncated.safetensors": PAYLOAD,
    "gated.safetensors": PAYLOAD,
  });
  tmp = mkdtempSync(path.join(os.tmpdir(), "sl-engine-"));
});

afterAll(async () => {
  await files.close();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  for (const d of listDownloads()) cancelDownload(d.id); // clear finished rows between tests
});

async function settle(id: string, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const row = listDownloads().find((d) => d.id === id);
    if (row && row.state !== "downloading") return row;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out; state=${row?.state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("download engine vs the fake file server", () => {
  it("streams the file over real HTTP, verifies the advertised sha256 and reports exact progress", async () => {
    const targetDir = path.join(tmp, "happy");
    const { id } = startDownload({
      url: files.urlFor("good.safetensors"),
      targetDir,
      fileName: "good.safetensors",
      sizeBytes: PAYLOAD.length,
      sha256: sha256Of(PAYLOAD),
    });
    const row = await settle(id);
    expect(row.state).toBe("done");
    expect(row.received).toBe(PAYLOAD.length);
    expect(row.total).toBe(PAYLOAD.length); // taken from the server's content-length
    expect(readFileSync(path.join(targetDir, "good.safetensors"))).toEqual(PAYLOAD);
    expect(existsSync(path.join(targetDir, "good.safetensors.part"))).toBe(false);
  });

  it("a checksum mismatch from a real transfer errors and never leaves a file behind", async () => {
    const targetDir = path.join(tmp, "mismatch");
    const { id } = startDownload({
      url: files.urlFor("bad-hash.safetensors"),
      targetDir,
      fileName: "bad-hash.safetensors",
      sha256: wrongSha256Of(PAYLOAD),
    });
    const row = await settle(id);
    expect(row.state).toBe("error");
    expect(row.error).toMatch(/checksum mismatch/i);
    expect(existsSync(path.join(targetDir, "bad-hash.safetensors"))).toBe(false);
    expect(existsSync(path.join(targetDir, "bad-hash.safetensors.part"))).toBe(false);
  });

  it("a connection that dies mid-transfer errors, removes the .part, and books only the bytes that arrived", async () => {
    files.script("truncated.safetensors", { truncateAfter: 10_000 });
    const targetDir = path.join(tmp, "truncated");
    const { id } = startDownload({
      url: files.urlFor("truncated.safetensors"),
      targetDir,
      fileName: "truncated.safetensors",
      sha256: sha256Of(PAYLOAD),
    });
    const row = await settle(id);
    expect(row.state).toBe("error");
    expect(row.received).toBeLessThan(PAYLOAD.length);
    expect(existsSync(path.join(targetDir, "truncated.safetensors"))).toBe(false);
    expect(existsSync(path.join(targetDir, "truncated.safetensors.part"))).toBe(false);
    files.script("truncated.safetensors", {});
  });

  it("a gated file (403) reports the HTTP status as the error", async () => {
    files.script("gated.safetensors", { status: 403 });
    const { id } = startDownload({ url: files.urlFor("gated.safetensors"), targetDir: path.join(tmp, "gated"), fileName: "gated.safetensors" });
    const row = await settle(id);
    expect(row.state).toBe("error");
    expect(row.error).toContain("403");
    files.script("gated.safetensors", {});
  });

  it("a missing file (404) errors instead of saving the error page", async () => {
    const { id } = startDownload({ url: `${files.url}/files/nope.safetensors`, targetDir: path.join(tmp, "missing"), fileName: "nope.safetensors" });
    const row = await settle(id);
    expect(row.state).toBe("error");
    expect(row.error).toContain("404");
    expect(existsSync(path.join(tmp, "missing", "nope.safetensors"))).toBe(false);
  });

  it("GAP (documented): the engine never asks for a Range — there is no resume, every retry restarts from zero", async () => {
    const targetDir = path.join(tmp, "no-resume");
    const before = files.rangeRequests.length;
    const first = startDownload({ url: files.urlFor("good.safetensors"), targetDir, fileName: "again.safetensors", sha256: sha256Of(PAYLOAD) });
    await settle(first.id);
    expect(files.rangeRequests.length).toBe(before); // resume support would fail here — then test 416/206 properly
  });
});
