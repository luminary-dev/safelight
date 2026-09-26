import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { resetVaultForTests } from "@/lib/secrets/vault";
import { hydrateServiceEnv, keyStatuses, resetServiceEnvForTests, SERVICE_META, SERVICES, setKey } from "./keys";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-svc-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  process.env.SAFELIGHT_KEYS_FILE = path.join(dir, "keys.enc.json");
  process.env.SAFELIGHT_VAULT_KEY = "cd".repeat(32);
  resetVaultForTests();
  resetDbForTests();
  resetServiceEnvForTests();
  for (const id of SERVICES) delete process.env[SERVICE_META[id].envVar];
});

afterEach(async () => {
  resetServiceEnvForTests();
  for (const id of SERVICES) delete process.env[SERVICE_META[id].envVar];
  delete process.env.SAFELIGHT_KEYS_FILE;
  delete process.env.SAFELIGHT_VAULT_KEY;
  delete process.env.SAFELIGHT_DATA_DIR;
  resetVaultForTests();
  resetDbForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("service keys", () => {
  it("round-trips through the vault and reports kind/hint, never the key", async () => {
    await setKey("brave", "BSA-test-key-1234");
    const statuses = await keyStatuses();
    const brave = statuses.find((s) => s.provider === "brave")!;
    expect(brave).toMatchObject({ kind: "search", configured: true, hint: "…1234", source: "vault", chat: false, images: false });
    expect(JSON.stringify(statuses)).not.toContain("BSA-test-key");
    expect(statuses.filter((s) => s.kind !== "model").map((s) => s.provider).sort()).toEqual(["brave", "civitai", "hf", "tavily"]);
  });

  it("bridges vault keys into the consumer env vars and clears them on removal", async () => {
    await setKey("tavily", "tvly-abc");
    expect(process.env.TAVILY_API_KEY).toBe("tvly-abc");
    await hydrateServiceEnv();
    expect(process.env.TAVILY_API_KEY).toBe("tvly-abc");
    await setKey("tavily", null);
    expect(process.env.TAVILY_API_KEY).toBeUndefined();
  });

  it("never overwrites a real environment variable", async () => {
    process.env.HF_TOKEN = "hf-from-real-env";
    await setKey("hf", "hf-from-vault");
    // setKey bridges, but hydrate respects a value the bridge did not set…
    resetServiceEnvForTests();
    process.env.HF_TOKEN = "hf-from-real-env";
    await hydrateServiceEnv();
    expect(process.env.HF_TOKEN).toBe("hf-from-real-env");
    const hf = (await keyStatuses()).find((s) => s.provider === "hf")!;
    expect(hf.source).toBe("vault");
  });
});
