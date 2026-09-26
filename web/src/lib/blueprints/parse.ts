import type { Blueprint, BlueprintCategory, BlueprintInput, BlueprintInputKind, PatchTarget } from "./types";

/*
 * The vendored blueprints are ComfyUI UI-format workflows: a single top-level node that is an
 * instance of a subgraph definition (definitions.subgraphs), sometimes nested. The backend's
 * /prompt endpoint only accepts API-format graphs, so parsing means flattening: inline every
 * subgraph, resolve links across boundaries (-10 is a subgraph's input node, -20 its output
 * node), map widgets_values onto input names, and apply each instance's widget overrides.
 */

// ---------- raw workflow shapes ----------

interface RawInput {
  name: string;
  label?: string | null;
  type: string;
  link?: number | null;
  widget?: { name?: string } | null;
}

interface RawOutput {
  name?: string;
  type: string;
}

interface RawNode {
  id: number | string;
  type: string;
  mode?: number;
  inputs?: RawInput[];
  outputs?: RawOutput[];
  widgets_values?: unknown[] | Record<string, unknown> | null;
  properties?: { proxyWidgets?: [string, string][] } | null;
}

interface RawLink {
  id: number;
  origin_id: number | string;
  origin_slot: number;
  target_id: number | string;
  target_slot: number;
}

interface SubgraphIO {
  name: string;
  type: string;
  label?: string | null;
  linkIds?: number[] | null;
}

interface SubgraphDef {
  id: string;
  name?: string;
  nodes: RawNode[];
  links: RawLink[];
  inputs?: SubgraphIO[];
  outputs?: SubgraphIO[];
}

interface WorkflowDoc {
  nodes: RawNode[];
  links?: (RawLink | unknown[])[];
  definitions?: { subgraphs?: SubgraphDef[] };
}

// ---------- API graph ----------

export type ApiInputValue = unknown;
export interface ApiNode {
  class_type: string;
  inputs: Record<string, ApiInputValue>;
}
export type ApiGraph = Record<string, ApiNode>;

type LinkSource = [string, number];

interface SavePlan {
  /** Which top-level output slot to save. */
  slot: number;
  type: string;
  saveClass: "SaveImage" | "SaveVideo" | "SaveAudio" | "PreviewAny";
  source: LinkSource;
}

export interface ParsedBlueprint {
  spec: Blueprint;
  /** Flattened API graph with baked defaults; applyInputs never mutates it. */
  graph: ApiGraph;
  saves: SavePlan[];
}

// ---------- helpers ----------

/** Frontend-only node classes that never reach the backend. */
const VIRTUAL_CLASSES = new Set(["Note", "MarkdownNote", "Reroute"]);
const CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;
const SEED_NAME = /^(seed|noise_seed)$/;

function isLinkValue(v: unknown): v is LinkSource {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
}

function normalizeLinks(links: (RawLink | unknown[])[] | undefined): RawLink[] {
  return (links ?? []).map((l) => {
    if (Array.isArray(l)) {
      const [id, origin_id, origin_slot, target_id, target_slot] = l as [number, number, number, number, number];
      return { id, origin_id, origin_slot, target_id, target_slot };
    }
    return l as RawLink;
  });
}

/**
 * Maps a node's positional widgets_values onto widget input names. The serializer inserts an
 * extra control value ("randomize", "fixed", ...) after seed-like and primitive widgets that is
 * not an input; skip it whenever there are more raw values left than widgets to fill.
 */
function widgetValues(node: RawNode): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const wv = node.widgets_values;
  if (!wv) return map;
  if (!Array.isArray(wv)) {
    for (const [k, v] of Object.entries(wv)) map.set(k, v);
    return map;
  }
  const names = (node.inputs ?? []).filter((i) => i.widget).map((i) => i.widget?.name ?? i.name);
  let vi = 0;
  for (let wi = 0; wi < names.length && vi < wv.length; wi++) {
    map.set(names[wi], wv[vi++]);
    const surplus = wv.length - vi > names.length - wi - 1;
    if (surplus && typeof wv[vi] === "string" && CONTROL_VALUES.has(wv[vi] as string)) vi++;
  }
  return map;
}

// ---------- flattener ----------

interface Ctx {
  prefix: string;
  nodes: Map<string, RawNode>;
  links: Map<number, RawLink>;
  def?: SubgraphDef;
  /** Resolved outer sources for each subgraph input slot; undefined = unconnected. */
  bindings: (LinkSource | undefined)[];
}

interface Instance {
  ctx: Ctx;
  outputs: (LinkSource | undefined)[];
}

class Flattener {
  readonly api: ApiGraph = {};
  private readonly defs = new Map<string, SubgraphDef>();
  private readonly instances = new Map<string, Instance>();

  constructor(doc: WorkflowDoc) {
    for (const sg of doc.definitions?.subgraphs ?? []) this.defs.set(sg.id, sg);
    const top: Ctx = {
      prefix: "",
      nodes: new Map(doc.nodes.map((n) => [String(n.id), n])),
      links: new Map(normalizeLinks(doc.links).map((l) => [l.id, l])),
      bindings: [],
    };
    this.expandGraph(top);
  }

  instanceOf(flatId: string): Instance | undefined {
    return this.instances.get(flatId);
  }

  private isInstance(node: RawNode): boolean {
    return this.defs.has(node.type);
  }

  private expandGraph(ctx: Ctx): void {
    for (const node of ctx.nodes.values()) {
      if (VIRTUAL_CLASSES.has(node.type) || node.mode === 2 || node.mode === 4) continue;
      if (this.isInstance(node)) this.expandInstance(ctx, node);
      else this.emitNode(ctx, node);
    }
  }

  private emitNode(ctx: Ctx, node: RawNode): void {
    const flatId = ctx.prefix + String(node.id);
    const inputs: Record<string, unknown> = {};
    const values = widgetValues(node);
    for (const input of node.inputs ?? []) {
      const widgetName = input.widget ? (input.widget.name ?? input.name) : undefined;
      const fallback = widgetName !== undefined ? values.get(widgetName) : undefined;
      if (input.link !== null && input.link !== undefined) {
        const src = this.resolveLink(ctx, input.link);
        if (src) {
          inputs[input.name] = src;
          continue;
        }
      }
      if (fallback !== undefined && fallback !== null) inputs[input.name] = fallback;
    }
    this.api[flatId] = { class_type: node.type, inputs };
  }

  private expandInstance(ctx: Ctx, node: RawNode): Instance {
    const flatId = ctx.prefix + String(node.id);
    const existing = this.instances.get(flatId);
    if (existing) return existing;
    const def = this.defs.get(node.type);
    if (!def) throw new Error(`Unknown subgraph ${node.type}`);

    const bindings: (LinkSource | undefined)[] = (def.inputs ?? []).map((di) => {
      const inst = (node.inputs ?? []).find((i) => i.name === di.name);
      if (inst?.link === null || inst?.link === undefined) return undefined;
      return this.resolveLink(ctx, inst.link);
    });

    const child: Ctx = {
      prefix: `${flatId}:`,
      nodes: new Map(def.nodes.map((n) => [String(n.id), n])),
      links: new Map(normalizeLinks(def.links).map((l) => [l.id, l])),
      def,
      bindings,
    };
    const instance: Instance = { ctx: child, outputs: [] };
    this.instances.set(flatId, instance);
    this.expandGraph(child);

    instance.outputs = (def.outputs ?? []).map((_, slot) => {
      const link = [...child.links.values()].find((l) => String(l.target_id) === "-20" && l.target_slot === slot);
      return link ? this.resolveSource(child, String(link.origin_id), link.origin_slot) : undefined;
    });

    this.applyOverrides(node, instance);
    return instance;
  }

  /** Instance nodes carry widget overrides for inner nodes; the last writer (outermost) wins. */
  private applyOverrides(node: RawNode, instance: Instance): void {
    const wv = node.widgets_values;
    if (!Array.isArray(wv) || wv.length === 0) return;
    const proxies = node.properties?.proxyWidgets;
    let entries: { ref: string; widget: string; value: unknown }[];
    if (proxies && proxies.length === wv.length) {
      entries = proxies.map(([ref, widget], j) => ({ ref, widget, value: wv[j] }));
    } else {
      // No usable proxy map: values align with the instance's own promoted widget inputs.
      entries = [...widgetValues(node).entries()].map(([widget, value]) => ({ ref: "-1", widget, value }));
    }
    for (const e of entries) {
      if (e.value === undefined || e.value === null || e.widget === "control_after_generate") continue;
      for (const target of this.resolveWidgetTargets(instance, e.ref, e.widget)) {
        const apiNode = this.api[target.nodeId];
        if (!apiNode) continue;
        const current = apiNode.inputs[target.input];
        if (isLinkValue(current)) continue; // a real connection beats a widget value
        apiNode.inputs[target.input] = e.value;
      }
    }
  }

  /**
   * Resolves a (node ref, widget name) pair inside an instance to concrete flattened inputs.
   * Ref "-1" names the instance's own promoted input; anything else is a direct child node.
   */
  resolveWidgetTargets(instance: Instance, ref: string, widget: string): PatchTarget[] {
    const { ctx } = instance;
    if (ref === "-1") {
      const di = (ctx.def?.inputs ?? []).find((x) => x.name === widget);
      if (!di) return [];
      const out: PatchTarget[] = [];
      for (const linkId of di.linkIds ?? []) {
        const link = ctx.links.get(linkId);
        if (!link) continue;
        const targetNode = ctx.nodes.get(String(link.target_id));
        if (!targetNode) continue;
        const inputName = targetNode.inputs?.[link.target_slot]?.name;
        if (inputName === undefined) continue;
        if (this.isInstance(targetNode)) {
          const childInstance = this.instances.get(ctx.prefix + String(targetNode.id));
          if (childInstance) out.push(...this.resolveWidgetTargets(childInstance, "-1", inputName));
        } else {
          out.push({ nodeId: ctx.prefix + String(targetNode.id), input: inputName });
        }
      }
      return out;
    }
    const child = ctx.nodes.get(ref);
    if (!child) return [];
    if (this.isInstance(child)) {
      const childInstance = this.instances.get(ctx.prefix + String(child.id));
      return childInstance ? this.resolveWidgetTargets(childInstance, "-1", widget) : [];
    }
    return [{ nodeId: ctx.prefix + ref, input: widget }];
  }

  private resolveLink(ctx: Ctx, linkId: number, depth = 0): LinkSource | undefined {
    const link = ctx.links.get(linkId);
    if (!link || depth > 64) return undefined;
    return this.resolveSource(ctx, String(link.origin_id), link.origin_slot, depth);
  }

  resolveSource(ctx: Ctx, originId: string, slot: number, depth = 0): LinkSource | undefined {
    if (originId === "-10") return ctx.bindings[slot];
    const node = ctx.nodes.get(originId);
    if (!node) return undefined;
    if (this.isInstance(node)) return this.expandInstance(ctx, node).outputs[slot];
    if (VIRTUAL_CLASSES.has(node.type) || node.mode === 2 || node.mode === 4) {
      // Bypassed nodes and reroutes pass the matching-typed input straight through.
      const outType = node.outputs?.[slot]?.type;
      const inputs = node.inputs ?? [];
      const match =
        inputs.find((i) => i.link !== null && i.link !== undefined && (i.type === outType || i.type === "*" || outType === "*")) ??
        inputs.find((i) => i.link !== null && i.link !== undefined);
      if (match?.link === null || match?.link === undefined) return undefined;
      return this.resolveLink(ctx, match.link, depth + 1);
    }
    return [ctx.prefix + originId, slot];
  }
}

// ---------- input classification ----------

const PROMPTISH = /prompt|lyric|style|caption|user_input|tags|trigger_word/i;
const NUMBER_TOKENS = new Set(["seed", "steps", "cfg", "width", "height", "length", "frames", "fps", "duration", "denoise"]);

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function classify(input: RawInput): { kind: BlueprintInputKind; seed?: boolean } | null {
  const name = input.label ?? input.name;
  const type = input.type.toUpperCase();
  if (!input.widget) {
    if (type.includes("IMAGE")) return { kind: "image" };
    if (type === "MASK") return { kind: "mask" };
    if (type === "VIDEO") return { kind: "video" };
    if (type === "AUDIO") return { kind: "audio" };
    return null; // exotic sockets (bounding boxes, landmarkers) stay unconnected
  }
  if (type === "STRING") {
    if (/negative/i.test(name)) return { kind: "negative-prompt" };
    if (PROMPTISH.test(name) || /^text$/i.test(input.name)) return { kind: "prompt" };
    return null;
  }
  if (type === "INT" || type === "FLOAT") {
    const toks = tokens(name);
    const named = [...toks].some((t) => NUMBER_TOKENS.has(t)) || SEED_NAME.test(input.name) || (toks.has("frame") && (toks.has("rate") || toks.has("count") || toks.has("counts")));
    if (!named) return null;
    const seed = toks.has("seed") || SEED_NAME.test(input.name);
    return { kind: "number", seed };
  }
  return null;
}

// ---------- category ----------

const CATEGORY_RULES: [RegExp, BlueprintCategory][] = [
  [/brightness|contrast|blur|sharpen|glow|grain|hue|saturation|levels|channels|curves|balance|chromatic|crop|unsharp|color|split image grid|select per-line|prompt enhance|get any video frame|merge videos|video stitch/i, "utility"],
  [/3d|splat|geometry|mesh|hunyuan3d/i, "3d"],
  [/audio|music|song/i, "audio"],
  [/video|flf2v|frame interpolation|motion transfer|animate|character replacement/i, "video"],
  [/image|canny|depth|pose|controlnet|inpaint|outpaint|upscale|edit/i, "image"],
];

function inferCategory(name: string, nodeClasses: Set<string>): BlueprintCategory {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  if (nodeClasses.has("CreateVideo") || nodeClasses.has("SaveVideo")) return "video";
  if (nodeClasses.has("VAEDecodeAudio") || nodeClasses.has("SaveAudio")) return "audio";
  if (nodeClasses.has("SaveImage") || nodeClasses.has("VAEDecode")) return "image";
  return "utility";
}

// ---------- save/load planning ----------

const LOADER_FOR: Record<string, { class_type: string; input: string; slot: number }> = {
  image: { class_type: "LoadImage", input: "image", slot: 0 },
  mask: { class_type: "LoadImage", input: "image", slot: 1 },
  video: { class_type: "LoadVideo", input: "file", slot: 0 },
  audio: { class_type: "LoadAudio", input: "audio", slot: 0 },
};

function saveClassFor(type: string): SavePlan["saveClass"] {
  if (type === "IMAGE") return "SaveImage";
  if (type === "VIDEO") return "SaveVideo";
  if (type === "AUDIO") return "SaveAudio";
  return "PreviewAny";
}

// ---------- parse ----------

export function parseBlueprint(raw: unknown, meta: { id: string; name: string }): ParsedBlueprint {
  const doc = raw as WorkflowDoc;
  if (!doc || !Array.isArray(doc.nodes)) throw new Error("Not a ComfyUI UI-format workflow (missing nodes array).");
  const defIds = new Set((doc.definitions?.subgraphs ?? []).map((s) => s.id));
  const flat = new Flattener(doc);

  // The blueprint's surface is its top-level subgraph instance (all shipped files have exactly one).
  const topInstanceNode = doc.nodes.find((n) => defIds.has(n.type));
  const inputs: BlueprintInput[] = [];
  const saves: SavePlan[] = [];
  if (topInstanceNode) {
    const instance = flat.instanceOf(String(topInstanceNode.id));
    if (!instance) throw new Error("Top-level subgraph instance did not expand.");
    for (const rawInput of topInstanceNode.inputs ?? []) {
      const cls = classify(rawInput);
      if (!cls) continue;
      const targets = flat.resolveWidgetTargets(instance, "-1", rawInput.name);
      if (targets.length === 0) continue;
      const label = rawInput.label ?? rawInput.name;
      const isMedia = !rawInput.widget;
      let def: string | number | undefined;
      if (!isMedia) {
        const current = flat.api[targets[0].nodeId]?.inputs[targets[0].input];
        if (typeof current === "string" || typeof current === "number") def = current;
      }
      inputs.push({
        key: rawInput.name,
        label,
        kind: cls.kind,
        valueType: rawInput.type,
        default: def,
        required: isMedia ? !/optional/i.test(label) : false,
        seed: cls.seed || undefined,
        targets,
      });
    }
    (topInstanceNode.outputs ?? []).forEach((out, slot) => {
      const source = instance.outputs[slot];
      if (!source) return;
      const saveClass = saveClassFor(out.type);
      if (saveClass === "PreviewAny" && out.type !== "STRING") return; // no sensible sink for exotic outputs yet
      saves.push({ slot, type: out.type, saveClass, source });
    });
  }

  const nodeClasses = new Set(Object.values(flat.api).map((n) => n.class_type));
  const requiredModels = new Set<string>();
  for (const node of Object.values(flat.api)) {
    for (const value of Object.values(node.inputs)) {
      if (typeof value === "string" && MODEL_FILE.test(value)) requiredModels.add(value);
    }
  }
  const requiredNodeClasses = new Set(nodeClasses);
  for (const input of inputs) {
    const loader = LOADER_FOR[input.kind];
    if (loader) requiredNodeClasses.add(loader.class_type);
  }
  for (const save of saves) requiredNodeClasses.add(save.saveClass);

  const spec: Blueprint = {
    id: meta.id,
    name: meta.name,
    category: inferCategory(meta.name, requiredNodeClasses),
    inputs,
    requiredNodeClasses: [...requiredNodeClasses].sort(),
    requiredModels: [...requiredModels].sort(),
    outputTypes: (topInstanceNode?.outputs ?? []).map((o) => o.type),
  };
  return { spec, graph: flat.api, saves };
}

// ---------- run payload ----------

export function randomBlueprintSeed(): number {
  return Math.floor(Math.random() * 2 ** 48);
}

/**
 * Deep-clones the flattened graph and patches only the classified inputs: prompts and numbers
 * land on their widget targets, media refs become injected Load nodes, seeds are randomized
 * unless the caller pins one, and Save nodes are appended so outputs reach the history.
 */
export function applyInputs(parsed: ParsedBlueprint, values: Record<string, string | number>): ApiGraph {
  const graph: ApiGraph = structuredClone(parsed.graph);
  const known = new Map(parsed.spec.inputs.map((i) => [i.key, i]));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`Unknown input "${key}". This blueprint accepts: ${[...known.keys()].join(", ") || "none"}.`);
  }

  // Randomize every baked seed first; explicit values below overwrite the exposed ones.
  for (const node of Object.values(graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (SEED_NAME.test(name) && typeof value === "number") node.inputs[name] = randomBlueprintSeed();
    }
  }

  const missing: string[] = [];
  for (const input of parsed.spec.inputs) {
    const value = values[input.key];
    const loader = LOADER_FOR[input.kind];
    if (loader) {
      if (value === undefined || value === "") {
        if (input.required) missing.push(input.label);
        continue;
      }
      const loaderId = `blueprint-input-${input.key.replace(/[^a-zA-Z0-9_.-]+/g, "-")}`;
      graph[loaderId] = { class_type: loader.class_type, inputs: { [loader.input]: String(value) } };
      for (const target of input.targets) {
        const node = graph[target.nodeId];
        if (node) node.inputs[target.input] = [loaderId, loader.slot];
      }
      continue;
    }
    if (value === undefined) {
      if (input.seed) {
        const seed = randomBlueprintSeed();
        for (const target of input.targets) {
          const node = graph[target.nodeId];
          if (node && !isLinkValue(node.inputs[target.input])) node.inputs[target.input] = seed;
        }
      }
      continue;
    }
    const patched = input.kind === "number" ? Number(value) : String(value);
    if (input.kind === "number" && !Number.isFinite(patched as number)) throw new Error(`Input "${input.label}" needs a number.`);
    for (const target of input.targets) {
      const node = graph[target.nodeId];
      if (node && !isLinkValue(node.inputs[target.input])) node.inputs[target.input] = patched;
    }
  }
  if (missing.length > 0) throw new Error(`Missing required input${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);

  parsed.saves.forEach((save, i) => {
    const id = `blueprint-save-${i}`;
    if (save.saveClass === "PreviewAny") {
      graph[id] = { class_type: "PreviewAny", inputs: { source: save.source } };
      return;
    }
    const inputName = save.saveClass === "SaveImage" ? "images" : save.saveClass === "SaveVideo" ? "video" : "audio";
    graph[id] = { class_type: save.saveClass, inputs: { [inputName]: save.source, filename_prefix: `blueprints/${parsed.spec.id}` } };
  });

  return graph;
}
