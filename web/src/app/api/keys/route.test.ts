import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { ALL_KEY_IDS, PROVIDER_META, PROVIDERS, setKey } from "@/lib/providers/keys";
import { resetVaultForTests } from "@/lib/secrets/vault";
import { GET, POST } from "./route";

/**
 * /api/keys (TEST-BRIEF §8): GET returns only `…abcd` hints, never a key; a
 * short key is 400; key:null removes; unknown provider 400; and the validation
 * call goes to the provider via MSW — no real network, and any real env keys on
 * this machine are hidden from the route for the duration.
 */

const SECRET = "sk-test-supersecret-1234abcd";

const msw = setupServer(
  http.get("https://api.openai.com/v1/models", ({ request }) => {
    const auth = request.headers.get("authorization") ?? "";
    return auth === `Bearer ${SECRET}` ? HttpResponse.json({ data: [] }) : HttpResponse.json({ error: "bad key" }, { status: 401 });
  }),
);

let dir: string;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => msw.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => msw.close());

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-keys-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  // A deterministic vault key: no keychain, no key file, nothing machine-specific.
  savedEnv.set("SAFELIGHT_VAULT_KEY", process.env.SAFELIGHT_VAULT_KEY);
  process.env.SAFELIGHT_VAULT_KEY = "ab".repeat(32);
  // Hide any real provider keys exported in this shell from the route under test.
  for (const p of PROVIDERS) {
    const envVar = PROVIDER_META[p].envVar;
    savedEnv.set(envVar, process.env[envVar]);
    delete process.env[envVar];
  }
  resetVaultForTests();
  resetDbForTests();
});

afterEach(async () => {
  msw.resetHandlers();
  resetDbForTests();
  resetVaultForTests();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:3001/api/keys", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) as unknown as NextRequest,
  );
}

interface KeyStatus {
  provider: string;
  configured: boolean;
  hint?: string;
  source?: string;
}

describe("GET /api/keys", () => {
  it("reports every provider unconfigured on a fresh vault", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: KeyStatus[] };
    expect(keys.map((k) => k.provider).sort()).toEqual([...ALL_KEY_IDS].sort());
    expect(keys.every((k) => !k.configured && k.hint === undefined)).toBe(true);
  });

  it("returns only a …last4 hint for a seeded vault, never the key", async () => {
    await setKey("openai", SECRET);
    const res = await GET();
    const text = JSON.stringify(await res.json());
    expect(text).toContain("…abcd");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("supersecret");
  });
});

describe("POST /api/keys", () => {
  it("stores a key, validates it upstream via MSW, and never echoes it", async () => {
    const res = await post({ provider: "openai", key: SECRET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: KeyStatus[]; validation?: { ok: boolean } };
    const openai = body.keys.find((k) => k.provider === "openai")!;
    expect(openai).toMatchObject({ configured: true, hint: "…abcd", source: "vault" });
    expect(body.validation?.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("reports a rejected key without failing the save", async () => {
    msw.use(http.get("https://api.openai.com/v1/models", () => HttpResponse.json({ error: "nope" }, { status: 401 })));
    const body = (await (await post({ provider: "openai", key: SECRET })).json()) as { keys: KeyStatus[]; validation?: { ok: boolean; message: string } };
    expect(body.validation?.ok).toBe(false);
    expect(body.keys.find((k) => k.provider === "openai")!.configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("key:null removes the stored key", async () => {
    await post({ provider: "openai", key: SECRET });
    const res = await post({ provider: "openai", key: null });
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: KeyStatus[] };
    expect(keys.find((k) => k.provider === "openai")!.configured).toBe(false);
  });

  it("rejects a short key, an unknown provider, and malformed JSON with 400", async () => {
    expect((await post({ provider: "openai", key: "sk-x" })).status).toBe(400);
    expect((await post({ provider: "openai", key: 12345678 })).status).toBe(400);
    expect((await post({ provider: "definitely-not-a-provider", key: SECRET })).status).toBe(400);
    expect((await post({ key: SECRET })).status).toBe(400);
    expect((await post("{nope")).status).toBe(400);
  });
});
