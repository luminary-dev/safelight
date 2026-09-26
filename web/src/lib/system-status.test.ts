import { describe, expect, it } from "vitest";
import { deriveStatus, type StatusInputs } from "./system-status";

function inputs(overrides?: Partial<StatusInputs>): StatusInputs {
  return {
    checking: false,
    topMode: "image",
    online: true,
    progressConnected: true,
    ollamaUp: true,
    localChatCount: 1,
    localImageCount: 1,
    keys: [],
    cloudErrors: undefined,
    chatCounts: {},
    imageCounts: {},
    onAddKey: () => undefined,
    ...overrides,
  };
}

describe("deriveStatus", () => {
  it("shows checking rows before the first health answer", () => {
    const { systems, overall } = deriveStatus(inputs({ checking: true }));
    expect(systems).toHaveLength(2);
    expect(systems.every((r) => r.detail.key === "checking")).toBe(true);
    expect(overall).toEqual({ tone: "checking", label: { key: "overallChecking" } });
  });

  it("is ready to render when ComfyUI is up in image mode, ignoring unconfigured clouds", () => {
    const { overall } = deriveStatus(inputs());
    expect(overall).toEqual({ tone: "ok", label: { key: "readyToRender" } });
  });

  it("is only partly ready when ComfyUI is down even with a working cloud image provider", () => {
    // Preserved pre-refactor behavior: a down ComfyUI row always blocks the ok tone in image mode.
    const { overall } = deriveStatus(
      inputs({ online: false, keys: [{ provider: "openai", configured: true, hint: "…abcd" }], imageCounts: { openai: 2 } }),
    );
    expect(overall).toEqual({ tone: "warn", label: { key: "partlyReady" } });
  });

  it("degrades to warn when a configured provider is erroring beside a working one", () => {
    const { systems, overall } = deriveStatus(
      inputs({
        keys: [
          { provider: "openai", configured: true },
          { provider: "gemini", configured: true },
        ],
        cloudErrors: { gemini: "401 API key not valid" },
      }),
    );
    const gemini = systems.find((r) => r.id === "gemini");
    expect(gemini?.tone).toBe("down");
    // The HTTP status prefix is stripped before the message reaches the catalog.
    expect(gemini?.detail).toEqual({ key: "cloudError", values: { message: "API key not valid" } });
    expect(gemini?.action?.label).toEqual({ key: "fixKey" });
    expect(overall.tone).toBe("warn");
  });

  it("chat mode ignores ComfyUI and reports nothing to chat with when all chat backends are down", () => {
    const { overall } = deriveStatus(inputs({ topMode: "chat", ollamaUp: false, localChatCount: 0 }));
    expect(overall).toEqual({ tone: "down", label: { key: "nothingToChat" } });
  });

  it("offers the add-key action for unconfigured cloud providers", () => {
    let opened = 0;
    const { systems } = deriveStatus(inputs({ onAddKey: () => opened++ }));
    const row = systems.find((r) => r.id === "anthropic");
    expect(row?.tone).toBe("off");
    expect(row?.detail).toEqual({ key: "noKey" });
    expect(row?.action?.label).toEqual({ key: "addKey" });
    row?.action?.onClick();
    expect(opened).toBe(1);
  });

  it("reconnecting live progress is a warning, not ok", () => {
    const { systems } = deriveStatus(inputs({ progressConnected: false }));
    const comfy = systems.find((r) => r.id === "comfy");
    expect(comfy?.tone).toBe("warn");
    expect(comfy?.detail).toEqual({ key: "comfyReconnecting" });
  });

  it("carries model counts as ICU values for the ok rows", () => {
    const { systems } = deriveStatus(
      inputs({
        localImageCount: 3,
        localChatCount: 2,
        keys: [{ provider: "openai", configured: true, hint: "…abcd" }],
        chatCounts: { openai: 4 },
        imageCounts: { openai: 2 },
      }),
    );
    expect(systems.find((r) => r.id === "comfy")?.detail).toEqual({ key: "comfyOk", values: { count: 3 } });
    expect(systems.find((r) => r.id === "ollama")?.detail).toEqual({ key: "ollamaOk", values: { count: 2 } });
    expect(systems.find((r) => r.id === "openai")?.detail).toEqual({ key: "cloudOkBoth", values: { chat: 4, image: 2, hint: "…abcd" } });
  });

  it("summarises single-capability cloud providers with the matching key", () => {
    const { systems } = deriveStatus(
      inputs({
        keys: [
          { provider: "openai", configured: true, hint: "…a" },
          { provider: "anthropic", configured: true, hint: "…b" },
          { provider: "gemini", configured: true },
        ],
        chatCounts: { anthropic: 5 },
        imageCounts: { openai: 1 },
      }),
    );
    expect(systems.find((r) => r.id === "openai")?.detail).toEqual({ key: "cloudOkImage", values: { image: 1, hint: "…a" } });
    expect(systems.find((r) => r.id === "anthropic")?.detail).toEqual({ key: "cloudOkChat", values: { chat: 5, hint: "…b" } });
    expect(systems.find((r) => r.id === "gemini")?.detail).toEqual({ key: "cloudOkConnected", values: { hint: "" } });
  });
});
