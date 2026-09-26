import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveExportDest, resolveInOutputs } from "./confine";

let root: string; // stands in for outputs/
let elsewhere: string; // a folder outside it

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sl-conf-out-"));
  elsewhere = await mkdtemp(path.join(tmpdir(), "sl-conf-else-"));
  await mkdir(path.join(root, "sub"), { recursive: true });
  await writeFile(path.join(root, "sub", "ok.png"), "x");
  await writeFile(path.join(elsewhere, "secret.png"), "top secret");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
});

describe("resolveInOutputs", () => {
  it("accepts a real file inside the root", async () => {
    expect(await resolveInOutputs("sub/ok.png", root)).toBe(path.join(root, "sub", "ok.png"));
  });

  it("rejects traversal, absolute paths and empty input", async () => {
    expect(await resolveInOutputs("../" + path.basename(elsewhere) + "/secret.png", root)).toBeNull();
    expect(await resolveInOutputs("sub/../../etc/passwd", root)).toBeNull();
    expect(await resolveInOutputs(path.join(elsewhere, "secret.png"), root)).toBeNull();
    expect(await resolveInOutputs("", root)).toBeNull();
  });

  it("rejects a symlink inside outputs that escapes it", async () => {
    await symlink(path.join(elsewhere, "secret.png"), path.join(root, "sub", "sneaky.png"));
    await symlink(elsewhere, path.join(root, "sneakydir"));
    expect(await resolveInOutputs("sub/sneaky.png", root)).toBeNull();
    expect(await resolveInOutputs("sneakydir/secret.png", root)).toBeNull();
  });

  it("rejects files that do not exist (realpath must resolve)", async () => {
    expect(await resolveInOutputs("sub/missing.png", root)).toBeNull();
  });
});

describe("resolveExportDest", () => {
  it("accepts and creates a folder under home", async () => {
    const dest = path.join(root, "exports", "batch-1"); // root doubles as a fake home
    const resolved = await resolveExportDest(dest, root);
    expect(resolved).not.toBeNull();
    expect(await resolveInOutputs("exports/batch-1", root)).not.toBeNull(); // it exists now
  });

  it("rejects relative paths and anything outside home", async () => {
    expect(await resolveExportDest("relative/folder", root)).toBeNull();
    expect(await resolveExportDest(path.join(elsewhere, "loot"), root)).toBeNull();
    expect(await resolveExportDest(path.join(root, "..", "loot"), root)).toBeNull();
  });

  it("rejects a symlinked segment that leaves home after realpath", async () => {
    await symlink(elsewhere, path.join(root, "linkout"));
    expect(await resolveExportDest(path.join(root, "linkout", "batch"), root)).toBeNull();
  });
});
