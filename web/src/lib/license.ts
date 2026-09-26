import "server-only";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/db";

/**
 * Offline license validation (ADR 0003, accepted): an Ed25519-signed JSON file,
 * verified locally against the embedded public key — no server, no account, no
 * phone-home, ever. Nothing is gated: an unlicensed Safelight is fully
 * functional for personal use; the license records support for the product and
 * which major version it covers.
 */

// Placeholder keypair NOT yet generated — replace via scripts/license/keygen.mjs
// before selling anything. Until then every real-world license reads invalid,
// which is honest: none have been issued. Tests inject their own key via
// SAFELIGHT_LICENSE_PUBKEY.
export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
-----END PUBLIC KEY-----`;

export interface LicensePayload {
  v: 1;
  name: string;
  email?: string;
  /** The major version this license covers; newer majors need a new license. */
  majorVersion: number;
  /** Issue date, YYYY-MM-DD. */
  issued: string;
}

export interface LicenseFile {
  payload: LicensePayload;
  sig: string;
}

export type LicenseCheck = { valid: true; payload: LicensePayload } | { valid: false; reason: string };

function publicKey() {
  return createPublicKey(process.env.SAFELIGHT_LICENSE_PUBKEY ?? LICENSE_PUBLIC_KEY);
}

/** The exact canonical form scripts/license/sign.mjs signs. */
export function canonicalPayload(p: LicensePayload): string {
  return JSON.stringify(p, ["v", "name", "email", "majorVersion", "issued"]);
}

export function verifyLicense(raw: string): LicenseCheck {
  let file: LicenseFile;
  try {
    file = JSON.parse(raw) as LicenseFile;
  } catch {
    return { valid: false, reason: "Not a license file (invalid JSON)." };
  }
  const p = file?.payload;
  if (!p || p.v !== 1 || typeof p.name !== "string" || !p.name.trim() || typeof p.majorVersion !== "number" || typeof p.issued !== "string" || typeof file.sig !== "string") {
    return { valid: false, reason: "Not a license file (unexpected shape)." };
  }
  try {
    const ok = edVerify(null, Buffer.from(canonicalPayload(p), "utf8"), publicKey(), Buffer.from(file.sig, "base64"));
    return ok ? { valid: true, payload: p } : { valid: false, reason: "The signature does not match — the file was altered or not issued by Luminary." };
  } catch {
    return { valid: false, reason: "The signature could not be checked." };
  }
}

function licenseFile(): string {
  return path.join(dataDir(), "license.json");
}

export type LicenseStatus = { licensed: true; payload: LicensePayload } | { licensed: false; reason?: string };

/** The stored license's current standing; unlicensed is a normal, fully functional state. */
export async function licenseStatus(): Promise<LicenseStatus> {
  let raw: string;
  try {
    raw = await readFile(licenseFile(), "utf8");
  } catch {
    return { licensed: false };
  }
  const check = verifyLicense(raw);
  return check.valid ? { licensed: true, payload: check.payload } : { licensed: false, reason: check.reason };
}

/** Validates before storing; an invalid file is never written. */
export async function saveLicense(raw: string): Promise<LicenseCheck> {
  const check = verifyLicense(raw);
  if (check.valid) await writeFile(licenseFile(), raw, { mode: 0o600 });
  return check;
}

export async function removeLicense(): Promise<void> {
  await unlink(licenseFile()).catch(() => undefined);
}
