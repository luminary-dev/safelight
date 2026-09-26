"use client";

import { useCallback, useEffect, useState } from "react";
import { loadString } from "@/lib/local-prefs";
import { chatModelKey, type ChatModelInfo } from "@/components/ChatMode";
import type { KeyStatus } from "@/components/KeysDialog";

const CHAT_MODEL_KEY = "safelight.chatModel.v1";

/** Chat backends and provider keys: what models exist, whether Ollama is up, which keys are set. */
export function useBackends() {
  const [chatModels, setChatModels] = useState<ChatModelInfo[]>([]);
  const [ollamaUp, setOllamaUp] = useState(false);
  const [defaultChatModel, setDefaultChatModel] = useState(() => loadString(CHAT_MODEL_KEY, ""));
  const [keys, setKeys] = useState<KeyStatus[]>([]);

  useEffect(() => {
    try {
      if (defaultChatModel) localStorage.setItem(CHAT_MODEL_KEY, defaultChatModel);
    } catch {
      /* ignore */
    }
  }, [defaultChatModel]);

  const loadKeys = useCallback(async () => {
    const res = await fetch("/api/keys").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { keys: KeyStatus[] };
    setKeys(data.keys);
  }, []);

  const loadChatModels = useCallback(async () => {
    const res = await fetch("/api/chat/models").catch(() => null);
    if (!res?.ok) {
      setOllamaUp(false);
      return;
    }
    const data = (await res.json()) as { ollamaUp: boolean; models: ChatModelInfo[] };
    setOllamaUp(data.ollamaUp);
    setChatModels(data.models);
    setDefaultChatModel((m) => (m && data.models.some((x) => chatModelKey(x) === m) ? m : data.models[0] ? chatModelKey(data.models[0]) : ""));
  }, []);

  return { chatModels, ollamaUp, defaultChatModel, setDefaultChatModel, keys, loadKeys, loadChatModels };
}
