import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLogger, LOG_MAX_BYTES, scrub, summarize } from "./log";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-log-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
});

afterEach(async () => {
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function logFile() {
  return path.join(dir, "logs", "safelight.log");
}

describe("logger", () => {
  it("writes structured lines to dataDir()/logs/safelight.log", () => {
    getLogger().info({ runId: "r1", tool: "generate_image", ms: 42 }, "tool finished");
    const text = readFileSync(logFile(), "utf8");
    const line = JSON.parse(text.trim().split("\n").pop()!) as Record<string, unknown>;
    expect(line.msg).toBe("tool finished");
    expect(line.tool).toBe("generate_image");
    expect(line.ms).toBe(42);
  });

  it("never lets a secret-looking value reach the log file", () => {
    const secrets = ["sk-proj-SUPERSECRET123", "gsk_groqSECRET456", "AIzaGoogleSECRET789", "my api key is hunter2"];
    const log = getLogger();
    log.info({ apiKey: secrets[0], nested: { arr: [secrets[1]] } }, "keys arrived");
    log.warn({ note: secrets[2] }, `inline ${secrets[3]}`);
    const text = readFileSync(logFile(), "utf8");
    expect(text).not.toContain("SUPERSECRET123");
    expect(text).not.toContain("groqSECRET456");
    expect(text).not.toContain("GoogleSECRET789");
    expect(text).not.toContain("hunter2");
    // Redaction keeps length + hash so the event is still diagnosable.
    expect(text).toContain(`len=${secrets[0].length}`);
    expect(text).toContain(summarize(secrets[0]).sha256);
  });

  it("scrub replaces matching strings and leaves innocent ones alone", () => {
    const out = scrub({ ok: "a plain sentence", bad: "sk-abc", n: 3 });
    expect(out.ok).toBe("a plain sentence");
    expect(out.bad).toMatch(/^\[redacted len=6 sha256=[0-9a-f]{12}\]$/);
    expect(out.n).toBe(3);
  });

  it("rotates the file once it grows past the cap", async () => {
    await mkdir(path.dirname(logFile()), { recursive: true });
    await writeFile(logFile(), Buffer.alloc(LOG_MAX_BYTES + 1024, 0x61));
    getLogger().info("after rotation");
    expect(existsSync(`${logFile()}.1`)).toBe(true);
    expect(statSync(logFile()).size).toBeLessThan(4096);
    expect(readFileSync(logFile(), "utf8")).toContain("after rotation");
  });
});
