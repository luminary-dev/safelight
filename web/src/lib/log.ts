import "server-only";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import pino from "pino";
import { dataDir } from "@/lib/db";

/**
 * Structured logging for the server side of Safelight.
 *
 * Redaction is first-class: prompt text, message content, and anything that
 * looks like a credential must never reach the log file. Callers log lengths
 * and hashes (see summarize()), and the write path scrubs every string value
 * that matches SECRET_RE as a backstop, so even a careless call site cannot
 * leak a key into data/logs/.
 */

export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Anything that looks like it could be (or contain) a credential. */
const SECRET_RE = /(sk-|gsk_|AIza|key)/i;

/** The redaction-friendly way to reference text: its length and a short hash, never the text. */
export function summarize(text: unknown): { len: number; sha256: string } {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return { len: s.length, sha256: createHash("sha256").update(s).digest("hex").slice(0, 12) };
}

function redactString(s: string): string {
  const { len, sha256 } = summarize(s);
  return `[redacted len=${len} sha256=${sha256}]`;
}

/** Deep-walks a value and replaces every string that matches SECRET_RE with a length+hash marker. */
export function scrub<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return (SECRET_RE.test(value) ? redactString(value) : value) as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrub(v, depth + 1);
    return out as T;
  }
  return value;
}

function logFile(): string {
  return path.join(dataDir(), "logs", "safelight.log");
}

const LEVEL_NAMES: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };

/**
 * Append-only destination with size-based rotation (>10 MB ⇒ .1 and start fresh)
 * and a final scrub pass over the serialized line. Logging must never throw.
 */
const destination = {
  write(line: string) {
    let out = line;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      out = JSON.stringify(scrub(parsed)) + "\n";
      if (process.env.NODE_ENV === "development") {
        const { level, time: _time, msg, ...rest } = parsed as { level?: number; time?: number; msg?: string };
        void _time; // destructured only to keep it out of the console echo
        const extra = Object.keys(rest).length ? ` ${JSON.stringify(scrub(rest))}` : "";
        console.log(`[safelight] ${LEVEL_NAMES[level ?? 30] ?? level} ${msg ?? ""}${extra}`);
      }
    } catch {
      // Not JSON somehow — scrub the raw line the crude way.
      if (SECRET_RE.test(out)) out = redactString(out) + "\n";
    }
    try {
      const file = logFile();
      mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
      } catch {
        // No file yet — nothing to rotate.
      }
      appendFileSync(file, out);
    } catch {
      // A logging failure must never take the app down.
    }
  },
};

let logger: pino.Logger | null = null;

/** The singleton server logger. The file path resolves per write, so tests can repoint SAFELIGHT_DATA_DIR. */
export function getLogger(): pino.Logger {
  if (!logger) {
    logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: undefined }, destination);
  }
  return logger;
}
