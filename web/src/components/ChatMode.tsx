"use client";

/* eslint-disable @next/next/no-img-element */
import { ArrowRight, ArrowUp, Bot, Check, Copy, Image as ImageSquare, ImagePlus, Loader2, Paperclip, Pencil, TriangleAlert, Wrench, X } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { JobOutput } from "@/lib/comfy/types";
import { viewUrl } from "@/lib/studio-state";
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelPicker } from "./ModelPicker";

export interface ChatModelInfo {
  provider: "ollama" | "openai" | "anthropic" | "gemini";
  id: string;
  label: string;
  tags: string[];
  vision?: boolean;
}

export const PROVIDER_LABEL: Record<ChatModelInfo["provider"], string> = {
  ollama: "Local (Ollama)",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

/** Stable key for a chat model across providers. */
export function chatModelKey(m: { provider: string; id: string }) {
  return `${m.provider}::${m.id}`;
}

import type { ChatAttachment, ChatMessage as Message, ToolCall } from "@/lib/session-types";

export interface PromptHandoff {
  prompt: string;
  negativePrompt?: string;
  /** Reference images to attach in Image mode (From image). */
  images?: ChatAttachment[];
}

/** Splits a reply into prompt and negative prompt when it follows the Prompt: / Negative prompt: structure. */
export function parsePromptReply(text: string): { prompt: string; negativePrompt?: string } {
  const m = text.match(/prompt:\s*([\s\S]*?)(?:\n\s*negative prompt:\s*([\s\S]*?))?(?:\n\s*notes?:[\s\S]*)?$/i);
  if (!m) return { prompt: text.trim() };
  const prompt = m[1].trim().replace(/^["“]|["”]$/g, "");
  const negativePrompt = m[2]?.trim().replace(/^["“]|["”]$/g, "") || undefined;
  return prompt ? { prompt, negativePrompt } : { prompt: text.trim() };
}

/** Clipboard write with a hidden-textarea fallback for contexts where the async API is unavailable. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ChatMode({
  models,
  ollamaUp,
  model,
  onModel,
  onUseAsPrompt,
  onOpenKeys,
  messages,
  onMessages,
  sessionId,
  agent,
  onAgent,
  onUseAsInput,
  preferredModel,
  clientId,
  showControls = true,
  agentEndpoint = "/api/agent",
  agentBody,
  agentLocked = false,
  onUpload,
}: {
  models: ChatModelInfo[];
  ollamaUp: boolean;
  /** chatModelKey of the selected model */
  model: string;
  onModel: (key: string) => void;
  onUseAsPrompt: (handoff: PromptHandoff) => void;
  onOpenKeys: () => void;
  messages: Message[];
  onMessages: (update: (prev: Message[]) => Message[]) => void;
  /** Changes when the user switches chats; used to cancel a stream that belongs to another session. */
  sessionId: string;
  /** Agent mode: the model may call studio tools. */
  agent: boolean;
  onAgent: (on: boolean) => void;
  onUseAsInput: (o: JobOutput) => void;
  /** "folder:name" of the image model selected in Image mode, so the agent renders with it by default. */
  preferredModel?: string;
  clientId: string;
  /** When false, the model picker and agent toggle are rendered by the parent instead. */
  showControls?: boolean;
  /** Where agent runs are posted; the code workspace points this at /api/code. */
  agentEndpoint?: string;
  /** Extra fields merged into the agent request body, e.g. the code workspace root. */
  agentBody?: Record<string, unknown>;
  /** Hides the agent toggle chip for workspaces where the agent is always on. */
  agentLocked?: boolean;
  /** Uploads files into the studio input folder and returns references usable by both chat and Image mode. */
  onUpload: (files: File[]) => Promise<ChatAttachment[]>;
}) {
  const selected = models.find((m) => chatModelKey(m) === model) ?? null;
  const setMessages = onMessages;
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const noVision = pending.length > 0 && selected && selected.vision === false;

  const attach = useCallback(
    async (files: File[]) => {
      const imgs = files.filter((f) => f.type.startsWith("image/")).slice(0, 6 - pending.length);
      if (!imgs.length) return;
      setUploading(true);
      try {
        const added = await onUpload(imgs);
        setPending((p) => [...p, ...added].slice(0, 6));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [onUpload, pending.length],
  );
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyMessage = useCallback(async (text: string, index: number) => {
    const ok = await copyToClipboard(text);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopiedIndex(ok ? index : null);
    if (!ok) setError("Could not copy to the clipboard.");
    copyTimer.current = setTimeout(() => setCopiedIndex(null), 1600);
  }, []);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = threadRef.current;
    if (t) t.scrollTop = t.scrollHeight;
  }, [messages, thinking]);

  // The parent remounts this component per session (key=sessionId); abort any stream when that happens.
  useEffect(() => {
    void sessionId;
    return () => abortRef.current?.abort();
  }, [sessionId]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && pending.length === 0) || thinking || !selected) return;
    setError(null);
    const attachments = pending;
    const history: Message[] = [...messages, { role: "user", text: text || "Write a prompt for this image.", images: attachments.length ? attachments : undefined }];
    setMessages(() => [...history, { role: "assistant", text: "" }]);
    setInput("");
    setPending([]);
    setThinking(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const patchLast = (fn: (m: Message) => Message) => setMessages((list) => list.map((m, i) => (i === list.length - 1 ? fn(m) : m)));
    try {
      const payload = {
        provider: selected?.provider,
        model: selected?.id,
        messages: history.map((m) => ({ role: m.role, content: m.text, images: m.images?.map((img) => ({ ref: img.ref })) })),
      };
      if (agent) {
        const res = await fetch(agentEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, preferredModel, clientId, ...agentBody }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Agent failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let text = "";
        let agentError: string | null = null;
        const handle = (line: string) => {
          if (!line.trim()) return;
          let ev: { type: string; text?: string; id?: string; name?: string; args?: Record<string, unknown>; state?: ToolCall["state"]; note?: string; images?: JobOutput[] };
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (ev.type === "text" && ev.text) {
            text = text ? `${text}\n\n${ev.text}` : ev.text;
            patchLast((m) => ({ ...m, text }));
          } else if (ev.type === "tool" && ev.id && ev.name) {
            const call: ToolCall = { id: ev.id, name: ev.name, args: ev.args ?? {}, state: ev.state ?? "running", note: ev.note, images: ev.images };
            patchLast((m) => {
              const tools = m.tools ?? [];
              const i = tools.findIndex((t) => t.id === call.id);
              return { ...m, tools: i === -1 ? [...tools, call] : tools.map((t, j) => (j === i ? { ...t, ...call, images: call.images ?? t.images } : t)) };
            });
          } else if (ev.type === "error" && ev.text) {
            agentError = ev.text;
          }
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          lines.forEach(handle);
        }
        if (buffer) handle(buffer);
        if (agentError) setError(agentError);
        patchLast((m) => ({ ...m, text: m.text || (m.tools?.length ? "" : agentError ? "" : "(empty reply)") }));
        if (agentError) patchLast((m) => (m.text || m.tools?.length ? m : { ...m, text: `Could not complete: ${agentError}` }));
      } else {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Chat failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          const snapshot = acc;
          patchLast((m) => ({ ...m, text: snapshot }));
        }
        patchLast((m) => ({ ...m, text: acc.trim() || "(empty reply)" }));
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(err instanceof Error ? err.message : "Chat failed");
      setMessages((list) => (list[list.length - 1]?.text === "" ? list.slice(0, -1) : list));
    } finally {
      setThinking(false);
      abortRef.current = null;
    }
  }, [input, pending, thinking, selected, messages, setMessages, agent, preferredModel, clientId, agentEndpoint, agentBody]);

  const stop = () => abortRef.current?.abort();
  const empty = messages.length === 0 && !thinking;

  return (
    <main className="mx-auto grid h-full w-full max-w-[860px] min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] px-0">
      <div ref={threadRef} className="flex flex-col gap-[22px] overflow-y-auto py-2 pr-1">
        {empty ? (
          <div className="my-auto flex flex-col items-center gap-7 text-center">
            <span
              aria-hidden
              className="float size-[88px] rounded-full shadow-[0_24px_60px_var(--terracotta-wash)]"
              style={{ background: "radial-gradient(circle at 34% 28%, #ffffff 0%, #ecfccb 18%, #a3e635 52%, #34d399 88%)" }}
            />
            <h1 className="m-0 font-display text-[clamp(30px,4vw,44px)] font-bold leading-[1.15] tracking-[-0.02em] text-ink [text-wrap:balance]">
              {new Date().getHours() < 12 ? "Good morning." : new Date().getHours() < 18 ? "Good afternoon." : "Good evening."}
              <br />
              What are we <span className="text-terracotta">making today?</span>
            </h1>
            {models.length === 0 ? (
              <p className="m-0 text-sm leading-relaxed text-ink-muted [text-wrap:pretty]">
                {ollamaUp ? (
                  <>
                    No local chat models yet. Pull one with <code className="code">ollama pull llama3.2</code>, or{" "}
                  </>
                ) : (
                  <>
                    Ollama isn&apos;t running. Start it with <code className="code">ollama serve</code>, or{" "}
                  </>
                )}
                <button type="button" onClick={onOpenKeys} className="text-terracotta underline underline-offset-[3px] hover:text-terracotta-deep">
                  add an API key
                </button>{" "}
                to use OpenAI, Anthropic, or Gemini.
              </p>
            ) : null}
          </div>
        ) : null}
        {messages.map((msg, i) => (
          <div key={i} className={`develop group flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className="flex max-w-[82%] flex-col gap-2">
              {msg.tools && msg.tools.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {msg.tools.map((t) => (
                    <ToolCard key={t.id} call={t} onUseAsInput={onUseAsInput} />
                  ))}
                </div>
              ) : null}
              {msg.images && msg.images.length > 0 ? (
                <div className="flex flex-wrap justify-end gap-1.5">
                  {msg.images.map((img) => (
                    <a key={img.ref} href={viewUrl({ filename: img.filename, subfolder: img.subfolder, type: "input" })} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-[10px] border border-line">
                      <img src={viewUrl({ filename: img.filename, subfolder: img.subfolder, type: "input" })} alt={img.filename} className="h-[120px] w-auto max-w-[180px] object-cover" />
                    </a>
                  ))}
                </div>
              ) : null}
              <div
                className={`whitespace-pre-wrap text-[15px] leading-[1.6] text-ink [text-wrap:pretty] ${
                  msg.role === "user" ? "rounded-[14px] bg-green-wash px-4 py-2.5" : ""
                }`}
              >
                {msg.text || (thinking && i === messages.length - 1 && !msg.tools?.length ? <span className="pulse text-ink-muted">…</span> : "")}
              </div>
              {msg.role === "assistant" && msg.text && !(thinking && i === messages.length - 1) ? (
                <div className="flex flex-wrap items-center gap-4 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => void copyMessage(msg.text, i)}
                    aria-live="polite"
                    className={`inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors ${
                      copiedIndex === i ? "text-green" : "text-faint hover:text-ink"
                    }`}
                  >
                    {copiedIndex === i ? (
                      <>
                        <Check size={13} /> Copied
                      </>
                    ) : (
                      <>
                        <Copy size={13} /> Copy
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onUseAsPrompt(parsePromptReply(msg.text))}
                    className="inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-faint transition-colors hover:text-terracotta"
                  >
                    <ImageSquare size={13} /> Use as image prompt <ArrowRight size={12} />
                  </button>
                  {(() => {
                    const ref = [...messages.slice(0, i)].reverse().find((m) => m.role === "user" && m.images?.length)?.images;
                    return ref ? (
                      <button
                        type="button"
                        onClick={() => onUseAsPrompt({ ...parsePromptReply(msg.text), images: ref })}
                        className="inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-faint transition-colors hover:text-terracotta"
                      >
                        <ImagePlus size={13} /> Use with the photo as reference <ArrowRight size={12} />
                      </button>
                    ) : null;
                  })()}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {thinking ? <div className="font-mono text-xs text-ink-muted">Thinking…</div> : null}
        {error ? <p className="font-mono text-xs text-danger">{error}</p> : null}
      </div>

      <div className="pb-2 pt-2">
        {noVision ? <p className="mb-2 font-mono text-[11px] text-terracotta">{selected?.label} cannot see images. Pick a vision model (tagged “vision”) or a cloud model.</p> : null}
        <div
          className="rounded-[22px] bg-paper-2 p-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_1px_var(--line)]"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void attach(Array.from(e.dataTransfer.files));
          }}
        >
          {pending.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-3.5 pt-3">
              {pending.map((img) => (
                <div key={img.ref} className="group/att relative h-16 w-16 overflow-hidden rounded-[10px] border border-line">
                  <img src={viewUrl({ filename: img.filename, subfolder: img.subfolder, type: "input" })} alt={img.filename} className="h-full w-full object-cover" />
                  <button type="button" aria-label="Remove attachment" onClick={() => setPending((p) => p.filter((x) => x.ref !== img.ref))} className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-paper-2/95 text-ink opacity-0 transition-opacity group-hover/att:opacity-100 focus-visible:opacity-100">
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2 py-2.5 pl-2.5 pr-2.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="Attach an image" disabled={uploading || pending.length >= 6} onClick={() => fileRef.current?.click()} className="mb-1 grid size-9 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-pill hover:text-ink disabled:opacity-50">
                  {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="rounded-[8px] bg-ink px-2 py-1 font-mono text-[11px] text-paper">
                Attach a reference photo (or drop / paste one)
              </TooltipContent>
            </Tooltip>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void attach(Array.from(e.target.files ?? []))} />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (files.length) {
                e.preventDefault();
                void attach(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Ask anything, or describe an image to make…"
            className="max-h-40 flex-1 resize-none border-0 bg-transparent py-2 font-sans text-[15px] leading-normal text-ink"
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />
          {agentLocked ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={agent}
                onClick={() => onAgent(!agent)}
                className={`mb-1 hidden h-[34px] shrink-0 items-center gap-1.5 rounded-[10px] px-3 font-display text-[13px] font-medium transition-colors sm:inline-flex ${
                  agent ? "bg-terracotta-wash text-terracotta" : "text-ink-muted shadow-[0_0_0_1px_var(--line)] hover:text-ink"
                }`}
              >
                <Bot className="size-3.5" /> Studio tools
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[260px] rounded-[8px] bg-ink px-2.5 py-1.5 font-sans text-[12px] leading-snug text-paper">
              Lets the model use studio tools: generate and edit images, list models, browse recent renders. Needs a tool-capable model.
            </TooltipContent>
          </Tooltip>
          )}
          <span className="mb-2.5 hidden font-mono text-[11px] text-placeholder sm:inline">⏎ send</span>
          {thinking ? (
            <button type="button" onClick={stop} className="btn-ink mb-1 h-[38px] rounded-[12px] px-4">
              Stop
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              onClick={() => void send()}
              disabled={(!input.trim() && pending.length === 0) || !selected || Boolean(noVision)}
              className="btn-primary mb-1 grid size-[38px] shrink-0 place-items-center rounded-[12px] p-0 text-[17px]"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
          </div>
        </div>
        <div className={`mt-2.5 flex flex-wrap items-center justify-between gap-2 ${showControls ? "" : "justify-end"}`}>
          <div className={`flex min-w-0 flex-wrap items-center gap-2 ${showControls ? "" : "hidden"}`}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  pressed={agent}
                  onPressedChange={onAgent}
                  aria-label="Agent mode"
                  className={`h-8 gap-1.5 rounded-full border px-3 font-display text-[13px] font-medium ${
                    agent ? "border-terracotta bg-terracotta text-paper-2 hover:bg-terracotta-deep hover:text-paper-2 data-[state=on]:bg-terracotta data-[state=on]:text-paper-2" : "border-line bg-paper-2 text-ink-muted hover:bg-pill hover:text-ink"
                  }`}
                >
                  <Bot className="size-3.5" /> Agent
                </Toggle>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[260px] rounded-[8px] bg-ink px-2.5 py-1.5 font-sans text-[12px] leading-snug text-paper">
                Lets the model use studio tools: generate and edit images, list models, browse recent renders. Needs a tool-capable model.
              </TooltipContent>
            </Tooltip>
            <ModelPicker
              size="compact"
              side="top"
              align="start"
              value={model || null}
              onChange={onModel}
              onAddKey={onOpenKeys}
              placeholder="Pick a chat model"
              emptyHint={ollamaUp ? "No chat models yet." : "Ollama is offline."}
              options={models.map((m) => ({ key: chatModelKey(m), label: m.label, tags: m.tags, provider: m.provider }))}
            />
          </div>
          <span className="hidden font-mono text-[11px] text-faint lg:inline">Enter to send · Shift + Enter for a new line</span>
        </div>
      </div>
    </main>
  );
}

const TOOL_LABEL: Record<string, string> = {
  generate_image: "Generating image",
  edit_image: "Editing image",
  list_models: "Checking models",
  list_recent_images: "Looking at recent renders",
};

function ToolCard({ call, onUseAsInput }: { call: ToolCall; onUseAsInput: (o: JobOutput) => void }) {
  const label = TOOL_LABEL[call.name] ?? call.name;
  const doneLabel = call.name === "generate_image" ? "Generated" : call.name === "edit_image" ? "Edited" : label;
  const summary =
    typeof call.args.prompt === "string" ? call.args.prompt : typeof call.args.instruction === "string" ? call.args.instruction : typeof call.args.image === "string" ? call.args.image : "";
  const images = call.images ?? [];
  return (
    <div className="card overflow-hidden text-[13px]">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ${call.state === "error" ? "bg-danger-wash text-danger" : call.state === "done" ? "bg-green-wash text-green" : "bg-pill text-ink-muted"}`}>
          {call.state === "running" ? <Loader2 className="size-3.5 animate-spin" /> : call.state === "error" ? <TriangleAlert className="size-3.5" /> : call.name === "list_models" || call.name === "list_recent_images" ? <Wrench className="size-3.5" /> : <Check className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1 leading-snug">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-display font-medium text-ink">{call.state === "done" ? doneLabel : label}</span>
            {call.note ? <span className={`font-mono text-[11px] ${call.state === "error" ? "text-danger" : "text-faint"}`}>{call.note}</span> : null}
          </div>
          {summary ? <p className="mt-0.5 line-clamp-3 text-ink-muted">{summary}</p> : null}
        </div>
      </div>
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-line bg-pill/30 p-2.5">
          {images.map((o) => (
            <div key={`${o.subfolder}/${o.filename}`} className="group/img relative">
              <a href={viewUrl(o)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-[10px] border border-line bg-paper-2">
                <img src={viewUrl(o)} alt={o.filename} className="h-[160px] w-auto max-w-[240px] object-cover" loading="lazy" />
              </a>
              <button
                type="button"
                onClick={() => onUseAsInput(o)}
                className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-full border border-line bg-paper-2/95 px-2 py-1 font-mono text-[10px] text-ink opacity-0 shadow-[var(--shadow-hairline)] transition-opacity group-hover/img:opacity-100 focus-visible:opacity-100"
              >
                <Pencil className="size-3" /> Edit in Image
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
