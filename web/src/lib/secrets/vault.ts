import "server-only";
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { dataDir } from "@/lib/db";

const exec = promisify(execFile);
const KEYCHAIN_SERVICE = "safelight-vault";
const KEYCHAIN_ACCOUNT = "safelight";

let cached: Buffer | null = null;

async function keychainGet(): Promise<Buffer | null> {
  try {
    const { stdout } = await exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    const hex = stdout.trim();
    return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
  } catch {
    return null;
  }
}

async function keychainSet(key: Buffer): Promise<boolean> {
  try {
    await exec("security", ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", key.toString("hex"), "-U"]);
    return true;
  } catch {
    return false;
  }
}

/** Last resort when no keychain is available: a generated key file beside the data, mode 600. */
function fileKey(): Buffer {
  const file = path.join(dataDir(), ".vault-key");
  try {
    const hex = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  } catch {
    /* generate below */
  }
  const key = randomBytes(32);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  return key;
}

/**
 * The vault key, in order of preference: SAFELIGHT_VAULT_KEY (64 hex chars), the OS keychain
 * (macOS `security`), then a generated key file. The keychain path means nothing sensitive
 * sits in a readable file on macOS.
 */
export async function vaultKey(): Promise<Buffer> {
  if (cached) return cached;
  const env = process.env.SAFELIGHT_VAULT_KEY;
  if (env && /^[0-9a-f]{64}$/i.test(env)) {
    cached = Buffer.from(env, "hex");
    return cached;
  }
  if (process.platform === "darwin") {
    const existing = await keychainGet();
    if (existing) {
      cached = existing;
      return cached;
    }
    const fresh = randomBytes(32);
    if (await keychainSet(fresh)) {
      cached = fresh;
      return cached;
    }
  }
  cached = fileKey();
  return cached;
}

interface Envelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

export async function encryptJson(value: unknown): Promise<string> {
  const key = await vaultKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const envelope: Envelope = { v: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  return JSON.stringify(envelope, null, 2);
}

export async function decryptJson<T>(raw: string): Promise<T> {
  const envelope = JSON.parse(raw) as Envelope;
  if (envelope.v !== 1 || envelope.alg !== "aes-256-gcm") throw new Error("Unknown vault format.");
  const key = await vaultKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}

/** Tests override the key via env; this drops the cache between cases. */
export function resetVaultForTests() {
  cached = null;
}
