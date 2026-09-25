import type { ProviderId } from "./keys";

export interface CloudChatModel {
  provider: ProviderId;
  id: string;
  label: string;
}

export interface CloudImageModel {
  provider: ProviderId;
  id: string;
  label: string;
  /** Whether the model accepts input images for editing. */
  edit: boolean;
}

export interface ChatImage {
  mime: string;
  /** Base64 without the data: prefix. */
  data: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  images?: ChatImage[];
}

export interface CloudImageRequest {
  prompt: string;
  width: number;
  height: number;
  count: number;
  /** Input images as PNG/JPEG bytes for edit mode. */
  images: { bytes: Uint8Array; mime: string; name: string }[];
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: string;
}

export const CHAT_SYSTEM_PROMPT =
  "You are Safelight, a helpful general-purpose assistant. Answer questions, write, brainstorm, explain, plan, and help with code or any other task the user brings. " +
  "Be direct and concise unless the user asks for depth. Use plain text with light formatting (short lists are fine, no markdown headings). " +
  "If the user asks for an image prompt, reply with the prompt text only so it can be pasted straight into an image model.";

/** Picks the closest aspect ratio label from a list like ["1:1","3:4","16:9"]. */
export function closestAspect(width: number, height: number, options: string[]): string {
  const target = width / height;
  let best = options[0];
  let bestDiff = Infinity;
  for (const o of options) {
    const [w, h] = o.split(":").map(Number);
    const diff = Math.abs(Math.log(w / h) - Math.log(target));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = o;
    }
  }
  return best;
}
