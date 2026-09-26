import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/agent/tools";

/** The matchers register through setup.matchers.ts — used here exactly as another test would. */

describe("toBeWithinDirectory", () => {
  const root = path.join(path.sep, "tmp", "sl-root");

  it("passes for children and the root itself, resolving relative segments", () => {
    expect(path.join(root, "outputs", "a.png")).toBeWithinDirectory(root);
    expect(root).toBeWithinDirectory(root);
    expect(path.join(root, "a", "..", "b.png")).toBeWithinDirectory(root);
  });

  it("fails for escapes, absolute elsewhere, and lookalike prefixes", () => {
    expect(path.join(root, "..", "etc", "passwd")).not.toBeWithinDirectory(root);
    expect(path.join(path.sep, "etc", "passwd")).not.toBeWithinDirectory(root);
    expect(`${root}-evil${path.sep}x`).not.toBeWithinDirectory(root); // /tmp/sl-root-evil is NOT inside /tmp/sl-root
    expect(path.join(root, "a", "..", "..", "out")).not.toBeWithinDirectory(root);
  });
});

describe("toMatchGraphShape", () => {
  const good = {
    "3": { class_type: "KSampler", inputs: { seed: 42, model: ["4", 0], positive: ["6", 0] } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a fox", clip: ["4", 1] } },
    "9": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
  };

  it("accepts a well-formed API graph", () => {
    expect(good).toMatchGraphShape();
  });

  it("rejects a dangling node reference", () => {
    const broken = { ...good, "9": { class_type: "SaveImage", inputs: { images: ["99", 0] } } };
    expect(broken).not.toMatchGraphShape();
    expect(() => expect(broken).toMatchGraphShape()).toThrow(/references missing node 99/);
  });

  it("rejects a node without class_type, non-object inputs, and an empty graph", () => {
    expect({ "1": { inputs: {} } }).not.toMatchGraphShape();
    expect({ "1": { class_type: "X", inputs: null } }).not.toMatchGraphShape();
    expect({}).not.toMatchGraphShape();
    expect("nope").not.toMatchGraphShape();
  });
});

describe("toHaveStatusAndJson", () => {
  it("passes on status + json subset, leaving the body readable", async () => {
    const res = Response.json({ ok: true, items: [{ id: 1, extra: "x" }], nested: { a: 1, b: 2 } }, { status: 201 });
    await expect(res).toHaveStatusAndJson(201, { ok: true, nested: { a: 1 } });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true); // matcher clones, never consumes
  });

  it("fails on wrong status (quoting the body), non-json, and body mismatch", async () => {
    await expect(expect(Response.json({ error: "no" }, { status: 400 })).toHaveStatusAndJson(200)).rejects.toThrow(/expected status 200, got 400[\s\S]*no/);
    await expect(expect(new Response("<html>", { headers: { "content-type": "text/html" } })).toHaveStatusAndJson(200)).rejects.toThrow(/application\/json/);
    await expect(expect(Response.json({ a: 1 })).toHaveStatusAndJson(200, { a: 2 })).rejects.toThrow(/does not match/);
  });

  it("array subsets must match element-wise and by length", async () => {
    await expect(Response.json({ items: [1, 2] })).toHaveStatusAndJson(200, { items: [1, 2] });
    await expect(expect(Response.json({ items: [1, 2, 3] })).toHaveStatusAndJson(200, { items: [1, 2] })).rejects.toThrow(/does not match/);
  });
});

describe("toEmitAgentEvents", () => {
  const events: AgentEvent[] = [
    { type: "status", text: "Rendering locally…" },
    { type: "tool", id: "t1", name: "generate_image", args: { prompt: "a fox" }, state: "running" },
    { type: "tool", id: "t1", name: "generate_image", args: { prompt: "a fox" }, state: "done" },
    { type: "text", text: "Here is your fox." },
    { type: "done" },
  ];

  it("matches the exact ordered sequence with per-event subsets", () => {
    expect(events).toEmitAgentEvents([
      { type: "status" },
      { type: "tool", name: "generate_image", state: "running" },
      { type: "tool", state: "done" },
      { type: "text", text: "Here is your fox." },
      { type: "done" },
    ]);
  });

  it("fails on wrong order, wrong count, or a field mismatch", () => {
    expect(() => expect(events).toEmitAgentEvents([{ type: "done" }])).toThrow(/expected 1 events, got 5/);
    expect(() =>
      expect(events).toEmitAgentEvents([{ type: "status" }, { type: "tool", state: "done" }, { type: "tool" }, { type: "text" }, { type: "done" }]),
    ).toThrow(/event 1/);
  });
});

describe("toHaveContrastRatio", () => {
  it("passes AA pairs and fails low-contrast ones, order-independent", () => {
    expect(["#000000", "#ffffff"]).toHaveContrastRatio(21);
    expect(["#ffffff", "#000000"]).toHaveContrastRatio(4.5);
    expect(["#e2e8f0", "#0a1628"]).toHaveContrastRatio(4.5);
    expect(["#777777", "#888888"]).not.toHaveContrastRatio(4.5);
  });

  it("reports the computed ratio on failure and rejects unusable input", () => {
    expect(() => expect(["#777777", "#888888"]).toHaveContrastRatio(4.5)).toThrow(/at least 4\.5:1, got 1\.\d\d:1/);
    expect(() => expect("not-colors").toHaveContrastRatio(4.5)).toThrow(/could not resolve colors/);
  });
});
