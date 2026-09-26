import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalPayload, type LicensePayload } from "@/lib/license";
import { DELETE, GET, POST } from "./route";

/**
 * /api/license: GET reports status, POST validates BEFORE saving (an invalid
 * file is a 400 and never lands on disk), DELETE removes. Everything is
 * offline — the only key material is a throwaway pair generated right here.
 */

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const payload: LicensePayload = { v: 1, name: "Alice Example", majorVersion: 1, issued: "2026-09-26" };
const genuine = JSON.stringify({
  payload,
  sig: edSign(null, Buffer.from(canonicalPayload(payload), "utf8"), privateKey).toString("base64"),
});

function post(body: unknown): NextRequest {
  return new Request("http://localhost/api/license", { method: "POST", body: JSON.stringify(body) }) as unknown as NextRequest;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-lic-api-"));
  vi.stubEnv("SAFELIGHT_DATA_DIR", dir);
  vi.stubEnv("SAFELIGHT_LICENSE_PUBKEY", publicKey.export({ type: "spki", format: "pem" }).toString());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("/api/license", () => {
  it("GET is unlicensed before anything is saved", async () => {
    expect(await (await GET()).json()).toEqual({ licensed: false });
  });

  it("POST a genuine license, GET it back, DELETE it away", async () => {
    const saved = await POST(post({ license: genuine }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ licensed: true, payload });

    expect(await (await GET()).json()).toEqual({ licensed: true, payload });

    expect(await (await DELETE()).json()).toEqual({ licensed: false });
    expect(await (await GET()).json()).toEqual({ licensed: false });
  });

  it("POST a forged license is a 400 with the reason, and nothing is stored", async () => {
    const forged = JSON.parse(genuine);
    forged.payload.name = "Mallory";
    const res = await POST(post({ license: JSON.stringify(forged) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/signature does not match/);
    expect(await (await GET()).json()).toEqual({ licensed: false });
  });

  it("POST hostile bodies are 400s, never 500s", async () => {
    const raw = new Request("http://localhost/api/license", { method: "POST", body: "not json" }) as unknown as NextRequest;
    expect((await POST(raw)).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post({ license: "   " }))).status).toBe(400);
    expect((await POST(post({ license: 42 }))).status).toBe(400);
    expect((await POST(post({ license: "{}" }))).status).toBe(400);
  });
});
