import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyInputs, parseBlueprint, type ApiGraph, type ParsedBlueprint } from "./parse";

function load(fixture: string, id: string): ParsedBlueprint {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "fixtures", `${fixture}.json`), "utf8")) as unknown;
  return parseBlueprint(raw, { id, name: fixture });
}

const zImage = load("Text to Image (Z-Image-Turbo)", "text-to-image-z-image-turbo");
const wan = load("Image to Video (Wan 2.2)", "image-to-video-wan-2-2");
const yue = load("Text to Music (YuE2)", "text-to-music-yue2");
const blur = load("Image Blur", "image-blur");

function inputByKey(parsed: ParsedBlueprint, key: string) {
  const input = parsed.spec.inputs.find((i) => i.key === key);
  expect(input, `input ${key} on ${parsed.spec.id}`).toBeDefined();
  return input!;
}

describe("flattening", () => {
  it("produces a pure API graph: no subgraph ids, no virtual nodes, no dangling boundary ids", () => {
    for (const parsed of [zImage, wan, yue, blur]) {
      for (const [id, node] of Object.entries(parsed.graph)) {
        expect(node.class_type).not.toMatch(/^[0-9a-f]{8}-/); // subgraph uuids must be inlined
        expect(["Note", "MarkdownNote", "Reroute"]).not.toContain(node.class_type);
        expect(id).not.toMatch(/(^|:)-(10|20)$/);
        for (const value of Object.values(node.inputs)) {
          if (Array.isArray(value)) {
            expect(parsed.graph[value[0] as string], `${id} links to ${String(value[0])}`).toBeDefined();
          }
        }
      }
    }
  });

  it("keeps the sampler wired and aligned despite control_after_generate widget values", () => {
    const sampler = Object.values(zImage.graph).find((n) => n.class_type === "KSampler");
    expect(sampler).toBeDefined();
    // widgets_values is [0, "randomize", 8, 1, "res_multistep", "simple", 1]; "randomize" is not an input.
    expect(sampler!.inputs.sampler_name).toBe("res_multistep");
    expect(sampler!.inputs.scheduler).toBe("simple");
    expect(sampler!.inputs.steps).toBe(8);
    expect(sampler!.inputs.cfg).toBe(1);
    expect(Array.isArray(sampler!.inputs.model)).toBe(true);
    expect(Array.isArray(sampler!.inputs.positive)).toBe(true);
  });
});

describe("input classification", () => {
  it("z-image exposes prompt, size, seed and steps with baked defaults", () => {
    expect(zImage.spec.category).toBe("image");
    expect(inputByKey(zImage, "text").kind).toBe("prompt");
    expect(inputByKey(zImage, "width").default).toBe(1024);
    expect(inputByKey(zImage, "height").default).toBe(1024);
    expect(inputByKey(zImage, "steps").kind).toBe("number");
    const seed = inputByKey(zImage, "seed");
    expect(seed.seed).toBe(true);
    // model pickers (COMBO) stay baked
    expect(zImage.spec.inputs.find((i) => i.key === "unet_name")).toBeUndefined();
  });

  it("wan 2.2 is a video blueprint with a required start image and salient numerics", () => {
    expect(wan.spec.category).toBe("video");
    const image = inputByKey(wan, "start_image");
    expect(image.kind).toBe("image");
    expect(image.required).toBe(true);
    expect(inputByKey(wan, "length").default).toBe(81);
    expect(inputByKey(wan, "width").default).toBe(640);
    expect(inputByKey(wan, "text").kind).toBe("prompt");
  });

  it("yue2 is an audio blueprint exposing style/lyrics prompts and duration", () => {
    expect(yue.spec.category).toBe("audio");
    const prompts = yue.spec.inputs.filter((i) => i.kind === "prompt");
    expect(prompts.map((p) => p.label)).toEqual(expect.arrayContaining(["Style", "Lyrics"]));
    expect(inputByKey(yue, "max_duration").default).toBe(120);
    expect(inputByKey(yue, "seed").seed).toBe(true);
  });

  it("image blur is a utility with a single image input and no models", () => {
    expect(blur.spec.category).toBe("utility");
    expect(blur.spec.inputs).toHaveLength(1);
    expect(blur.spec.inputs[0].kind).toBe("image");
    expect(blur.spec.requiredModels).toEqual([]);
  });
});

describe("requirements", () => {
  it("collects baked model files and executed node classes", () => {
    expect(zImage.spec.requiredModels).toEqual(expect.arrayContaining(["z_image_turbo_bf16.safetensors", "qwen_3_4b.safetensors", "ae.safetensors"]));
    expect(zImage.spec.requiredNodeClasses).toEqual(expect.arrayContaining(["KSampler", "CLIPTextEncode", "SaveImage"]));
    expect(wan.spec.requiredModels.some((m) => /wan2\.2_i2v/.test(m))).toBe(true);
    expect(wan.spec.requiredNodeClasses).toContain("LoadImage"); // injected loader counts
    expect(yue.spec.requiredModels).toEqual(expect.arrayContaining(["yue2_3b_int8_convrot.safetensors"]));
  });
});

describe("applyInputs", () => {
  it("patches only classified inputs and leaves everything else baked", () => {
    const before = applyInputs(zImage, {});
    const after = applyInputs(zImage, { text: "a lighthouse at dusk", width: 512 });
    const changed: string[] = [];
    for (const [id, node] of Object.entries(after) as [string, ApiGraph[string]][]) {
      for (const [name, value] of Object.entries(node.inputs)) {
        const prev = before[id]?.inputs[name];
        if (JSON.stringify(prev) !== JSON.stringify(value)) changed.push(`${node.class_type}.${name}`);
      }
    }
    const allowed = new Set(["CLIPTextEncode.text", "EmptySD3LatentImage.width", "KSampler.seed"]); // seed re-randomizes per run
    for (const c of changed) expect(allowed.has(c), `unexpected change ${c}`).toBe(true);
    expect(changed).toContain("CLIPTextEncode.text");
    expect(changed).toContain("EmptySD3LatentImage.width");
  });

  it("randomizes the seed unless one is given", () => {
    const a = applyInputs(zImage, {});
    const b = applyInputs(zImage, {});
    const seedOf = (g: ApiGraph) => Object.values(g).find((n) => n.class_type === "KSampler")!.inputs.seed;
    expect(seedOf(a)).not.toBe(seedOf(b));
    const pinned = applyInputs(zImage, { seed: 42 });
    expect(seedOf(pinned)).toBe(42);
  });

  it("injects a LoadImage for image slots and wires it to every target", () => {
    const graph = applyInputs(blur, { "images.image0": "safelight/photo.png" });
    const loader = Object.entries(graph).find(([, n]) => n.class_type === "LoadImage");
    expect(loader).toBeDefined();
    expect(loader![1].inputs.image).toBe("safelight/photo.png");
    const input = blur.spec.inputs[0];
    for (const target of input.targets) {
      expect(graph[target.nodeId].inputs[target.input]).toEqual([loader![0], 0]);
    }
  });

  it("refuses to run without a required media input", () => {
    expect(() => applyInputs(blur, {})).toThrow(/missing required input/i);
    expect(() => applyInputs(wan, { text: "dance" })).toThrow(/start image/i);
  });

  it("rejects unknown input keys and non-numeric numbers", () => {
    expect(() => applyInputs(zImage, { nope: 1 })).toThrow(/unknown input/i);
    expect(() => applyInputs(zImage, { width: "wide" })).toThrow(/needs a number/i);
  });

  it("appends save nodes so outputs land in history", () => {
    const graph = applyInputs(zImage, {});
    const save = Object.values(graph).find((n) => n.class_type === "SaveImage");
    expect(save).toBeDefined();
    expect(Array.isArray(save!.inputs.images)).toBe(true);
    const wanGraph = applyInputs(wan, { start_image: "safelight/frame.png" });
    expect(Object.values(wanGraph).some((n) => n.class_type === "SaveVideo")).toBe(true);
    const yueGraph = applyInputs(yue, {});
    expect(Object.values(yueGraph).some((n) => n.class_type === "SaveAudio")).toBe(true);
  });

  it("never mutates the parsed graph", () => {
    const snapshot = JSON.stringify(zImage.graph);
    applyInputs(zImage, { text: "mutation probe", seed: 1 });
    expect(JSON.stringify(zImage.graph)).toBe(snapshot);
  });
});

describe("malformed and truncated blueprints", () => {
  it("refuses inputs that are not a UI-format workflow, naming the problem", () => {
    for (const bad of [null, 42, "nodes", {}, { nodes: "not-an-array" }, { definitions: {} }]) {
      expect(() => parseBlueprint(bad, { id: "bad", name: "bad" })).toThrow(/missing nodes array/i);
    }
  });

  it("DOCUMENTED: a truncated file whose subgraph definition was cut off parses, leaving the raw uuid class for the gate to flag", () => {
    // With definitions.subgraphs gone, the instance node is indistinguishable
    // from a custom node, so parse cannot refuse it. The uuid class_type
    // survives into requiredNodeClasses, where gating reports it missing and
    // the all-blueprints sweep rejects it for shipped files.
    const truncated = {
      nodes: [{ id: 1, type: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", inputs: [], outputs: [] }],
      links: [],
      definitions: { subgraphs: [] }, // the instance's definition is gone
    };
    const parsed = parseBlueprint(truncated, { id: "cut", name: "cut" });
    expect(parsed.graph["1"].class_type).toMatch(/^[0-9a-f]{8}-/);
    expect(parsed.spec.requiredNodeClasses).toContain("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  it("an empty workflow parses to an empty surface instead of throwing", () => {
    const parsed = parseBlueprint({ nodes: [], links: [] }, { id: "empty", name: "empty" });
    expect(parsed.graph).toEqual({});
    expect(parsed.spec.inputs).toEqual([]);
    expect(parsed.saves).toEqual([]);
  });

  it("a node class ComfyUI does not ship still parses and lands in requiredNodeClasses for the gate", () => {
    const doc = {
      nodes: [{ id: 1, type: "TotallyMadeUpNode", inputs: [], outputs: [], widgets_values: [] }],
      links: [],
    };
    const parsed = parseBlueprint(doc, { id: "custom", name: "custom" });
    expect(parsed.graph["1"].class_type).toBe("TotallyMadeUpNode");
    expect(parsed.spec.requiredNodeClasses).toContain("TotallyMadeUpNode");
  });
});
