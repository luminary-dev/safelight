import { beforeEach, describe, expect, it } from "vitest";
import {
  aBlueprint,
  aChatSession,
  aCodeSession,
  aGenerateRequest,
  aJob,
  aLibraryImage,
  aMessage,
  aModelEntry,
  aProject,
  anImageSession,
  aUsageEvent,
  resetFactorySequence,
} from "./index";

beforeEach(() => resetFactorySequence());

describe("factories", () => {
  it("are deterministic after a sequence reset", () => {
    const a = aProject();
    resetFactorySequence();
    const b = aProject();
    expect(a).toEqual(b);
  });

  it("never collide within a test", () => {
    const ids = [aProject().id, aProject().id, aChatSession().id, aCodeSession().id];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("aChatSession is a complete chat with alternating messages, overridable", () => {
    const s = aChatSession({ model: "claude-sonnet-4-5", agent: true });
    expect(s.kind).toBe("chat");
    expect(s.model).toBe("claude-sonnet-4-5");
    expect(s.agent).toBe(true);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.titled).toBe(false);
  });

  it("anImageSession({ jobs: 3 }) builds three jobs and points currentJobId at the last", () => {
    const s = anImageSession({ jobs: 3 });
    expect(s.jobs).toHaveLength(3);
    expect(s.currentJobId).toBe(s.jobs[2].id);
    expect(s.jobs.every((j) => j.state === "done" && j.outputs.length === 1)).toBe(true);
  });

  it("aJob({ state }) shapes outputs and error per state", () => {
    expect(aJob({ state: "queued" }).outputs).toEqual([]);
    expect(aJob({ state: "error" }).error).toBeTruthy();
    const done = aJob();
    expect(done.state).toBe("done");
    expect(done.outputs[0].filename).toMatch(/^ComfyUI_\d{5}_\.png$/);
  });

  it("aCodeSession({ root }) carries the workspace root", () => {
    const s = aCodeSession({ root: "/tmp/repo" });
    expect(s.kind).toBe("code");
    expect(s.root).toBe("/tmp/repo");
    expect(s.approvedPaths).toEqual([]);
  });

  it("aModelEntry({ family }) picks a matching name and folder per family", () => {
    expect(aModelEntry({ family: "qwen-image" })).toMatchObject({ folder: "unet_gguf", name: "qwen-image-Q4_K_M.gguf" });
    expect(aModelEntry({ family: "sdxl" })).toMatchObject({ folder: "checkpoints" });
    expect(aModelEntry({ family: "cloud" })).toMatchObject({ folder: "cloud", provider: "openai", edit: true });
  });

  it("aGenerateRequest is a complete, valid request", () => {
    const req = aGenerateRequest({ prompt: "sea glass", batch: 2 });
    expect(req.prompt).toBe("sea glass");
    expect(req.batch).toBe(2);
    expect(req.mode).toBe("txt2img");
    expect(req.width).toBeGreaterThan(0);
    expect(req.textEncoders.length).toBeGreaterThan(0);
  });

  it("aBlueprint has a prompt input and a seed-flagged number input with patch targets", () => {
    const bp = aBlueprint();
    expect(bp.inputs.map((i) => i.kind)).toEqual(["prompt", "number"]);
    expect(bp.inputs[1].seed).toBe(true);
    expect(bp.inputs.every((i) => i.targets.length > 0)).toBe(true);
    expect(bp.requiredNodeClasses).toContain("SaveImage");
  });

  it("aLibraryImage and aUsageEvent produce row-shaped objects", () => {
    const img = aLibraryImage({ favorite: 1, tags: ["hero"] });
    expect(img.path).toMatch(/\.png$/);
    expect(img.favorite).toBe(1);
    expect(img.tags).toEqual(["hero"]);
    const usage = aUsageEvent({ provider: "anthropic" });
    expect(usage.provider).toBe("anthropic");
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.ts).toBeGreaterThan(0);
  });

  it("aMessage alternates roles by sequence", () => {
    expect(aMessage().role).toBe("user");
    expect(aMessage().role).toBe("assistant");
  });
});
