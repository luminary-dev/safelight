"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
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
  const tw = useTranslations("workspace");
  const toolCapable = models.filter((m) => m.provider !== "ollama" || m.tags?.includes("tools"));
  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Width-capped so the decorative glow never widens the section's scroll extent. */}
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-[520px] w-[min(900px,100%)] -translate-x-1/2 bg-[radial-gradient(closest-side,var(--terracotta-wash),transparent_70%)]" />
      <div className="relative flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <ModelPicker
          options={toolCapable.map((m) => ({ key: chatModelKey(m), label: m.label, tags: m.tags, provider: m.provider }))}
          value={model || null}
          onChange={onModel}
          onAddKey={onOpenKeys}
          placeholder={tw("pickerPlaceholder")}
          emptyHint={ollamaUp ? tw("emptyHintOllamaUp") : tw("emptyHintOllamaDown")}
          className="w-auto min-w-[min(220px,100%)] max-w-full"
        />
        <button type="button" onClick={onCreateSession} className="btn-ink gap-1.5">
          <Plus className="size-4" /> {tw("newSession")}
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
