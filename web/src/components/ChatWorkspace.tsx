"use client";

import { Plus } from "lucide-react";
import type { JobOutput } from "@/lib/comfy/types";
import type { ChatAttachment, ChatMessage, ChatSession } from "@/lib/session-types";
import { ChatMode, chatModelKey, type ChatModelInfo, type PromptHandoff } from "./ChatMode";
import { ModelPicker } from "./ModelPicker";
import { ShaderBackground } from "./ShaderBackground";

/** Chat as the main panel: model pill and New chat up top, the conversation below with its centered composer. */
export function ChatWorkspace({
  active,
  onCreateSession,
  models,
  ollamaUp,
  model,
  onModel,
  agent,
  onAgent,
  messages,
  onMessages,
  onUseAsPrompt,
  onUseAsInput,
  onOpenKeys,
  preferredModel,
  clientId,
  onUpload,
}: {
  active: ChatSession | null;
  onCreateSession: () => void;
  models: ChatModelInfo[];
  ollamaUp: boolean;
  model: string;
  onModel: (key: string) => void;
  agent: boolean;
  onAgent: (on: boolean) => void;
  messages: ChatMessage[];
  onMessages: (update: (prev: ChatMessage[]) => ChatMessage[]) => void;
  onUseAsPrompt: (h: PromptHandoff) => void;
  onUseAsInput: (o: JobOutput) => void;
  onOpenKeys: () => void;
  preferredModel?: string;
  clientId: string;
  onUpload: (files: File[]) => Promise<ChatAttachment[]>;
}) {
  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* The living background: slow plasma lines in the accent color, fading out toward the composer. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <ShaderBackground />
        <div className="absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-paper-2 to-transparent" />
      </div>
      <div className="relative flex items-center justify-between gap-3 px-6 py-4">
        <ModelPicker
          options={models.map((m) => ({ key: chatModelKey(m), label: m.label, tags: m.tags, provider: m.provider }))}
          value={model || null}
          onChange={onModel}
          onAddKey={onOpenKeys}
          placeholder="Pick a chat model"
          emptyHint={ollamaUp ? "No chat models yet. Pull one with ollama pull, or add an API key." : "Ollama is offline. Start it with ollama serve, or add an API key."}
          className="w-auto min-w-[220px]"
        />
        <button type="button" onClick={onCreateSession} className="btn-ink gap-1.5">
          <Plus className="size-4" /> New chat
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col px-6 pb-5">
        <ChatMode
          key={active?.id ?? "none"}
          sessionId={active?.id ?? "none"}
          models={models}
          ollamaUp={ollamaUp}
          model={model}
          onModel={onModel}
          messages={messages}
          onMessages={onMessages}
          onUseAsPrompt={onUseAsPrompt}
          onOpenKeys={onOpenKeys}
          agent={agent}
          onAgent={onAgent}
          onUseAsInput={onUseAsInput}
          preferredModel={preferredModel}
          clientId={clientId}
          showControls={false}
          onUpload={onUpload}
        />
      </div>
    </section>
  );
}
