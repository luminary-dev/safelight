import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { decryptJson, encryptJson, resetVaultForTests, vaultKey } from "./vault";

/**
 * The vault module promisifies execFile at import time, so the keychain tests swap in a
 * promise-returning mock via util.promisify.custom. Everything else in the module stays real.
 */
const keychainExec = vi.hoisted(() => vi.fn<(cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const util = await import("node:util");
  const execFile = (() => {
    throw new Error("callback-style execFile is not used by the vault");
  }) as unknown as Record<symbol, unknown>;
  execFile[util.promisify.custom] = keychainExec;
  return { ...actual, execFile, default: { ...actual, execFile } };
});

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

  it("treats a missing store file as empty — no key, no throw, not configured", async () => {
    const { getKey, keyStatuses } = await import("@/lib/providers/keys");
    expect(await getKey("openai")).toBeUndefined();
    const status = (await keyStatuses()).find((k) => k.provider === "openai");
    expect(status).toMatchObject({ configured: false });
  });
});

describe("envelope validation", () => {
  it("fails with a clear error on a truncated ciphertext file", async () => {
    const raw = await encryptJson({ a: 1 });
    await expect(decryptJson(raw.slice(0, Math.floor(raw.length / 2)))).rejects.toThrow();
  });

  it("rejects an envelope whose data was cut short", async () => {
    const env = JSON.parse(await encryptJson({ a: 1 })) as { data: string };
    env.data = env.data.slice(0, 4);
    await expect(decryptJson(JSON.stringify(env))).rejects.toThrow();
  });

  it("rejects an unknown envelope version as an unknown vault format", async () => {
    const env = JSON.parse(await encryptJson({ a: 1 })) as { v: number };
    env.v = 2;
    await expect(decryptJson(JSON.stringify(env))).rejects.toThrow("Unknown vault format.");
  });

  it("rejects an unknown algorithm as an unknown vault format", async () => {
    const env = JSON.parse(await encryptJson({ a: 1 })) as { alg: string };
    env.alg = "aes-128-cbc";
    await expect(decryptJson(JSON.stringify(env))).rejects.toThrow("Unknown vault format.");
  });
});

describe("serialization hygiene", () => {
  it("never leaks the key or the plaintext into envelopes or error messages", async () => {
    const keyHex = "deadbeefcafef00d".repeat(4); // 64 hex chars, distinctive
    process.env.SAFELIGHT_VAULT_KEY = keyHex;
    resetVaultForTests();
    const plaintext = "sk-super-secret-plaintext-9917";
    const leaks = (text: string) => {
      const t = text.toLowerCase();
      expect(t).not.toContain(keyHex);
      expect(t).not.toContain(plaintext.toLowerCase());
    };

    const raw = await encryptJson({ openai: plaintext });
    leaks(raw);

    // Wrong key.
    process.env.SAFELIGHT_VAULT_KEY = "b".repeat(64);
    resetVaultForTests();
    leaks(String(await decryptJson(raw).catch((err: unknown) => err)));

    // Tampered ciphertext, unknown format, truncated file — every failure message stays clean.
    process.env.SAFELIGHT_VAULT_KEY = keyHex;
    resetVaultForTests();
    const env = JSON.parse(raw) as { data: string; v: number };
    const bytes = Buffer.from(env.data, "base64");
    bytes[0] ^= 0xff;
    leaks(String(await decryptJson(JSON.stringify({ ...env, data: bytes.toString("base64") })).catch((err: unknown) => err)));
    leaks(String(await decryptJson(JSON.stringify({ ...env, v: 9 })).catch((err: unknown) => err)));
    leaks(String(await decryptJson(raw.slice(0, 12)).catch((err: unknown) => err)));
  });
});

describe("keychain key source", () => {
  const KEYCHAIN_HEX = "0123456789abcdef".repeat(4);
  const originalPlatform = process.platform;

  beforeEach(() => {
    delete process.env.SAFELIGHT_VAULT_KEY;
    resetVaultForTests();
    keychainExec.mockReset();
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function keychainCalls(): string[] {
    return keychainExec.mock.calls.map(([, args]) => args[0]);
  }

  it("retries the read when add says the entry exists, and keeps the SAME key — never rotates", async () => {
    keychainExec.mockImplementationOnce(async () => {
      throw Object.assign(new Error("find failed"), { stderr: "SecKeychainSearchCopyNext: The specified item could not be found." });
    });
    keychainExec.mockImplementationOnce(async () => {
      throw Object.assign(new Error("add failed"), { stderr: "The specified item already exists in the keychain." });
    });
    keychainExec.mockImplementationOnce(async () => ({ stdout: `${KEYCHAIN_HEX}\n`, stderr: "" }));

    const key = await vaultKey();
    expect(key.toString("hex")).toBe(KEYCHAIN_HEX); // the keychain's key, not the freshly generated one
    expect(keychainCalls()).toEqual(["find-generic-password", "add-generic-password", "find-generic-password"]);
    // No file-key fallback was written.
    await expect(readFile(path.join(dir, ".vault-key"), "utf8")).rejects.toThrow();
  });

  it("fails loudly when the entry exists but stays unreadable, instead of clobbering it", async () => {
    keychainExec.mockImplementation(async (_cmd, args) => {
      if (args[0] === "add-generic-password") {
        throw Object.assign(new Error("add failed"), { stderr: "The specified item already exists in the keychain." });
      }
      throw Object.assign(new Error("find failed"), { stderr: "keychain is locked" });
    });
    await expect(vaultKey()).rejects.toThrow(/exists in the keychain but cannot be read/i);
    expect(keychainCalls().filter((c) => c === "add-generic-password")).toHaveLength(1);
  });

  it("falls through to the generated file key when the keychain add fails hard", async () => {
    keychainExec.mockImplementation(async () => {
      throw Object.assign(new Error("exec failed"), { stderr: "security: command not found" });
    });
    const key = await vaultKey();
    expect(key).toHaveLength(32);
    const stored = (await readFile(path.join(dir, ".vault-key"), "utf8")).trim();
    expect(stored).toBe(key.toString("hex"));
    // A later cold start reuses the same file key rather than generating again.
    resetVaultForTests();
    expect((await vaultKey()).toString("hex")).toBe(key.toString("hex"));
  });

  it("stores a fresh key when the keychain has none, and uses exactly the key it stored", async () => {
    let addedHex = "";
    keychainExec.mockImplementation(async (_cmd, args) => {
      if (args[0] === "add-generic-password") {
        addedHex = args[args.indexOf("-w") + 1];
        return { stdout: "", stderr: "" };
      }
      throw Object.assign(new Error("find failed"), { stderr: "could not be found" });
    });
    const key = await vaultKey();
    expect(addedHex).toMatch(/^[0-9a-f]{64}$/i);
    expect(key.toString("hex")).toBe(addedHex);
  });

  it("uses an existing keychain key directly without ever calling add", async () => {
    keychainExec.mockImplementation(async () => ({ stdout: KEYCHAIN_HEX, stderr: "" }));
    expect((await vaultKey()).toString("hex")).toBe(KEYCHAIN_HEX);
    expect(keychainCalls()).toEqual(["find-generic-password"]);
  });
});
