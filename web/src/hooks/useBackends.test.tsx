import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatModelInfo } from "@/components/ChatMode";
import type { KeyStatus } from "@/components/KeysDialog";
import { json, stubFetch } from "@/components/test-utils";
import { useBackends } from "./useBackends";

const MODEL_KEY = "safelight.chatModel.v1";

const llama: ChatModelInfo = { provider: "ollama", id: "llama3.2", label: "Llama 3.2", tags: [], vision: false };
const gpt: ChatModelInfo = { provider: "openai", id: "gpt-4o", label: "GPT-4o", tags: ["vision"], vision: true };

describe("useBackends", () => {
  it("loads chat models and defaults to the first one when nothing was chosen", async () => {
    stubFetch({ url: "/api/chat/models", reply: { ollamaUp: true, models: [llama, gpt] } });
    const { result } = renderHook(() => useBackends());

    await act(() => result.current.loadChatModels());

    expect(result.current.ollamaUp).toBe(true);
    expect(result.current.chatModels).toEqual([llama, gpt]);
    expect(result.current.defaultChatModel).toBe("ollama::llama3.2");
  });

  it("keeps a stored default model that is still available", async () => {
    localStorage.setItem(MODEL_KEY, "openai::gpt-4o");
    stubFetch({ url: "/api/chat/models", reply: { ollamaUp: true, models: [llama, gpt] } });
    const { result } = renderHook(() => useBackends());

    await act(() => result.current.loadChatModels());

    expect(result.current.defaultChatModel).toBe("openai::gpt-4o");
  });

  it("falls back to the first model when the stored default vanished", async () => {
    localStorage.setItem(MODEL_KEY, "ollama::uninstalled-model");
    stubFetch({ url: "/api/chat/models", reply: { ollamaUp: true, models: [llama, gpt] } });
    const { result } = renderHook(() => useBackends());

    await act(() => result.current.loadChatModels());

    expect(result.current.defaultChatModel).toBe("ollama::llama3.2");
  });

  it("marks Ollama down and keeps the list untouched when the endpoint fails", async () => {
    stubFetch({ url: "/api/chat/models", reply: () => json({ error: "boom" }, 500) });
    const { result } = renderHook(() => useBackends());

    await act(() => result.current.loadChatModels());

    expect(result.current.ollamaUp).toBe(false);
    expect(result.current.chatModels).toEqual([]);
    expect(result.current.defaultChatModel).toBe("");
  });

  it("loadKeys stores the provider key statuses", async () => {
    const keys: KeyStatus[] = [{ provider: "openai", label: "OpenAI", configured: true, hint: "…f3ab", source: "vault", chat: true, images: true, kind: "model" as const }];
    stubFetch({ url: "/api/keys", reply: { keys } });
    const { result } = renderHook(() => useBackends());

    await act(() => result.current.loadKeys());

    expect(result.current.keys).toEqual(keys);
  });
});
