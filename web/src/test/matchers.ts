import path from "node:path";
import type { AgentEvent } from "@/lib/agent/tools";
import { contrastRatio } from "@/lib/theme/contrast";

/**
 * Safelight's custom matchers, registered for every project via
 * src/test/setup.matchers.ts (wired into vitest.config.ts setupFiles).
 *
 *   expect("/tmp/root/a/b.png").toBeWithinDirectory("/tmp/root");
 *   expect(graph).toMatchGraphShape();                       // ComfyUI API graph invariants
 *   await expect(response).toHaveStatusAndJson(400, { error: "…" });  // subset match
 *   expect(events).toEmitAgentEvents([{ type: "tool", name: "generate_image" }, { type: "done" }]);
 *   expect(["#e2e8f0", "#0a1628"]).toHaveContrastRatio(4.5); // or a DOM element in jsdom
 *
 * The contrast matcher shares lib/theme/contrast.ts, so the app's own UI is
 * held to the same WCAG math it enforces on user themes (TEST-BRIEF §14).
 */

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

/** Deep subset: every key in `expected` must match in `actual`; arrays match element-wise. */
function deepSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => deepSubset(actual[i], e));
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => deepSubset((actual as Record<string, unknown>)[k], v));
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function toBeWithinDirectory(received: unknown, root: string): MatcherResult {
  if (typeof received !== "string") {
    return { pass: false, message: () => `expected a path string, got ${typeof received}` };
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(received);
  const rel = path.relative(resolvedRoot, resolved);
  const pass = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  return {
    pass,
    message: () => (pass ? `expected ${resolved} NOT to be within ${resolvedRoot}` : `expected ${resolved} to be within ${resolvedRoot} (relative: ${rel})`),
  };
}

interface GraphNode {
  class_type?: unknown;
  inputs?: unknown;
}

/** A structurally valid ComfyUI API graph: nodes with class_type + inputs, no dangling [nodeId, slot] references. */
export function toMatchGraphShape(received: unknown): MatcherResult {
  const problems: string[] = [];
  if (received === null || typeof received !== "object" || Array.isArray(received)) {
    return { pass: false, message: () => `expected a graph object, got ${show(received)}` };
  }
  const graph = received as Record<string, GraphNode>;
  const ids = new Set(Object.keys(graph));
  if (ids.size === 0) problems.push("graph has no nodes");
  for (const [id, node] of Object.entries(graph)) {
    if (typeof node?.class_type !== "string" || !node.class_type) problems.push(`node ${id}: missing class_type`);
    if (node?.inputs === null || typeof node?.inputs !== "object" || Array.isArray(node?.inputs)) {
      problems.push(`node ${id}: inputs is not an object`);
      continue;
    }
    for (const [inputName, value] of Object.entries(node.inputs as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number") {
        if (!ids.has(value[0])) problems.push(`node ${id}: input "${inputName}" references missing node ${value[0]}`);
      }
    }
  }
  const pass = problems.length === 0;
  return {
    pass,
    message: () => (pass ? "expected the graph NOT to be a valid ComfyUI API graph" : `not a valid ComfyUI API graph:\n  ${problems.join("\n  ")}`),
  };
}

export async function toHaveStatusAndJson(received: unknown, status: number, body?: unknown): Promise<MatcherResult> {
  if (!(received instanceof Response)) {
    return { pass: false, message: () => `expected a Response, got ${typeof received}` };
  }
  if (received.status !== status) {
    const text = await received
      .clone()
      .text()
      .catch(() => "<unreadable>");
    return { pass: false, message: () => `expected status ${status}, got ${received.status}. Body: ${text.slice(0, 500)}` };
  }
  const contentType = received.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { pass: false, message: () => `expected an application/json response, got content-type "${contentType}"` };
  }
  let parsed: unknown;
  try {
    parsed = await received.clone().json();
  } catch {
    return { pass: false, message: () => "response body is not valid JSON" };
  }
  if (body !== undefined && !deepSubset(parsed, body)) {
    return { pass: false, message: () => `body does not match.\nexpected subset: ${show(body)}\nreceived:        ${show(parsed)}` };
  }
  return { pass: true, message: () => `expected response NOT to have status ${status} with matching JSON` };
}

/**
 * Exact ordered sequence match with per-event subset semantics: the received
 * list must have the same length, and received[i] must contain expected[i]'s
 * fields. Pass only the fields the test cares about.
 */
export function toEmitAgentEvents(received: unknown, expected: Partial<AgentEvent>[]): MatcherResult {
  if (!Array.isArray(received)) {
    return { pass: false, message: () => `expected an array of AgentEvents, got ${typeof received}` };
  }
  const problems: string[] = [];
  if (received.length !== expected.length) {
    problems.push(`expected ${expected.length} events, got ${received.length}: [${received.map((e) => (e as { type?: string })?.type).join(", ")}]`);
  } else {
    expected.forEach((e, i) => {
      if (!deepSubset(received[i], e)) problems.push(`event ${i}: expected ${show(e)}, got ${show(received[i])}`);
    });
  }
  const pass = problems.length === 0;
  return {
    pass,
    message: () => (pass ? "expected the event sequence NOT to match" : `agent event sequence mismatch:\n  ${problems.join("\n  ")}`),
  };
}

function cssColorToHex(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Received is either a [foreground, background] pair of hex colors, or a DOM
 * element (jsdom) whose computed color/background-color are compared.
 */
export function toHaveContrastRatio(received: unknown, min: number): MatcherResult {
  let fg: string | null = null;
  let bg: string | null = null;
  let label = "";
  if (Array.isArray(received) && received.length === 2 && typeof received[0] === "string" && typeof received[1] === "string") {
    fg = cssColorToHex(received[0]);
    bg = cssColorToHex(received[1]);
    label = `${received[0]} on ${received[1]}`;
  } else if (typeof Element !== "undefined" && received instanceof Element) {
    const style = getComputedStyle(received);
    fg = cssColorToHex(style.color);
    bg = cssColorToHex(style.backgroundColor);
    label = `<${received.tagName.toLowerCase()}> color ${style.color} on background ${style.backgroundColor}`;
  }
  if (!fg || !bg) {
    return { pass: false, message: () => `expected [fg, bg] hex colors or a styled element; could not resolve colors from ${show(received)}` };
  }
  const ratio = contrastRatio(fg, bg);
  const pass = ratio >= min;
  return {
    pass,
    message: () =>
      pass
        ? `expected contrast of ${label} (${ratio.toFixed(2)}:1) to be below ${min}:1`
        : `expected contrast of ${label} to be at least ${min}:1, got ${ratio.toFixed(2)}:1`,
  };
}

export const safelightMatchers = {
  toBeWithinDirectory,
  toMatchGraphShape,
  toHaveStatusAndJson,
  toEmitAgentEvents,
  toHaveContrastRatio,
};

interface SafelightMatchers<R> {
  toBeWithinDirectory(root: string): R;
  toMatchGraphShape(): R;
  /** Async matcher: always await it. */
  toHaveStatusAndJson(status: number, body?: unknown): Promise<void>;
  toEmitAgentEvents(expected: Partial<AgentEvent>[]): R;
  toHaveContrastRatio(min: number): R;
}

declare module "vitest" {
  // The type parameters must match vitest's own `Matchers<R, T>` declaration exactly;
  // T is required by that signature even though these matchers never use it.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends SafelightMatchers<R> {}
}
