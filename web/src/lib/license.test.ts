import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalPayload, type LicensePayload, licenseStatus, removeLicense, saveLicense, verifyLicense } from "./license";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const otherPair = generateKeyPairSync("ed25519");

function issue(payload: LicensePayload, key = privateKey): string {
  const sig = edSign(null, Buffer.from(canonicalPayload(payload), "utf8"), key).toString("base64");
  return JSON.stringify({ payload, sig });
}

const alice: LicensePayload = { v: 1, name: "Alice Example", email: "alice@example.com", majorVersion: 1, issued: "2026-09-26" };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-lic-"));
  vi.stubEnv("SAFELIGHT_DATA_DIR", dir);
  vi.stubEnv("SAFELIGHT_LICENSE_PUBKEY", publicKey.export({ type: "spki", format: "pem" }).toString());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("verifyLicense", () => {
  it("accepts a genuine license, round-tripping the payload", () => {
    const check = verifyLicense(issue(alice));
    expect(check).toEqual({ valid: true, payload: alice });
  });

  it("accepts a payload without the optional email", () => {
    const noEmail: LicensePayload = { v: 1, name: alice.name, majorVersion: alice.majorVersion, issued: alice.issued };
    expect(verifyLicense(issue(noEmail)).valid).toBe(true);
  });

  it("rejects a tampered payload (name changed after signing)", () => {
    const file = JSON.parse(issue(alice));
    file.payload.name = "Mallory";
    const check = verifyLicense(JSON.stringify(file));
    expect(check).toEqual({ valid: false, reason: expect.stringMatching(/signature does not match/) });
  });

  it("rejects a tampered majorVersion — an upgrade cannot be forged", () => {
    const file = JSON.parse(issue(alice));
    file.payload.majorVersion = 99;
    expect(verifyLicense(JSON.stringify(file)).valid).toBe(false);
  });

  it("rejects a corrupted or truncated signature", () => {
    const file = JSON.parse(issue(alice));
    expect(verifyLicense(JSON.stringify({ ...file, sig: file.sig.slice(0, 12) })).valid).toBe(false);
    expect(verifyLicense(JSON.stringify({ ...file, sig: "!!!not-base64!!!" })).valid).toBe(false);
  });

  it("rejects a license signed by someone else's key", () => {
    expect(verifyLicense(issue(alice, otherPair.privateKey)).valid).toBe(false);
  });

  it("rejects non-JSON and wrong shapes with a readable reason", () => {
    expect(verifyLicense("hello")).toEqual({ valid: false, reason: expect.stringMatching(/invalid JSON/) });
    expect(verifyLicense("{}").valid).toBe(false);
    expect(verifyLicense(JSON.stringify({ payload: { v: 2, name: "x", majorVersion: 1, issued: "2026-01-01" }, sig: "AA==" })).valid).toBe(false);
    expect(verifyLicense(JSON.stringify({ payload: { ...alice, name: "  " }, sig: "AA==" })).valid).toBe(false);
  });

  it("extra unsigned fields do not survive into the canonical form (they are ignored, not trusted)", () => {
    const file = JSON.parse(issue(alice));
    file.payload.admin = true; // not in the signed key list, so the signature still holds…
    const check = verifyLicense(JSON.stringify(file));
    expect(check.valid).toBe(true);
    // …and canonicalPayload proves the field carries no signed meaning.
    expect(canonicalPayload(file.payload)).not.toContain("admin");
  });
});

describe("licenseStatus / saveLicense / removeLicense", () => {
  it("reports unlicensed with no file — the normal, fully functional state", async () => {
    expect(await licenseStatus()).toEqual({ licensed: false });
  });

  it("saves a valid license (mode 600) and reports it back", async () => {
    const check = await saveLicense(issue(alice));
    expect(check.valid).toBe(true);
    expect(await licenseStatus()).toEqual({ licensed: true, payload: alice });
    await expect(readFile(path.join(dir, "license.json"), "utf8")).resolves.toContain("Alice Example");
  });

  it("never writes an invalid license to disk", async () => {
    const check = await saveLicense(issue(alice, otherPair.privateKey));
    expect(check.valid).toBe(false);
    await expect(readFile(path.join(dir, "license.json"))).rejects.toThrow();
    expect(await licenseStatus()).toEqual({ licensed: false });
  });

  it("a stored file that fails verification surfaces the reason instead of half-trusting it", async () => {
    await saveLicense(issue(alice));
    // Rotate the trusted key out from under the stored file.
    vi.stubEnv("SAFELIGHT_LICENSE_PUBKEY", otherPair.publicKey.export({ type: "spki", format: "pem" }).toString());
    const status = await licenseStatus();
    expect(status.licensed).toBe(false);
    expect(status).toHaveProperty("reason", expect.stringMatching(/signature/));
  });

  it("removeLicense deletes the file and is idempotent", async () => {
    await saveLicense(issue(alice));
    await removeLicense();
    expect(await licenseStatus()).toEqual({ licensed: false });
    await expect(removeLicense()).resolves.toBeUndefined();
  });
});
