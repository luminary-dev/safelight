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
    expect(overall).toEqual({ tone: "checking", label: "Checking" });
  });

  it("is ready to render when ComfyUI is up in image mode, ignoring unconfigured clouds", () => {
    const { overall } = deriveStatus(inputs());
    expect(overall).toEqual({ tone: "ok", label: "Ready to render" });
  });

  it("is only partly ready when ComfyUI is down even with a working cloud image provider", () => {
    // Preserved pre-refactor behavior: a down ComfyUI row always blocks the ok tone in image mode.
    const { overall } = deriveStatus(
      inputs({ online: false, keys: [{ provider: "openai", configured: true, hint: "…abcd" }], imageCounts: { openai: 2 } }),
    );
    expect(overall).toEqual({ tone: "warn", label: "Partly ready" });
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
    expect(systems.find((r) => r.id === "gemini")?.tone).toBe("down");
    expect(overall.tone).toBe("warn");
  });

  it("chat mode ignores ComfyUI and reports nothing to chat with when all chat backends are down", () => {
    const { overall } = deriveStatus(inputs({ topMode: "chat", ollamaUp: false, localChatCount: 0 }));
    expect(overall).toEqual({ tone: "down", label: "Nothing to chat with" });
  });

  it("offers the add-key action for unconfigured cloud providers", () => {
    let opened = 0;
    const { systems } = deriveStatus(inputs({ onAddKey: () => opened++ }));
    const row = systems.find((r) => r.id === "anthropic");
    expect(row?.tone).toBe("off");
    row?.action?.onClick();
    expect(opened).toBe(1);
  });

  it("reconnecting live progress is a warning, not ok", () => {
    const { systems } = deriveStatus(inputs({ progressConnected: false }));
    expect(systems.find((r) => r.id === "comfy")?.tone).toBe("warn");
  });
});
