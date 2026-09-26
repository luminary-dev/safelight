import "server-only";
import type { ProviderId } from "@/lib/providers/keys";
import type { ChatTurn } from "@/lib/providers/types";
import type { AgentEvent, ToolContext, ToolDef } from "./tools";

/**
 * Sub-agents: a `delegate_task` tool that lets a non-studio agent (code, design)
 * hand one self-contained task to a child run on the DEFAULT studio toolset —
 * e.g. "render a moodboard frame" from the code agent. The child reuses the
 * parent's provider/model and signal, gets a small round budget, and streams its
 * status/tool events through the parent's emit so the UI can show the work
 * (renders included). Depth is capped at 1: a child never gets delegate_task.
 *
 * run.ts owns the merge (mirroring how MCP tools merge) and passes runAgent in,
 * so this module never imports the loop and tests can substitute a fake runner.
 */

export const DELEGATE_TOOL_NAME = "delegate_task";
/** Child runs are identifiable by this clientId suffix; it is also the depth guard. */
export const SUB_CLIENT_SUFFIX = ":sub";
/** Delegated tasks are chat-sized: one or two renders plus a reply. */
export const SUB_MAX_ROUNDS = 8;

type Toolset = NonNullable<ToolContext["toolset"]>;

export type RunAgentFn = (provider: ProviderId | "ollama", model: string, turns: ChatTurn[], ctx: ToolContext) => Promise<void>;

export function isSubAgentClient(clientId: string): boolean {
  return clientId.endsWith(SUB_CLIENT_SUFFIX);
}

export function delegateToolDef(): ToolDef {
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      "Delegate one self-contained task to a sub-agent running Safelight's studio toolset (image generation and editing, model and gallery browsing). Use it when the task needs a render or an image lookup your own tools cannot do. The sub-agent starts fresh, so put the full context in `task`; its final reply comes back as this tool's result.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complete, self-contained instructions for the sub-agent." },
        toolset: { type: "string", enum: ["studio"], description: "Which toolset the sub-agent runs. Only 'studio' exists." },
      },
      required: ["task", "toolset"],
      additionalProperties: false,
    },
  };
}

/**
 * Appends delegate_task to a toolset, the same way MCP tools merge. The executor
 * spawns a child run with the DEFAULT studio toolset (childCtx carries no toolset
 * override, so run.ts falls back to TOOLS and — via the notes merge — the child
 * also sees the project notes tools when a projectId rides along). The child's
 * text becomes the tool result; its status events are forwarded prefixed
 * "sub-agent: " and its tool events are forwarded as-is so images appear.
 */
export function withDelegateTool(base: Toolset, opts: { provider: ProviderId | "ollama"; model: string; run: RunAgentFn }): Toolset {
  if (base.defs.some((d) => d.name === DELEGATE_TOOL_NAME)) return base;
  const execute: Toolset["execute"] = async (name, args, ctx, id) => {
    if (name !== DELEGATE_TOOL_NAME) return base.execute(name, args, ctx, id);
    if (isSubAgentClient(ctx.clientId)) throw new Error("A sub-agent cannot delegate further.");
    const task = String(args.task ?? "").trim();
    if (!task) throw new Error("delegate_task needs a task.");
    const requested = args.toolset === undefined ? "studio" : String(args.toolset);
    if (requested !== "studio") throw new Error(`Unknown toolset '${requested}' — only 'studio' can be delegated to.`);

    const texts: string[] = [];
    const childCtx: ToolContext = {
      clientId: `${ctx.clientId}${SUB_CLIENT_SUFFIX}`,
      budget: { maxRounds: SUB_MAX_ROUNDS },
      preferredModel: ctx.preferredModel,
      params: ctx.params,
      projectId: ctx.projectId,
      signal: ctx.signal,
      emit: (event: AgentEvent) => {
        switch (event.type) {
          case "text":
            texts.push(event.text); // the child's prose is the tool result, not parent chat
            return;
          case "tool":
            ctx.emit(event); // as-is, images included, so renders show in the parent stream
            return;
          case "status":
            ctx.emit({ type: "status", text: `sub-agent: ${event.text}` });
            return;
          case "error":
            ctx.emit({ type: "status", text: `sub-agent: ${event.text}` });
            return;
          default:
            return; // approval/done never leave the child
        }
      },
    };
    // Cloud usage inside the child flows through the existing ledger automatically:
    // the child is a full runAgent with its own run row and recordRound calls.
    await opts.run(opts.provider, opts.model, [{ role: "user", content: task }], childCtx);
    return { result: { text: texts.join("\n\n").trim() || "(the sub-agent finished without a reply)" }, note: "sub-agent" };
  };
  return { defs: [...base.defs, delegateToolDef()], execute };
}
