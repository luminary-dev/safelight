import { teCompatible, type GenerateRequest, type ModelFamily } from "./types";
import { classifyFamily } from "./models";

type NodeRef = [string, number];
type Node = { class_type: string; inputs: Record<string, unknown> };
export type Graph = Record<string, Node>;

class GraphBuilder {
  private nodes: Graph = {};
  private counter = 1;

  add(classType: string, inputs: Record<string, unknown>): string {
    const id = String(this.counter++);
    this.nodes[id] = { class_type: classType, inputs };
    return id;
  }

  ref(id: string, slot = 0): NodeRef {
    return [id, slot];
  }

  build(): Graph {
    return this.nodes;
  }
}

function isGguf(name: string) {
  return /\.gguf$/i.test(name);
}

function familyOf(req: GenerateRequest): ModelFamily {
  return classifyFamily(req.model.name);
}

function clipTypeFor(family: ModelFamily): string {
  switch (family) {
    case "qwen-image":
      return "qwen_image";
    case "flux":
      return "flux";
    case "sd15":
    case "sdxl":
    default:
      return "stable_diffusion";
  }
}

/** Builds a ComfyUI API-format prompt graph for the request. Throws on unsupported combinations. */
export function buildGraph(req: GenerateRequest): Graph {
  if (!req.prompt.trim() && req.mode === "txt2img") throw new Error("Prompt is empty.");
  if (req.mode === "img2img" && req.images.length === 0) throw new Error("Image mode needs at least one input image.");

  if (req.model.folder === "checkpoints") return buildCheckpointGraph(req);

  const family = familyOf(req);
  const badTe = req.textEncoders.find((t) => !teCompatible(family, t));
  if (badTe) throw new Error(`${badTe} does not fit this model. Pick the model again, or choose its matching text encoder under More settings.`);
  if (family === "qwen-image") return buildQwenGraph(req);
  return buildUnetGraph(req, family);
}

function loadUnet(g: GraphBuilder, req: GenerateRequest): NodeRef {
  const id =
    req.model.folder === "unet_gguf" || isGguf(req.model.name)
      ? g.add("UnetLoaderGGUF", { unet_name: req.model.name })
      : g.add("UNETLoader", { unet_name: req.model.name, weight_dtype: "default" });
  return g.ref(id, 0);
}

function loadClipSingle(g: GraphBuilder, name: string, type: string): NodeRef {
  const id = isGguf(name) ? g.add("CLIPLoaderGGUF", { clip_name: name, type }) : g.add("CLIPLoader", { clip_name: name, type });
  return g.ref(id, 0);
}

function applyModelLora(g: GraphBuilder, model: NodeRef, req: GenerateRequest): NodeRef {
  if (!req.lora?.name) return model;
  const id = g.add("LoraLoaderModelOnly", { model, lora_name: req.lora.name, strength_model: req.lora.strength });
  return g.ref(id, 0);
}

function loadImages(g: GraphBuilder, req: GenerateRequest): NodeRef[] {
  return req.images.map((image) => g.ref(g.add("LoadImage", { image }), 0));
}

function save(g: GraphBuilder, images: NodeRef, prefix: string) {
  g.add("SaveImage", { images, filename_prefix: `safelight/${prefix}` });
}

function buildQwenGraph(req: GenerateRequest): Graph {
  const g = new GraphBuilder();
  if (req.textEncoders.length === 0) throw new Error("Qwen-Image needs a text encoder (qwen3vl_8b).");
  if (!req.vae) throw new Error("Qwen-Image needs its VAE (qwen_image_2.1_vae).");

  const model = applyModelLora(g, loadUnet(g, req), req);
  const clip = loadClipSingle(g, req.textEncoders[0], "qwen_image");
  const vae = g.ref(g.add("VAELoader", { vae_name: req.vae }), 0);

  const refs = req.mode === "img2img" ? loadImages(g, req) : [];
  const encodeInputs: Record<string, unknown> = {
    clip,
    prompt: req.prompt,
    negative_prompt: req.negativePrompt,
    resolution: req.refResolution,
  };
  if (refs.length > 0) {
    encodeInputs.vae = vae;
    refs.forEach((ref, i) => {
      encodeInputs[`images.image_${i + 1}`] = ref;
    });
  }
  const encode = g.add("TextEncodeQwenImage21", encodeInputs);

  let latent: NodeRef;
  if (refs.length > 0 && req.matchInputSize) {
    latent = g.ref(encode, 2);
    if (req.batch > 1) latent = g.ref(g.add("RepeatLatentBatch", { samples: latent, amount: req.batch }), 0);
  } else {
    latent = g.ref(g.add("EmptyLatentImage", { width: req.width, height: req.height, batch_size: req.batch }), 0);
  }

  const sampler = g.add("KSampler", {
    model,
    positive: g.ref(encode, 0),
    negative: g.ref(encode, 1),
    latent_image: latent,
    seed: req.seed,
    steps: req.steps,
    cfg: req.cfg,
    sampler_name: req.sampler,
    scheduler: req.scheduler,
    denoise: 1,
  });
  const decode = g.add("VAEDecode", { samples: g.ref(sampler, 0), vae });
  save(g, g.ref(decode, 0), "qwen");
  return g.build();
}

function buildUnetGraph(req: GenerateRequest, family: ModelFamily): Graph {
  const g = new GraphBuilder();
  if (!req.vae) throw new Error("This model needs a VAE file.");
  if (req.textEncoders.length === 0) throw new Error("This model needs a text encoder.");

  const model = applyModelLora(g, loadUnet(g, req), req);

  let clip: NodeRef;
  if (family === "flux") {
    if (req.textEncoders.length < 2) throw new Error("Flux needs two text encoders: a T5 and a CLIP-L.");
    const id = g.add("DualCLIPLoader", { clip_name1: req.textEncoders[0], clip_name2: req.textEncoders[1], type: "flux" });
    clip = g.ref(id, 0);
  } else {
    clip = loadClipSingle(g, req.textEncoders[0], clipTypeFor(family));
  }
  const vae = g.ref(g.add("VAELoader", { vae_name: req.vae }), 0);

  const positive = g.ref(g.add("CLIPTextEncode", { text: req.prompt, clip }), 0);
  const negative = g.ref(g.add("CLIPTextEncode", { text: req.negativePrompt, clip }), 0);

  let latent: NodeRef;
  let denoise = 1;
  if (req.mode === "img2img") {
    const [image] = loadImages(g, req);
    const scaled = g.ref(g.add("ImageScale", { image, upscale_method: "lanczos", width: req.width, height: req.height, crop: "center" }), 0);
    latent = g.ref(g.add("VAEEncode", { pixels: scaled, vae }), 0);
    if (req.batch > 1) latent = g.ref(g.add("RepeatLatentBatch", { samples: latent, amount: req.batch }), 0);
    denoise = req.denoise;
  } else {
    const emptyClass = family === "flux" ? "EmptySD3LatentImage" : "EmptyLatentImage";
    latent = g.ref(g.add(emptyClass, { width: req.width, height: req.height, batch_size: req.batch }), 0);
  }

  const sampler = g.add("KSampler", {
    model,
    positive,
    negative,
    latent_image: latent,
    seed: req.seed,
    steps: req.steps,
    cfg: req.cfg,
    sampler_name: req.sampler,
    scheduler: req.scheduler,
    denoise,
  });
  const decode = g.add("VAEDecode", { samples: g.ref(sampler, 0), vae });
  save(g, g.ref(decode, 0), family);
  return g.build();
}

function buildCheckpointGraph(req: GenerateRequest): Graph {
  const g = new GraphBuilder();
  const ckpt = g.add("CheckpointLoaderSimple", { ckpt_name: req.model.name });
  let model = g.ref(ckpt, 0);
  let clip = g.ref(ckpt, 1);
  const vae: NodeRef = req.vae ? g.ref(g.add("VAELoader", { vae_name: req.vae }), 0) : g.ref(ckpt, 2);

  if (req.lora?.name) {
    const lora = g.add("LoraLoader", { model, clip, lora_name: req.lora.name, strength_model: req.lora.strength, strength_clip: req.lora.strength });
    model = g.ref(lora, 0);
    clip = g.ref(lora, 1);
  }

  const positive = g.ref(g.add("CLIPTextEncode", { text: req.prompt, clip }), 0);
  const negative = g.ref(g.add("CLIPTextEncode", { text: req.negativePrompt, clip }), 0);

  let latent: NodeRef;
  let denoise = 1;
  if (req.mode === "img2img") {
    const [image] = loadImages(g, req);
    const scaled = g.ref(g.add("ImageScale", { image, upscale_method: "lanczos", width: req.width, height: req.height, crop: "center" }), 0);
    latent = g.ref(g.add("VAEEncode", { pixels: scaled, vae }), 0);
    if (req.batch > 1) latent = g.ref(g.add("RepeatLatentBatch", { samples: latent, amount: req.batch }), 0);
    denoise = req.denoise;
  } else {
    latent = g.ref(g.add("EmptyLatentImage", { width: req.width, height: req.height, batch_size: req.batch }), 0);
  }

  const sampler = g.add("KSampler", {
    model,
    positive,
    negative,
    latent_image: latent,
    seed: req.seed,
    steps: req.steps,
    cfg: req.cfg,
    sampler_name: req.sampler,
    scheduler: req.scheduler,
    denoise,
  });
  const decode = g.add("VAEDecode", { samples: g.ref(sampler, 0), vae });
  save(g, g.ref(decode, 0), "checkpoint");
  return g.build();
}
