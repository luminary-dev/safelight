/**
 * Text extraction for non-image chat attachments (PDF, text, CSV, code).
 * Client-safe module: the composer imports the extension list and limits for its
 * accept filter, while `unpdf` (the only heavy dependency) loads lazily and only
 * ever runs on the server inside /api/chat/extract.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Extracted text is clipped here so one attachment cannot flood the context. */
export const MAX_TEXT_CHARS = 50_000;

/** Everything the extract route accepts; images go through /api/upload instead. */
export const EXTRACT_EXTENSIONS = [
  ".pdf",
  // Plain text and data
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".log", ".ini", ".cfg", ".conf",
  // Code
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".swift", ".sh", ".bash", ".zsh", ".sql", ".php", ".lua", ".r", ".pl", ".css", ".scss", ".html", ".svelte", ".vue",
];

const EXTENSION_SET = new Set(EXTRACT_EXTENSIONS);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function isExtractable(name: string): boolean {
  return EXTENSION_SET.has(extOf(name));
}

/** Clips extracted text to MAX_TEXT_CHARS and says whether it was cut. */
export function clipText(text: string): { text: string; truncated: boolean } {
  const clean = text.replace(/\u0000/g, "").trim();
  if (clean.length <= MAX_TEXT_CHARS) return { text: clean, truncated: false };
  return { text: clean.slice(0, MAX_TEXT_CHARS), truncated: true };
}

export interface ExtractedFile {
  name: string;
  text: string;
  truncated: boolean;
}

/**
 * Extracts an attachment's text. PDF goes through unpdf (serverless-safe PDF.js);
 * everything else (CSV included, passed as-is) is decoded as UTF-8.
 */
export async function extractAttachment(name: string, bytes: Uint8Array): Promise<ExtractedFile> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${name} is larger than 10 MB.`);
  const ext = extOf(name);
  if (!EXTENSION_SET.has(ext)) throw new Error(`Unsupported file type: ${ext || name}`);
  if (ext === ".pdf") {
    // Lazy so the client bundle never pulls in PDF.js.
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    const clipped = clipText(text);
    return { name, ...clipped };
  }
  const decoded = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  const clipped = clipText(decoded);
  return { name, ...clipped };
}
