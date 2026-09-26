import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { decryptJson, encryptJson, resetVaultForTests } from "./vault";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-vault-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  process.env.SAFELIGHT_VAULT_KEY = "a".repeat(64);
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SAFELIGHT_KEYS_FILE;
  delete process.env.STUDIO_KEYS_FILE;
  resetVaultForTests();
  resetDbForTests();
});

afterEach(async () => {
  delete process.env.SAFELIGHT_DATA_DIR;
  delete process.env.SAFELIGHT_VAULT_KEY;
  resetVaultForTests();
  resetDbForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("vault", () => {
  it("round-trips JSON and never stores plaintext", async () => {
    const secret = { openai: { key: "sk-super-secret-value" } };
    const raw = await encryptJson(secret);
    expect(raw).not.toContain("sk-super-secret-value");
    expect(JSON.parse(raw)).toMatchObject({ v: 1, alg: "aes-256-gcm" });
    expect(await decryptJson(raw)).toEqual(secret);
  });

  it("rejects tampered ciphertext", async () => {
    const raw = await encryptJson({ a: 1 });
    const env = JSON.parse(raw) as { data: string };
    const bytes = Buffer.from(env.data, "base64");
    bytes[0] ^= 0xff;
    env.data = bytes.toString("base64");
    await expect(decryptJson(JSON.stringify(env))).rejects.toThrow();
  });

  it("rejects a wrong key", async () => {
    const raw = await encryptJson({ a: 1 });
    process.env.SAFELIGHT_VAULT_KEY = "b".repeat(64);
    resetVaultForTests();
    await expect(decryptJson(raw)).rejects.toThrow();
  });
});

describe("key store migration", () => {
  it("moves a plaintext keys.json into the vault on first read", async () => {
    await writeFile(path.join(dir, "keys.json"), JSON.stringify({ openai: "sk-legacy-key-value" }));
    const { getKey, keyStatuses } = await import("@/lib/providers/keys");
    expect(await getKey("openai")).toBe("sk-legacy-key-value");
    const enc = await readFile(path.join(dir, "keys.enc.json"), "utf8");
    expect(enc).not.toContain("sk-legacy-key-value");
    await expect(readFile(path.join(dir, "keys.json"))).rejects.toThrow();
    expect(await readFile(path.join(dir, "keys.json.migrated"), "utf8")).toContain("sk-legacy-key-value");
    const status = (await keyStatuses()).find((k) => k.provider === "openai");
    expect(status).toMatchObject({ configured: true, source: "vault", hint: "…alue" });
  });

  it("setKey stores base URLs and clearing removes the entry", async () => {
    const { getProviderConfig, setKey } = await import("@/lib/providers/keys");
    await setKey("openai", "sk-somekey-1234", "https://proxy.example.com/v1");
    expect(await getProviderConfig("openai")).toEqual({ key: "sk-somekey-1234", baseUrl: "https://proxy.example.com/v1" });
    await setKey("openai", null);
    expect((await getProviderConfig("openai")).key).toBeUndefined();
  });
});
