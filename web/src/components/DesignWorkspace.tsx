"use client";

import { Plus } from "lucide-react";
import type { JobOutput } from "@/lib/comfy/types";
import type { ChatAttachment, ChatMessage, DesignSession } from "@/lib/session-types";
import { ChatMode, chatModelKey, type ChatModelInfo, type PromptHandoff } from "./ChatMode";
import { ModelPicker } from "./ModelPicker";

/** Design as the main panel: an agent that explores the web for references and saves UI themes as swatch cards. */
export function DesignWorkspace({
  active,
  onCreateSession,
  models,
  ollamaUp,
  model,
  onModel,
  messages,
  onMessages,
  onUseAsPrompt,
  onUseAsInput,
  onOpenKeys,
  clientId,
  onUpload,
}: {
  active: DesignSession | null;
  onCreateSession: () => void;
  models: ChatModelInfo[];
  ollamaUp: boolean;
  model: string;
  onModel: (key: string) => void;
  messages: ChatMessage[];
  onMessages: (update: (prev: ChatMessage[]) => ChatMessage[]) => void;
  onUseAsPrompt: (h: PromptHandoff) => void;
  onUseAsInput: (o: JobOutput) => void;
  onOpenKeys: () => void;
  clientId: string;
  onUpload: (files: File[]) => Promise<ChatAttachment[]>;
}) {
  const toolCapable = models.filter((m) => m.provider !== "ollama" || m.tags?.includes("tools"));
  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[900px] -translate-x-1/2 bg-[radial-gradient(closest-side,var(--terracotta-wash),transparent_70%)]" />
      <div className="relative flex items-center justify-between gap-3 px-6 py-4">
        <ModelPicker
          options={toolCapable.map((m) => ({ key: chatModelKey(m), label: m.label, tags: m.tags, provider: m.provider }))}
          value={model || null}
          onChange={onModel}
          onAddKey={onOpenKeys}
          placeholder="Pick a tool-capable model"
          emptyHint={ollamaUp ? "No tool-capable models. Add an API key, or pull a tool-capable Ollama model." : "Ollama is offline. Start it with ollama serve, or add an API key."}
          className="w-auto min-w-[220px]"
        />
        <button type="button" onClick={onCreateSession} className="btn-ink gap-1.5">
          <Plus className="size-4" /> New session
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col px-6 pb-5">
        <ChatMode
          key={active?.id ?? "none"}
          sessionId={active?.id ?? "none"}
          models={toolCapable}
          ollamaUp={ollamaUp}
          model={model}
          onModel={onModel}
          messages={messages}
          onMessages={onMessages}
          onUseAsPrompt={onUseAsPrompt}
          onOpenKeys={onOpenKeys}
          agent
          onAgent={() => undefined}
          agentLocked
          agentEndpoint="/api/design"
          agentBody={{ projectId: active?.projectId }}
          onUseAsInput={onUseAsInput}
          clientId={clientId}
          showControls={false}
          onUpload={onUpload}
        />
      </div>
    </section>
  );
}
