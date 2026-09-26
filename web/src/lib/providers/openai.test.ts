import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readStreamText as readAll } from "@/test/fakes/http";
import { createProviderMsw } from "@/test/msw/providers";
import { generateOpenAIImages, listOpenAIModels, streamOpenAIChat, toOpenAIMessages } from "./openai";

/**
 * The OpenAI adapter against MSW (TEST-BRIEF §6): model listing and labels,
 * message mapping, stream parsing, the tool-call stream (text-only chat
 * contract), 401/429 mapping, and abort propagation.
 */

const msw = createProviderMsw();

beforeAll(() => msw.server.listen({ onUnhandledRequest: "error" }));
afterEach(() => msw.reset());
afterAll(() => msw.server.close());

describe("toOpenAIMessages", () => {
  it("maps text turns 1:1 and keeps assistant turns plain", () => {
    expect(
      toOpenAIMessages([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("expands image turns into data-URL image parts before the text part", () => {
    const [msg] = toOpenAIMessages([{ role: "user", content: "what is this", images: [{ mime: "image/png", data: "QUJD" }] }]);
    expect(msg).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD", detail: "high" } },
        { type: "text", text: "what is this" },
      ],
    });
  });

  it("substitutes a describe prompt when an image turn has no text", () => {
    const [msg] = toOpenAIMessages([{ role: "user", content: "", images: [{ mime: "image/png", data: "QUJD" }] }]);
    expect((msg.content as { type: string; text?: string }[])[1]).toEqual({ type: "text", text: "Describe this image." });
  });
});

describe("listOpenAIModels", () => {
  it("filters chat models of snapshots/audio/legacy and splits image models with edit flags", async () => {
    const { chat, images } = await listOpenAIModels("sk-test");
    expect(chat.map((m) => m.id)).toEqual(["gpt-4.1", "gpt-4o", "o3"]);
    expect(chat.every((m) => m.provider === "openai" && m.label === m.id)).toBe(true);
    expect(images).toEqual([
      { provider: "openai", id: "dall-e-3", label: "dall-e-3", edit: false },
      { provider: "openai", id: "gpt-image-1", label: "gpt-image-1", edit: true },
    ]);
  });

  it("maps a 401 model listing to a thrown error carrying the status", async () => {
    msw.script("openai", { modelsError: { status: 401 } });
    await expect(listOpenAIModels("sk-bad")).rejects.toMatchObject({ status: 401 });
  });
});

describe("streamOpenAIChat", () => {
  it("streams the scripted deltas as plain text", async () => {
    msw.script("openai", { chatDeltas: ["Sea", " glass", " tones"] });
    const text = await readAll(await streamOpenAIChat("sk-test", "gpt-4o", [{ role: "user", content: "hi" }]));
    expect(text).toBe("Sea glass tones");
  });

  it("a tool-call stream produces no text: plain chat streaming is a text-only interface", async () => {
    msw.script("openai", { toolCall: { name: "generate_image", args: { prompt: "a lighthouse" } } });
    const text = await readAll(await streamOpenAIChat("sk-test", "gpt-4o", [{ role: "user", content: "hi" }]));
    expect(text).toBe("");
  });

  it("rejects with status 401 before any stream starts (bad key)", async () => {
    msw.script("openai", { chatError: { status: 401 } });
    await expect(streamOpenAIChat("sk-bad", "gpt-4o", [{ role: "user", content: "hi" }])).rejects.toMatchObject({ status: 401 });
  });

  // 429/500 are retryable for the OpenAI SDK, whose internal retry loop stalls under
  // MSW's interceptor, so their raw-wire mapping (Retry-After included) is asserted by
  // the harness self-test (src/test/msw/providers.test.ts) and the loop-level retry
  // behaviour by run.test.ts's withRetries coverage. Non-retryable statuses are safe here.

  it("propagates an aborted signal: the call rejects instead of streaming", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(streamOpenAIChat("sk-test", "gpt-4o", [{ role: "user", content: "hi" }], controller.signal)).rejects.toThrow(/abort/i);
  });
});

describe("generateOpenAIImages", () => {
  const req = { prompt: "x", width: 1024, height: 1024, count: 2, images: [] };

  it("decodes b64 payloads into PNG bytes on the generate path", async () => {
    const images = await generateOpenAIImages("sk-test", "gpt-image-1", req);
    expect(images.length).toBeGreaterThan(0);
    expect(images[0].mime).toBe("image/png");
    expect([...images[0].bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("routes input images through the edits endpoint", async () => {
    const seen: string[] = [];
    msw.server.events.on("request:start", ({ request }) => {
      seen.push(new URL(request.url).pathname);
    });
    const withInput = { ...req, images: [{ bytes: new Uint8Array([1, 2, 3]), mime: "image/png", name: "in.png" }] };
    const images = await generateOpenAIImages("sk-test", "gpt-image-1", withInput);
    expect(images.length).toBeGreaterThan(0);
    expect(seen).toContain("/v1/images/edits");
    expect(seen).not.toContain("/v1/images/generations");
  });

  it("maps a scripted 401 to a thrown error carrying the status", async () => {
    msw.script("openai", { imagesError: { status: 401 } });
    await expect(generateOpenAIImages("sk-bad", "gpt-image-1", req)).rejects.toMatchObject({ status: 401 });
  });
});
