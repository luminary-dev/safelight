// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/safelight-state";
import { loadJSON, loadSavedSettings, loadString } from "./local-prefs";

/** Client preference helpers (localStorage + the studio.* → safelight.* rename shim). */

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("loadString", () => {
  it("reads the stored value and falls back when absent", () => {
    localStorage.setItem("safelight.tab", "library");
    expect(loadString("safelight.tab", "chat")).toBe("library");
    expect(loadString("safelight.other", "chat")).toBe("chat");
  });

  it("migrates a pre-rename studio.* value forward, copying it under the new key", () => {
    localStorage.setItem("studio.tab", "image");
    expect(loadString("safelight.tab", "chat")).toBe("image");
    expect(localStorage.getItem("safelight.tab")).toBe("image"); // copied forward…
    localStorage.setItem("studio.tab", "code");
    expect(loadString("safelight.tab", "chat")).toBe("image"); // …and the new key wins from then on
  });

  it("prefers the safelight.* key over a legacy studio.* one", () => {
    localStorage.setItem("safelight.tab", "new");
    localStorage.setItem("studio.tab", "old");
    expect(loadString("safelight.tab", "chat")).toBe("new");
  });

  it("only rewrites the safelight. prefix — a non-prefixed key never probes studio.*", () => {
    localStorage.setItem("studio.raw", "legacy");
    expect(loadString("raw", "fallback")).toBe("fallback");
  });

  it("answers the fallback when storage throws (private windows, blocked site data)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadString("safelight.tab", "chat")).toBe("chat");
  });
});

describe("loadJSON", () => {
  it("parses stored JSON and falls back on absence or garbage", () => {
    localStorage.setItem("safelight.obj", JSON.stringify({ a: 1 }));
    expect(loadJSON("safelight.obj", {})).toEqual({ a: 1 });
    expect(loadJSON("safelight.missing", { d: true })).toEqual({ d: true });
    localStorage.setItem("safelight.bad", "{not json");
    expect(loadJSON("safelight.bad", "safe")).toBe("safe");
  });

  it("reads legacy studio.* JSON through the same shim", () => {
    localStorage.setItem("studio.obj", JSON.stringify([1, 2]));
    expect(loadJSON("safelight.obj", [])).toEqual([1, 2]);
  });
});

describe("loadSavedSettings", () => {
  it("answers the defaults when nothing is saved or the blob is garbage", () => {
    expect(loadSavedSettings("safelight.settings")).toEqual(DEFAULT_SETTINGS);
    localStorage.setItem("safelight.settings", "{broken");
    expect(loadSavedSettings("safelight.settings")).toEqual(DEFAULT_SETTINGS);
  });

  it("merges saved fields over the defaults but always resets images and keeps model nullable", () => {
    localStorage.setItem(
      "safelight.settings",
      JSON.stringify({ prompt: "saved prompt", steps: 40, images: [{ ref: "stale.png" }] }),
    );
    const s = loadSavedSettings("safelight.settings");
    expect(s.prompt).toBe("saved prompt");
    expect(s.steps).toBe(40);
    expect(s.sampler).toBe(DEFAULT_SETTINGS.sampler); // untouched fields keep defaults
    expect(s.images).toEqual([]); // stale image refs never come back
    expect(s.model).toBeNull(); // re-resolved against the live catalog
  });

  it("keeps a saved model name for re-resolution", () => {
    localStorage.setItem("safelight.settings", JSON.stringify({ model: "qwen-image-Q4_K_M.gguf" }));
    expect(loadSavedSettings("safelight.settings").model).toBe("qwen-image-Q4_K_M.gguf");
  });
});
