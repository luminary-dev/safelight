"use client";

import { FolderCode, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { JobOutput } from "@/lib/comfy/types";
import type { ChatAttachment, ChatMessage, CodeSession } from "@/lib/session-types";
import { ChatMode, chatModelKey, type ChatModelInfo, type PromptHandoff } from "./ChatMode";
import { FolderBrowser } from "./FolderBrowser";
import { ModelPicker } from "./ModelPicker";

/** Code as the main panel: a workspace folder on this machine, and an agent that reads and edits files inside it. */
export function CodeWorkspace({
  active,
  onCreateSession,
  onRoot,
  onApprovePath,
  onRemoveApprovedPath,
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
  onApprovePath: (path: string) => void;
  onRemoveApprovedPath: (path: string) => void;
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
  const approvedPaths = useMemo(() => active?.approvedPaths ?? [], [active?.approvedPaths]);
  const agentBody = useMemo(() => ({ root, approvedPaths }), [root, approvedPaths]);
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
        <FolderBrowser
          start={root || undefined}
          onPick={(p) => {
            setDraft(p);
            onRoot(p);
          }}
        />
        <button type="button" onClick={onCreateSession} className="btn-ink gap-1.5">
          <Plus className="size-4" /> New session
        </button>
      </div>
      {approvedPaths.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 px-6 pb-3">
          <span className="text-[12px] font-medium text-faint">Also allowed:</span>
          {approvedPaths.map((p) => (
            <span key={p} className="inline-flex max-w-[360px] items-center gap-1.5 rounded-full bg-terracotta-wash py-1 pl-2.5 pr-1.5 font-mono text-[11px] text-terracotta">
              <span className="truncate" title={p}>{p}</span>
              <button type="button" aria-label={`Revoke access to ${p}`} onClick={() => onRemoveApprovedPath(p)} className="grid size-4 shrink-0 place-items-center rounded-full hover:bg-paper-2/60">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
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
            onApprovePath={onApprovePath}
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
              Paste the absolute path of a project above. The model can then search, read, and edit files inside that folder — and nowhere else without your approval. Commands run only after you approve each one.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
