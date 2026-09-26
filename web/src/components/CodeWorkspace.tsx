"use client";

import { FolderCode, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { JobOutput } from "@/lib/comfy/types";
import type { ChatAttachment, ChatMessage, CodeSession } from "@/lib/session-types";
import { ChatMode, chatModelKey, type ChatModelInfo, type PromptHandoff } from "./ChatMode";
import { ModelPicker } from "./ModelPicker";

/** Code as the main panel: a workspace folder on this machine, and an agent that reads and edits files inside it. */
export function CodeWorkspace({
  active,
  onCreateSession,
  onRoot,
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
  active: CodeSession | null;
  onCreateSession: () => void;
  onRoot: (root: string) => void;
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
  const root = active?.root ?? "";
  const [draft, setDraft] = useState(root);
  // Reset the path field when the session changes (render-phase adjustment, not an effect).
  const [seenSession, setSeenSession] = useState(active?.id);
  if (seenSession !== active?.id) {
    setSeenSession(active?.id);
    setDraft(root);
  }
  const agentBody = useMemo(() => ({ root }), [root]);
  const toolCapable = models.filter((m) => m.provider !== "ollama" || m.tags?.includes("tools"));

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-6 py-4">
        <ModelPicker
          options={toolCapable.map((m) => ({ key: chatModelKey(m), label: m.label, tags: m.tags, provider: m.provider }))}
          value={model || null}
          onChange={onModel}
          onAddKey={onOpenKeys}
          placeholder="Pick a tool-capable model"
          emptyHint={ollamaUp ? "No tool-capable models. Add an API key, or pull a tool-capable Ollama model." : "Ollama is offline. Start it with ollama serve, or add an API key."}
          className="w-auto min-w-[220px]"
        />
        <label className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[12px] bg-paper px-3 py-2.5">
          <FolderCode className="size-4 shrink-0 text-placeholder" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onRoot(draft.trim())}
            onKeyDown={(e) => e.key === "Enter" && onRoot(draft.trim())}
            placeholder="/absolute/path/to/your/project"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-placeholder"
            aria-label="Workspace folder"
          />
        </label>
        <button type="button" onClick={onCreateSession} className="btn-ink gap-1.5">
          <Plus className="size-4" /> New session
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col px-6 pb-5">
        {root ? (
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
            agentEndpoint="/api/code"
            agentBody={agentBody}
            onUseAsInput={onUseAsInput}
            clientId={clientId}
            showControls={false}
            onUpload={onUpload}
          />
        ) : (
          <div className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
            <FolderCode className="size-8 text-placeholder" />
            <h2 className="font-display text-[20px] font-semibold text-ink">Point this session at a folder</h2>
            <p className="text-[14px] leading-relaxed text-ink-muted [text-wrap:pretty]">
              Paste the absolute path of a project above. The model can then list, read, and edit files inside that folder — and nowhere else. It cannot run commands.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
