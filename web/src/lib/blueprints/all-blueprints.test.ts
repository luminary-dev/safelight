import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBlueprint } from "./parse";

// Coverage sweep over the real vendored folder (filesystem only, no network).
// Skips cleanly when the checkout does not include the vendored ComfyUI.
const DIR = path.resolve(__dirname, "..", "..", "..", "..", "comfyui", "blueprints");

describe.skipIf(!existsSync(DIR))("every shipped blueprint", () => {
  it("parses cleanly with a graph, a category and requirements", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as unknown;
        const parsed = parseBlueprint(raw, { id: file, name: file.replace(/\.json$/, "") });
        expect(Object.keys(parsed.graph).length).toBeGreaterThan(0);
        expect(parsed.spec.requiredNodeClasses.length).toBeGreaterThan(0);
        for (const node of Object.values(parsed.graph)) {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(node.class_type)) throw new Error(`unflattened subgraph node ${node.class_type}`);
        }
      } catch (err) {
        failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
