/** Human-friendly display names for model identifiers from any source. */

const KNOWN: { match: RegExp; label: string }[] = [
  { match: /qwen[-_ ]?image[-_ ]?2\.1/i, label: "Qwen-Image 2.1" },
  { match: /qwen[-_ ]?image[-_ ]?edit/i, label: "Qwen-Image Edit" },
  { match: /qwen[-_ ]?image/i, label: "Qwen-Image" },
  { match: /flux[.-]?1?[-_ ]?dev/i, label: "Flux Dev" },
  { match: /flux[.-]?1?[-_ ]?schnell/i, label: "Flux Schnell" },
  { match: /flux[.-]?1?[-_ ]?kontext/i, label: "Flux Kontext" },
  { match: /flux/i, label: "Flux" },
  { match: /sd_?xl|sdxl/i, label: "SDXL" },
  { match: /sd[-_ ]?1\.?5|v1-5/i, label: "Stable Diffusion 1.5" },
  { match: /qwen3\.5/i, label: "Qwen 3.5" },
  { match: /qwen3[-_ ]?vl/i, label: "Qwen3-VL" },
  { match: /gemma\s?4/i, label: "Gemma 4" },
  { match: /gemma\s?3/i, label: "Gemma 3" },
  { match: /cydonia/i, label: "Cydonia" },
  { match: /mag-?mell/i, label: "Mag Mell" },
  { match: /dolphin[-_ ]?llama[-_ ]?3/i, label: "Dolphin Llama 3" },
  { match: /gpt-image-2\.5-sunburst/i, label: "GPT Image 2.5 Sunburst" },
  { match: /gpt-image-2\.5-flare/i, label: "GPT Image 2.5 Flare" },
  { match: /gpt-image-2/i, label: "GPT Image 2" },
  { match: /gpt-image-1\.5/i, label: "GPT Image 1.5" },
  { match: /gpt-image-1-mini/i, label: "GPT Image 1 Mini" },
  { match: /gpt-image-1/i, label: "GPT Image 1" },
  { match: /chatgpt-image-latest/i, label: "ChatGPT Image (latest)" },
  { match: /dall-e-3/i, label: "DALL·E 3" },
];

const QUANT_RE = /(Q[2-8]_[A-Z0-9_]+|Q[2-8]_[01]|IQ[1-4][A-Z_]*|int8|int4|fp8[a-z0-9_]*|fp16|bf16|nf4)/i;
const PARAMS_RE = /(\d{1,3}(?:\.\d)?)[bB](?![a-z])/;
const UNCENSORED_RE = /uncensored|abliterated|nsfw/i;

export interface FriendlyName {
  label: string;
  /** Short qualifiers shown after the name, e.g. ["24B", "Q4_K_M", "uncensored"]. */
  tags: string[];
}

export function friendlyName(id: string, opts: { folder?: string; sourceHint?: string } = {}): FriendlyName {
  const hay = `${id} ${opts.sourceHint ?? ""}`;
  const tags: string[] = [];
  const params = hay.match(PARAMS_RE)?.[1];
  const quant = hay.match(QUANT_RE)?.[1];
  if (params) tags.push(`${params}B`);
  if (quant) tags.push(quant.toUpperCase().replace(/^INT/, "int").replace(/^FP/, "fp").replace(/^BF/, "bf"));
  if (UNCENSORED_RE.test(hay)) tags.push("uncensored");

  const known = KNOWN.find((k) => k.match.test(hay));
  if (known) return { label: known.label, tags };

  // OpenAI chat ids: gpt-4o-mini -> "GPT-4o Mini", o3-pro -> "o3 Pro", chatgpt-4o-latest -> "ChatGPT-4o Latest".
  const gpt = id.match(/^(chatgpt|gpt)-([\d.]+[a-z]?)(?:-(.+))?$/i);
  if (gpt) {
    const family = gpt[1].toLowerCase() === "chatgpt" ? "ChatGPT" : "GPT";
    const rest = gpt[3] ? " " + gpt[3].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : "";
    return { label: `${family}-${gpt[2]}${rest}`, tags };
  }
  const o = id.match(/^(o[1-9])(?:-(.+))?$/i);
  if (o) return { label: o[1] + (o[2] ? " " + o[2].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : ""), tags };
  // Gemini ids: gemini-2.5-flash-image -> "Gemini 2.5 Flash Image".
  const gem = id.match(/^gemini-(.+)$/i);
  if (gem) return { label: "Gemini " + gem[1].split("-").map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(" "), tags };

  // Generic cleanup: drop registry prefixes, extensions, quant and version noise, then title-case.
  let base = id
    .replace(/^hf\.co\/[^/]+\//i, "")
    .replace(/^models\//, "")
    .split("/")
    .pop()!
    .replace(/\.(gguf|safetensors|ckpt|pt|pth|bin)$/i, "")
    .replace(/:.+$/, "")
    .replace(/-GGUF/i, "")
    .replace(QUANT_RE, "")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  base = base
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^[a-z0-9]+$/i.test(w) && !/^\d+$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
  return { label: base || id, tags };
}

export function friendlyLabel(id: string, opts?: { folder?: string; sourceHint?: string }): string {
  const { label, tags } = friendlyName(id, opts);
  return tags.length ? `${label} · ${tags.join(" · ")}` : label;
}
