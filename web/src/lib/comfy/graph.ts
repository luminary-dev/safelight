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

/** Z-Image models drive the Lumina2 text-encoder path and the Fun-Controlnet union patches. */
function isZImage(name: string): boolean {
  return /z[-_]?image/i.test(name);
}

/** Builds a ComfyUI API-format prompt graph for the request. Throws on unsupported combinations. */
export function buildGraph(req: GenerateRequest): Graph {
  if (!req.prompt.trim() && req.mode === "txt2img") throw new Error("Prompt is empty.");
  if (req.mode === "img2img" && req.images.length === 0) throw new Error("Image mode needs at least one input image.");

  if (req.control && req.mode === "img2img") return buildControlNetGraph(req);

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

/** LoadImage → UpscaleModelLoader → ImageUpscaleWithModel → SaveImage. ESRGAN-style model upscale. */
export function buildUpscaleGraph(req: { image: string; upscaleModel: string }): Graph {
  if (!req.image) throw new Error("Upscale needs an input image.");
  if (!req.upscaleModel) throw new Error("Upscale needs an upscale model.");
  const g = new GraphBuilder();
  const image = g.ref(g.add("LoadImage", { image: req.image }), 0);
  const model = g.ref(g.add("UpscaleModelLoader", { model_name: req.upscaleModel }), 0);
  const upscaled = g.add("ImageUpscaleWithModel", { upscale_model: model, image });
  g.add("SaveImage", { images: g.ref(upscaled, 0), filename_prefix: "safelight/upscale" });
  return g.build();
}

/**
 * BiRefNet background removal, shaped after comfyui/blueprints/"Remove Background (BiRefNet)":
 * the foreground mask is inverted before JoinImageWithAlpha because that node inverts alpha internally.
 */
export function buildRemoveBackgroundGraph(req: { image: string; model: string }): Graph {
  if (!req.image) throw new Error("Background removal needs an input image.");
  if (!req.model) throw new Error("Background removal needs a BiRefNet model file.");
  const g = new GraphBuilder();
  const image = g.ref(g.add("LoadImage", { image: req.image }), 0);
  const bgModel = g.ref(g.add("LoadBackgroundRemovalModel", { bg_removal_name: req.model }), 0);
  const mask = g.ref(g.add("RemoveBackground", { bg_removal_model: bgModel, image }), 0);
  const inverted = g.ref(g.add("InvertMask", { mask }), 0);
  const joined = g.add("JoinImageWithAlpha", { image, alpha: inverted });
  g.add("SaveImage", { images: g.ref(joined, 0), filename_prefix: "safelight/rmbg" });
  return g.build();
}

export interface MaskEditOptions {
  /** ComfyUI input reference for the black/white mask PNG (white = repaint). */
  mask: string;
  /** Grow the mask outward this many pixels before feathering. */
  maskExpand?: number;
  /** Feather the mask edge with this blur radius, in pixels. */
  maskBlur?: number;
  /** Inpainting ControlNet file in ComfyUI's controlnet folder; sharpens quality when installed. */
  controlNet?: string;
}

export interface OutpaintOptions {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Soft edge between the old and new canvas, in pixels. */
  feathering?: number;
  controlNet?: string;
  /** Longest output side after padding; keeps huge canvases renderable. */
  maxSize?: number;
}

/**
 * Qwen inpainting/outpainting share one conditioning + model stack, modeled on
 * comfyui/blueprints/"Image Inpainting (Qwen-image)" / "Image Outpainting (Qwen-Image)".
 */
function qwenEditStack(g: GraphBuilder, req: GenerateRequest) {
  const family = familyOf(req);
  if (family !== "qwen-image" || req.model.folder === "checkpoints") {
    throw new Error(`Inpainting and outpainting follow the Qwen-Image workflow — pick a Qwen-Image model (the selected model "${req.model.name}" is ${family === "unknown" ? "not recognised as one" : `a ${family} model`}).`);
  }
  if (!req.prompt.trim()) throw new Error("Describe what should appear in the edited area — the prompt is empty.");
  if (req.textEncoders.length === 0) throw new Error("Qwen-Image needs a text encoder (qwen3vl_8b).");
  const badTe = req.textEncoders.find((t) => !teCompatible(family, t));
  if (badTe) throw new Error(`${badTe} does not fit this model. Pick the model again, or choose its matching text encoder under More settings.`);
  if (!req.vae) throw new Error("Qwen-Image needs its VAE (qwen_image_2.1_vae).");

  const model = applyModelLora(g, loadUnet(g, req), req);
  const clip = loadClipSingle(g, req.textEncoders[0], "qwen_image");
  const vae = g.ref(g.add("VAELoader", { vae_name: req.vae }), 0);
  const encode = g.add("TextEncodeQwenImage21", { clip, prompt: req.prompt, negative_prompt: req.negativePrompt, resolution: req.refResolution });
  return { model, vae, positive: g.ref(encode, 0), negative: g.ref(encode, 1) };
}

/** GrowMask → MaskToImage → ImageBlur → ImageToMask: expands and feathers a mask like the blueprints do. */
function growAndFeatherMask(g: GraphBuilder, mask: NodeRef, expand: number, blur: number): NodeRef {
  const grown = g.ref(g.add("GrowMask", { mask, expand, tapered_corners: true }), 0);
  const asImage = g.ref(g.add("MaskToImage", { mask: grown }), 0);
  const blurred = g.ref(g.add("ImageBlur", { image: asImage, blur_radius: Math.max(1, blur), sigma: 1 }), 0);
  return g.ref(g.add("ImageToMask", { image: blurred, channel: "red" }), 0);
}

/** ControlNetLoader → ControlNetInpaintingAliMamaApply, the blueprints' inpainting conditioning. */
function applyInpaintControlNet(g: GraphBuilder, opts: { controlNet: string; positive: NodeRef; negative: NodeRef; vae: NodeRef; image: NodeRef; mask: NodeRef }) {
  const cn = g.ref(g.add("ControlNetLoader", { control_net_name: opts.controlNet }), 0);
  const applied = g.add("ControlNetInpaintingAliMamaApply", {
    positive: opts.positive,
    negative: opts.negative,
    control_net: cn,
    vae: opts.vae,
    image: opts.image,
    mask: opts.mask,
    strength: 1,
    start_percent: 0,
    end_percent: 1,
  });
  return { positive: g.ref(applied, 0), negative: g.ref(applied, 1) };
}

/**
 * Mask-brush inpainting, modeled on comfyui/blueprints/"Image Inpainting (Qwen-image)":
 * the image is VAE-encoded, the painted mask limits the sampler's noise (SetLatentNoiseMask),
 * and, when an inpainting ControlNet is installed, ControlNetInpaintingAliMamaApply
 * conditions the render on the unmasked pixels for a cleaner blend.
 */
export function buildInpaintGraph(req: GenerateRequest, opts: MaskEditOptions): Graph {
  if (req.images.length === 0) throw new Error("Inpainting needs the image to edit.");
  if (!opts.mask) throw new Error("Inpainting needs a mask — paint over the area to replace.");
  const g = new GraphBuilder();
  const stack = qwenEditStack(g, req);

  const image = g.ref(g.add("LoadImage", { image: req.images[0] }), 0);
  const rawMask = g.ref(g.add("ImageToMask", { image: g.ref(g.add("LoadImage", { image: opts.mask }), 0), channel: "red" }), 0);
  const mask = growAndFeatherMask(g, rawMask, opts.maskExpand ?? 0, opts.maskBlur ?? 8);

  let { positive, negative } = stack;
  if (opts.controlNet) ({ positive, negative } = applyInpaintControlNet(g, { controlNet: opts.controlNet, positive, negative, vae: stack.vae, image, mask }));

  const encoded = g.ref(g.add("VAEEncode", { pixels: image, vae: stack.vae }), 0);
  const latent = g.ref(g.add("SetLatentNoiseMask", { samples: encoded, mask }), 0);
  const sampler = g.add("KSampler", {
    model: stack.model,
    positive,
    negative,
    latent_image: latent,
    seed: req.seed,
    steps: req.steps,
    cfg: req.cfg,
    sampler_name: req.sampler,
    scheduler: req.scheduler,
    denoise: req.denoise,
  });
  const decode = g.add("VAEDecode", { samples: g.ref(sampler, 0), vae: stack.vae });
  save(g, g.ref(decode, 0), "inpaint");
  return g.build();
}

/**
 * Direction/percent outpainting, modeled on comfyui/blueprints/"Image Outpainting (Qwen-Image)":
 * ImagePadForOutpaint grows the canvas and yields the new-area mask, both are capped at
 * maxSize, the mask is grown and feathered, the new area is rendered under a latent noise
 * mask (plus the inpainting ControlNet when installed), and the original pixels are
 * composited back over the result.
 */
export function buildOutpaintGraph(req: GenerateRequest, opts: OutpaintOptions): Graph {
  if (req.images.length === 0) throw new Error("Outpainting needs the image to extend.");
  const { left, top, right, bottom } = opts;
  if ([left, top, right, bottom].every((v) => !v || v <= 0)) throw new Error("Outpainting needs at least one direction to extend into.");
  const g = new GraphBuilder();
  const stack = qwenEditStack(g, req);
  const maxSize = opts.maxSize ?? 1536;

  const source = g.ref(g.add("LoadImage", { image: req.images[0] }), 0);
  const pad = g.add("ImagePadForOutpaint", {
    image: source,
    left: Math.max(0, left),
    top: Math.max(0, top),
    right: Math.max(0, right),
    bottom: Math.max(0, bottom),
    feathering: Math.max(0, opts.feathering ?? 24),
  });
  const image = g.ref(g.add("ImageScaleToMaxDimension", { image: g.ref(pad, 0), upscale_method: "area", largest_size: maxSize }), 0);
  const padMaskImage = g.ref(g.add("MaskToImage", { mask: g.ref(pad, 1) }), 0);
  const scaledPadMask = g.ref(g.add("ImageToMask", { image: g.ref(g.add("ImageScaleToMaxDimension", { image: padMaskImage, upscale_method: "area", largest_size: maxSize }), 0), channel: "red" }), 0);
  const mask = growAndFeatherMask(g, scaledPadMask, 20, 31);

  let { positive, negative } = stack;
  if (opts.controlNet) ({ positive, negative } = applyInpaintControlNet(g, { controlNet: opts.controlNet, positive, negative, vae: stack.vae, image, mask }));

  const encoded = g.ref(g.add("VAEEncode", { pixels: image, vae: stack.vae }), 0);
  const latent = g.ref(g.add("SetLatentNoiseMask", { samples: encoded, mask }), 0);
  const sampler = g.add("KSampler", {
    model: stack.model,
    positive,
    negative,
    latent_image: latent,
    seed: req.seed,
    steps: req.steps,
    cfg: req.cfg,
    sampler_name: req.sampler,
    scheduler: req.scheduler,
    denoise: req.denoise,
  });
  const decode = g.ref(g.add("VAEDecode", { samples: g.ref(sampler, 0), vae: stack.vae }), 0);
  // Keep every original pixel: the render only fills where the (feathered) pad mask is white.
  const composite = g.add("ImageCompositeMasked", { destination: image, source: decode, mask, x: 0, y: 0, resize_source: false });
  save(g, g.ref(composite, 0), "outpaint");
  return g.build();
}

/**
 * ControlNet-guided render, modeled on comfyui/blueprints/"ControlNet (Z-Image-Turbo)" and its
 * canny/depth/pose variants: the reference image becomes the control map (canny is traced with
 * the core Canny node; depth/pose expect an already-made map), a union control patch
 * (ModelPatchLoader → QwenImageDiffsynthControlnet) steers the model, and the output canvas
 * follows the control map's size.
 */
function buildControlNetGraph(req: GenerateRequest): Graph {
  const control = req.control!;
  if (req.images.length === 0) throw new Error("ControlNet needs a reference image to trace.");
  if (!req.prompt.trim()) throw new Error("Prompt is empty.");
  if (!control.patch) {
    throw new Error('No ControlNet patch file was resolved. Download "Z-Image-Turbo-Fun-Controlnet-Union.safetensors" into ComfyUI\'s "model_patches" folder and try again.');
  }
  if (req.model.folder === "checkpoints") throw new Error("ControlNet patches drive diffusion models, not all-in-one checkpoints — pick a Z-Image or Qwen-Image model.");
  if (req.textEncoders.length === 0) throw new Error("This model needs a text encoder.");
  if (!req.vae) throw new Error("This model needs a VAE file.");

  const g = new GraphBuilder();
  const family = familyOf(req);
  const zImage = isZImage(req.model.name);
  const model = applyModelLora(g, loadUnet(g, req), req);
  const shifted = g.ref(g.add("ModelSamplingAuraFlow", { model, shift: 3 }), 0);
  const clip = loadClipSingle(g, req.textEncoders[0], zImage ? "lumina2" : clipTypeFor(family));
  const vae = g.ref(g.add("VAELoader", { vae_name: req.vae }), 0);

  let positive: NodeRef;
  let negative: NodeRef;
  if (family === "qwen-image") {
    const encode = g.add("TextEncodeQwenImage21", { clip, prompt: req.prompt, negative_prompt: req.negativePrompt, resolution: req.refResolution });
    positive = g.ref(encode, 0);
    negative = g.ref(encode, 1);
  } else {
    positive = g.ref(g.add("CLIPTextEncode", { text: req.prompt, clip }), 0);
    negative = req.negativePrompt.trim()
      ? g.ref(g.add("CLIPTextEncode", { text: req.negativePrompt, clip }), 0)
      : g.ref(g.add("ConditioningZeroOut", { conditioning: positive }), 0);
  }

  let map = g.ref(g.add("ImageScaleToTotalPixels", { image: g.ref(g.add("LoadImage", { image: req.images[0] }), 0), upscale_method: "lanczos", megapixels: 1, resolution_steps: 1 }), 0);
  if (control.type === "canny") {
    map = g.ref(g.add("Canny", { image: map, low_threshold: control.cannyLow ?? 0.3, high_threshold: control.cannyHigh ?? 0.4 }), 0);
  }

  const patch = g.ref(g.add("ModelPatchLoader", { name: control.patch }), 0);
  const guided = g.ref(g.add("QwenImageDiffsynthControlnet", { model: shifted, model_patch: patch, vae, image: map, strength: control.strength }), 0);

  const size = g.add("GetImageSize", { image: map });
  const latent = g.ref(g.add("EmptySD3LatentImage", { width: g.ref(size, 0), height: g.ref(size, 1), batch_size: req.batch }), 0);
  const sampler = g.add("KSampler", {
    model: guided,
    positive,
    negative,
    latent_image: latent,
    seed: req.seed,
    steps: req.steps,
    cfg: req.cfg,
    sampler_name: req.sampler,
    scheduler: req.scheduler,
    denoise: 1,
  });
  const decode = g.add("VAEDecode", { samples: g.ref(sampler, 0), vae });
  save(g, g.ref(decode, 0), "control");
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
