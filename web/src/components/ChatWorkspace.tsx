"use client";

import { Plus } from "lucide-react";
import type { JobOutput } from "@/lib/comfy/types";
import type { ChatAttachment, ChatMessage, ChatParams, ChatSession } from "@/lib/session-types";
import { ChatMode, chatModelKey, TunePopover, type ChatModelInfo, type PromptHandoff } from "./ChatMode";
import { ModelPicker } from "./ModelPicker";

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
  onBranch,
  onPatchSession,
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
  /** Fork the conversation from a message; the coordinator seeds a new session with the truncated history. */
  onBranch?: (messages: ChatMessage[]) => void;
  /** Persists per-session tuning (system prompt, sampling params) on the active chat session. */
  onPatchSession?: (patch: Partial<{ system: string; params: ChatParams }>) => void;
}) {
  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* The soft lime glow behind an empty conversation. */}
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[900px] -translate-x-1/2 bg-[radial-gradient(closest-side,var(--terracotta-wash),transparent_70%)]" />
      <div className="relative flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ModelPicker
            options={models.map((m) => ({ key: chatModelKey(m), label: m.label, tags: m.tags, provider: m.provider }))}
            value={model || null}
            onChange={onModel}
            onAddKey={onOpenKeys}
            placeholder="Pick a chat model"
            emptyHint={ollamaUp ? "No chat models yet. Pull one with ollama pull, or add an API key." : "Ollama is offline. Start it with ollama serve, or add an API key."}
            className="w-auto min-w-[220px]"
          />
          {onPatchSession && active ? <TunePopover key={active.id} system={active.system} params={active.params} onPatch={onPatchSession} /> : null}
        </div>
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
          onBranch={onBranch}
          system={active?.system}
          params={active?.params}
          projectId={active?.projectId ?? undefined}
        />
      </div>
    </section>
  );
}
