import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";

/**
 * Per-test on-disk root with the Safelight layout (data/, inputs/, outputs/),
 * wired through the SAFELIGHT_* / COMFY_* env vars the app reads, torn down
 * automatically, with a write guard that fails the test when anything under
 * test writes outside the sandbox.
 *
 *   const root = await makeTestRoot();          // envs now point into the sandbox
 *   ...run code under test...
 *   root.assertNoStrayWrites();                 // throws, listing offending paths
 *   await root.cleanup();                       // restores envs, deletes the tree
 *
 * The write guard has two layers, and their boundaries are stated openly:
 *
 * 1. fs spies on the write-side API (writeFile/appendFile/mkdir/rename/rm/
 *    unlink/copyFile/createWriteStream, sync + promise forms). These catch
 *    property-style calls — `fs.writeFileSync(...)` after `import fs from
 *    "node:fs"`, and require()-style CJS. They CANNOT see named ESM imports
 *    of node builtins (`import { writeFileSync } from "node:fs"` binds
 *    statically, past any spy) or native code (better-sqlite3, sharp).
 * 2. assertNoStrayWrites() also fails when SAFELIGHT_DATA_DIR /
 *    COMFY_OUTPUT_DIR / COMFY_INPUT_DIR no longer point inside the sandbox —
 *    the env wiring is what actually confines the app's own writers (every
 *    lib path and the SQLite file derive from these), so a repointed env is
 *    the escape that matters most.
 *
 * For asserting that a specific produced path stayed confined, use the
 * toBeWithinDirectory(root) matcher.
 */

const MANAGED_ENVS = ["SAFELIGHT_DATA_DIR", "COMFY_OUTPUT_DIR", "COMFY_INPUT_DIR"] as const;

export interface TestRoot {
  root: string;
  dataDir: string;
  inputsDir: string;
  outputsDir: string;
  /** Absolute paths of writes that landed outside the sandbox (and outside os.tmpdir). */
  strayWrites(): string[];
  /** Throws when any guarded fs write escaped the sandbox. */
  assertNoStrayWrites(): void;
  /** Restores env vars and spies, removes the tree. Safe to call twice. */
  cleanup(): Promise<void>;
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, path.resolve(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

type PathArg = string | Buffer | URL;

function toPathString(p: PathArg): string | null {
  if (typeof p === "string") return p;
  if (Buffer.isBuffer(p)) return p.toString("utf8");
  if (p instanceof URL) return p.protocol === "file:" ? p.pathname : null;
  return null;
}

export async function makeTestRoot(): Promise<TestRoot> {
  const root = await mkdtemp(path.join(tmpdir(), "safelight-test-"));
  const dataDir = path.join(root, "data");
  const inputsDir = path.join(root, "inputs");
  const outputsDir = path.join(root, "outputs");
  for (const d of [dataDir, inputsDir, outputsDir]) fs.mkdirSync(d, { recursive: true });

  const previousEnv = new Map<string, string | undefined>(MANAGED_ENVS.map((k) => [k, process.env[k]]));
  process.env.SAFELIGHT_DATA_DIR = dataDir;
  process.env.COMFY_OUTPUT_DIR = outputsDir;
  process.env.COMFY_INPUT_DIR = inputsDir;

  const stray = new Set<string>();
  const osTmp = fs.realpathSync(tmpdir());
  const record = (p: PathArg) => {
    const s = toPathString(p);
    if (s === null) return;
    const abs = path.resolve(s);
    if (!within(root, abs) && !within(osTmp, abs) && !within(tmpdir(), abs)) stray.add(abs);
  };

  // Wrap, never replace: every spy calls through so behaviour is unchanged.
  const restores: (() => void)[] = [];
  const spyOnPathArg = <O extends object, K extends keyof O & string>(obj: O, key: K) => {
    const original = obj[key];
    if (typeof original !== "function") return;
    const spy = vi.spyOn(obj, key as never).mockImplementation(((...args: unknown[]) => {
      record(args[0] as PathArg);
      return (original as (...a: unknown[]) => unknown).apply(obj, args);
    }) as never);
    restores.push(() => spy.mockRestore());
  };

  for (const key of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "rmSync", "unlinkSync", "copyFileSync", "createWriteStream"] as const) {
    spyOnPathArg(fs, key);
  }
  for (const key of ["writeFile", "appendFile", "mkdir", "rename", "rm", "unlink", "copyFile"] as const) {
    spyOnPathArg(fs.promises, key);
  }

  let cleaned = false;
  return {
    root,
    dataDir,
    inputsDir,
    outputsDir,
    strayWrites: () => [...stray].sort(),
    assertNoStrayWrites: () => {
      const repointed = MANAGED_ENVS.filter((k) => {
        const v = process.env[k];
        return !v || !within(root, v);
      });
      if (repointed.length > 0) throw new Error(`Env vars escaped the test root: ${repointed.map((k) => `${k}=${process.env[k]}`).join(", ")}`);
      if (stray.size > 0) throw new Error(`Writes escaped the test root:\n  ${[...stray].sort().join("\n  ")}`);
    },
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      for (const restore of restores) restore();
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
