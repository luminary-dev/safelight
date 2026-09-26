import "server-only";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseBlueprint, type ParsedBlueprint } from "./parse";

/** The vendored ComfyUI ships its workflow templates here; the folder is read-only for us. */
export const BLUEPRINTS_DIR = process.env.BLUEPRINTS_DIR ?? path.resolve(process.cwd(), "..", "comfyui", "blueprints");

export interface RegistryFailure {
  file: string;
  error: string;
}

export interface Registry {
  blueprints: ParsedBlueprint[];
  failures: RegistryFailure[];
}

export function blueprintId(filename: string): string {
  return filename
    .replace(/\.json$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function build(dir: string): Promise<Registry> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json")).sort();
  } catch {
    return { blueprints: [], failures: [{ file: dir, error: "Blueprints folder not found." }] };
  }
  const blueprints: ParsedBlueprint[] = [];
  const failures: RegistryFailure[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, file), "utf8")) as unknown;
      let id = blueprintId(file);
      for (let n = 2; seen.has(id); n++) id = `${blueprintId(file)}-${n}`;
      const parsed = parseBlueprint(raw, { id, name: file.replace(/\.json$/i, "") });
      seen.add(id);
      blueprints.push(parsed);
    } catch (err) {
      failures.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { blueprints, failures };
}

let cache: { at: number; dir: string; registry: Registry } | null = null;
const TTL_MS = 60_000;

/** Parses every blueprint in the folder, cached briefly; the files never change at runtime. */
export async function getRegistry(): Promise<Registry> {
  const dir = BLUEPRINTS_DIR;
  if (cache && cache.dir === dir && Date.now() - cache.at < TTL_MS) return cache.registry;
  const registry = await build(dir);
  cache = { at: Date.now(), dir, registry };
  return registry;
}

export async function getBlueprint(id: string): Promise<ParsedBlueprint | undefined> {
  const { blueprints } = await getRegistry();
  return blueprints.find((b) => b.spec.id === id);
}
