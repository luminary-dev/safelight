import { describe, expect, it, vi } from "vitest";
import { DELEGATE_TOOL_NAME, delegateToolDef, isSubAgentClient, SUB_MAX_ROUNDS, withDelegateTool, type RunAgentFn } from "./subagent";
import type { AgentEvent, ToolContext } from "./tools";

function parentCtx(overrides: Partial<ToolContext> = {}): { ctx: ToolContext; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const ctx: ToolContext = { clientId: "code-1", emit: (e) => events.push(e), ...overrides };
  return { ctx, events };
}

const BASE = {
  defs: [{ name: "fake_tool", description: "x", parameters: {} }],
  execute: vi.fn(async () => ({ result: { base: true } })),
};

describe("withDelegateTool", () => {
  it("appends the delegate_task def and keeps the base tools", () => {
    const merged = withDelegateTool(BASE, { provider: "ollama", model: "m", run: async () => {} });
    expect(merged.defs.map((d) => d.name)).toEqual(["fake_tool", DELEGATE_TOOL_NAME]);
    // Idempotent: never merged twice.
    expect(withDelegateTool(merged, { provider: "ollama", model: "m", run: async () => {} })).toBe(merged);
  });

  it("runs the child on the default studio toolset with a scoped budget and clientId", async () => {
    const seen: { provider: string; model: string; turns: unknown; ctx: ToolContext }[] = [];
    const run: RunAgentFn = async (provider, model, turns, ctx) => {
      seen.push({ provider, model, turns, ctx });
      ctx.emit({ type: "text", text: "here is the render" });
    };
    const merged = withDelegateTool(BASE, { provider: "openai", model: "gpt-5-mini", run });
    const { ctx } = parentCtx({ projectId: "p1", preferredModel: "cloud:gpt-image-1", params: { temperature: 0.3 } });

    const out = await merged.execute(DELEGATE_TOOL_NAME, { task: "render a red cube", toolset: "studio" }, ctx, "t1");
    expect(out.result).toEqual({ text: "here is the render" });
    expect(seen).toHaveLength(1);
    expect(seen[0].provider).toBe("openai");
    expect(seen[0].model).toBe("gpt-5-mini");
    expect(seen[0].turns).toEqual([{ role: "user", content: "render a red cube" }]);
    const child = seen[0].ctx;
    expect(child.clientId).toBe("code-1:sub");
    expect(child.budget).toEqual({ maxRounds: SUB_MAX_ROUNDS });
    expect(child.toolset).toBeUndefined(); // default studio toolset; run.ts resolves it
    expect(child.systemPrompt).toBeUndefined();
    expect(child.projectId).toBe("p1");
    expect(child.preferredModel).toBe("cloud:gpt-image-1");
    expect(child.params).toEqual({ temperature: 0.3 });
    expect(isSubAgentClient(child.clientId)).toBe(true);
  });

  it("forwards status prefixed and tool events as-is; child text becomes the result only", async () => {
    const toolEvent: AgentEvent = {
      type: "tool",
      id: "x",
      name: "generate_image",
      args: { prompt: "cube" },
      state: "done",
      result: { images: ["cloud/openai_1.png"] },
      images: [{ filename: "openai_1.png", subfolder: "cloud", type: "output" }],
    };
    const run: RunAgentFn = async (_p, _m, _t, ctx) => {
      ctx.emit({ type: "status", text: "run abc" });
      ctx.emit(toolEvent);
      ctx.emit({ type: "text", text: "done." });
    };
    const merged = withDelegateTool(BASE, { provider: "ollama", model: "m", run });
    const { ctx, events } = parentCtx();

    const out = await merged.execute(DELEGATE_TOOL_NAME, { task: "go", toolset: "studio" }, ctx, "t1");
    expect(events).toEqual([{ type: "status", text: "sub-agent: run abc" }, toolEvent]);
    expect(events.some((e) => e.type === "text")).toBe(false);
    expect(out.result).toEqual({ text: "done." });
  });

  it("enforces depth 1: a sub-agent client cannot delegate again", async () => {
    const run = vi.fn(async () => {});
    const merged = withDelegateTool(BASE, { provider: "ollama", model: "m", run });
    const { ctx } = parentCtx({ clientId: "code-1:sub" });
    await expect(merged.execute(DELEGATE_TOOL_NAME, { task: "go", toolset: "studio" }, ctx, "t1")).rejects.toThrow(/cannot delegate/);
    expect(run).not.toHaveBeenCalled();
  });

  it("validates its arguments and falls through for other tools", async () => {
    const merged = withDelegateTool(BASE, { provider: "ollama", model: "m", run: async () => {} });
    const { ctx } = parentCtx();
    await expect(merged.execute(DELEGATE_TOOL_NAME, { task: " ", toolset: "studio" }, ctx, "t1")).rejects.toThrow(/needs a task/);
    await expect(merged.execute(DELEGATE_TOOL_NAME, { task: "go", toolset: "code" }, ctx, "t1")).rejects.toThrow(/only 'studio'/);
    const out = await merged.execute("fake_tool", {}, ctx, "t2");
    expect(out.result).toEqual({ base: true });
  });

  it("describes itself for the model", () => {
    const def = delegateToolDef();
    expect(def.name).toBe(DELEGATE_TOOL_NAME);
    expect((def.parameters as { required: string[] }).required).toEqual(["task", "toolset"]);
  });
});
