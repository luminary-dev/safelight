import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readStreamText as readAll } from "@/test/fakes/http";
import { createProviderMsw } from "@/test/msw/providers";
import { generateGeminiImages, listGeminiModels, streamGeminiChat, toContents } from "./gemini";
import { closestAspect } from "./types";

/**
 * The Gemini adapter against MSW (TEST-BRIEF §6): catalog splitting, content
 * mapping, stream parsing, image generation, and — because @google/genai does
 * not auto-retry — the 401/429(Retry-After)/500 error mapping lives here.
 */

const msw = createProviderMsw();

beforeAll(() => msw.server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  msw.reset();
  msw.server.resetHandlers(); // drops per-test server.use overrides
});
afterAll(() => msw.server.close());

const TURN = [{ role: "user" as const, content: "hi" }];
const IMG_REQ = { prompt: "a cove", width: 1024, height: 1024, count: 1, images: [] };

describe("toContents", () => {
  it("maps assistant to the model role and text to a part", () => {
    expect(toContents([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }])).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
  });

  it("puts inlineData image parts before the text and substitutes a describe prompt", () => {
    expect(toContents([{ role: "user", content: "", images: [{ mime: "image/png", data: "QUJD" }] }])).toEqual([
      { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "QUJD" } }, { text: "Describe this image." }] },
    ]);
  });
});

describe("closestAspect", () => {
  const OPTIONS = ["1:1", "3:4", "4:3", "9:16", "16:9"];

  it.each([
    [1024, 1024, "1:1"],
    [896, 1152, "3:4"],
    [1344, 768, "16:9"],
    [768, 1344, "9:16"],
    [1248, 832, "4:3"],
  ])("%d×%d → %s", (w, h, expected) => {
    expect(closestAspect(w, h, OPTIONS)).toBe(expected);
  });
});

describe("listGeminiModels", () => {
  it("splits chat from image models and drops non-gemini / non-chat entries", async () => {
    const { chat, images } = await listGeminiModels("AIza-test");
    expect(chat).toEqual([{ provider: "gemini", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }]);
    expect(images).toEqual([{ provider: "gemini", id: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", edit: true }]);
  });

  it("throws on a 401 listing", async () => {
    msw.script("gemini", { modelsError: { status: 401 } });
    await expect(listGeminiModels("AIza-bad")).rejects.toThrow(/401/);
  });
});

describe("streamGeminiChat", () => {
  it("streams text deltas", async () => {
    msw.script("gemini", { chatDeltas: ["One", " two", " three"] });
    expect(await readAll(await streamGeminiChat("AIza-test", "gemini-2.5-pro", TURN))).toBe("One two three");
  });

  it("maps a 401 to a rejection naming the status", async () => {
    msw.script("gemini", { chatError: { status: 401 } });
    await expect(streamGeminiChat("AIza-bad", "gemini-2.5-pro", TURN)).rejects.toThrow(/401|UNAUTHENTICATED/);
  });

  it("maps a 429 with Retry-After to a rejection naming the rate limit", async () => {
    msw.script("gemini", { chatError: { status: 429, retryAfter: 7 } });
    await expect(streamGeminiChat("AIza-test", "gemini-2.5-pro", TURN)).rejects.toThrow(/429|RESOURCE_EXHAUSTED/);
  });

  it("maps a 500 to a rejection naming the server error", async () => {
    msw.script("gemini", { chatError: { status: 500 } });
    await expect(streamGeminiChat("AIza-test", "gemini-2.5-pro", TURN)).rejects.toThrow(/500|INTERNAL/);
  });
});

describe("generateGeminiImages", () => {
  it("decodes inlineData into PNG bytes", async () => {
    const images = await generateGeminiImages("AIza-test", "gemini-2.5-flash-image", IMG_REQ);
    expect(images).toHaveLength(1);
    expect(images[0].mime).toBe("image/png");
    expect([...images[0].bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("issues one request per count", async () => {
    let posts = 0;
    msw.server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname.includes(":generateContent")) posts++;
    });
    const images = await generateGeminiImages("AIza-test", "gemini-2.5-flash-image", { ...IMG_REQ, count: 2 });
    expect(posts).toBe(2);
    expect(images.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the model's refusal text when no image comes back", async () => {
    msw.server.use(
      http.post("https://generativelanguage.googleapis.com/v1beta/models/*", ({ request }) => {
        if (!new URL(request.url).pathname.includes(":generateContent")) return undefined;
        return HttpResponse.json({ candidates: [{ content: { role: "model", parts: [{ text: "I cannot render that." }] } }] });
      }),
    );
    await expect(generateGeminiImages("AIza-test", "gemini-2.5-flash-image", IMG_REQ)).rejects.toThrow(/Gemini returned no image: I cannot render that\./);
  });

  it("maps a 401 on the images endpoint to a rejection", async () => {
    msw.script("gemini", { imagesError: { status: 401 } });
    await expect(generateGeminiImages("AIza-bad", "gemini-2.5-flash-image", IMG_REQ)).rejects.toThrow(/401|UNAUTHENTICATED/);
  });
});
