import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readStreamText as readAll } from "@/test/fakes/http";
import { createProviderMsw } from "@/test/msw/providers";
import { listAnthropicModels, streamAnthropicChat, toAnthropicMessages } from "./anthropic";

/**
 * The Anthropic adapter against MSW (TEST-BRIEF §6): model listing with
 * display names, message mapping, SSE stream parsing, tool_use fragment
 * assembly not corrupting the text stream, 401 mapping, abort propagation.
 * Retryable statuses (429/500) stall the SDK's internal retry loop under MSW;
 * their wire shape is asserted by src/test/msw/providers.test.ts and the
 * agent-loop retry behaviour by run.test.ts.
 */

const msw = createProviderMsw();

beforeAll(() => msw.server.listen({ onUnhandledRequest: "error" }));
afterEach(() => msw.reset());
afterAll(() => msw.server.close());

const TURN = [{ role: "user" as const, content: "hi" }];

describe("toAnthropicMessages", () => {
  it("keeps text-only turns as plain strings", () => {
    expect(toAnthropicMessages([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }])).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("expands image turns into base64 source blocks before the text block", () => {
    const [msg] = toAnthropicMessages([{ role: "user", content: "what is this", images: [{ mime: "image/webp", data: "QUJD" }] }]);
    expect(msg).toEqual({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/webp", data: "QUJD" } },
        { type: "text", text: "what is this" },
      ],
    });
  });

  it("substitutes a describe prompt when an image turn has no text", () => {
    const [msg] = toAnthropicMessages([{ role: "user", content: "", images: [{ mime: "image/png", data: "QUJD" }] }]);
    expect((msg.content as { type: string; text?: string }[])[1]).toEqual({ type: "text", text: "Describe this image." });
  });
});

describe("listAnthropicModels", () => {
  it("labels every model with its curated display name", async () => {
    const models = await listAnthropicModels("sk-ant-test");
    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" });
    expect(models.every((m) => m.provider === "anthropic" && m.label && m.label !== m.id)).toBe(true);
  });

  it("throws with the status on a 401 listing", async () => {
    msw.script("anthropic", { modelsError: { status: 401 } });
    await expect(listAnthropicModels("sk-bad")).rejects.toMatchObject({ status: 401 });
  });
});

describe("streamAnthropicChat", () => {
  it("streams text deltas through the SDK's event protocol", async () => {
    msw.script("anthropic", { chatDeltas: ["Hi", " there", "!"] });
    expect(await readAll(await streamAnthropicChat("sk-ant-test", "claude-sonnet-4-5", TURN))).toBe("Hi there!");
  });

  it("a tool_use stream with split input_json_delta fragments completes cleanly as empty text", async () => {
    // The SDK reassembles the fragments into the final message; the chat adapter is a
    // text-only interface, so a pure tool-call turn must yield no text and no error marker.
    msw.script("anthropic", { toolCall: { name: "edit_image", args: { instruction: "make it dusk", strength: 0.5 } } });
    expect(await readAll(await streamAnthropicChat("sk-ant-test", "claude-sonnet-4-5", TURN))).toBe("");
  });

  it("maps a 401 into the adapter's in-stream bracketed error text", async () => {
    msw.script("anthropic", { chatError: { status: 401 } });
    const text = await readAll(await streamAnthropicChat("sk-bad", "claude-sonnet-4-5", TURN));
    expect(text).toMatch(/^\n\[401: .+\]$/);
  });

  it("propagates an aborted signal as in-stream error text instead of hanging", async () => {
    const controller = new AbortController();
    controller.abort();
    const text = await readAll(await streamAnthropicChat("sk-ant-test", "claude-sonnet-4-5", TURN, controller.signal));
    expect(text).toMatch(/\[.+\]/);
    expect(text).toMatch(/abort/i);
  });
});
