"use client";

/* eslint-disable @next/next/no-img-element */
import { ArrowRight, ArrowUp, Bot, Check, Copy, FileText, GitBranch, Image as ImageSquare, ImagePlus, Loader2, Mic, Paperclip, Pencil, RefreshCw, SlidersHorizontal, TriangleAlert, Volume2, VolumeX, Wrench, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EXTRACT_EXTENSIONS, isExtractable, MAX_FILE_BYTES } from "@/lib/attachments";
import type { JobOutput } from "@/lib/comfy/types";
import { viewUrl } from "@/lib/safelight-state";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { applyTheme, clearTheme, getActiveThemeName, subscribeActiveTheme } from "@/lib/theme/apply";
import { themeContrast, type ThemeColors } from "@/lib/theme/contrast";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { ModelPicker } from "./ModelPicker";

export interface ChatModelInfo {
  provider: "ollama" | "openai" | "anthropic" | "gemini" | "openrouter" | "groq" | "mistral" | "deepseek" | "xai" | "together" | "cerebras" | "gateway";
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
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
  together: "Together",
  cerebras: "Cerebras",
  gateway: "AI Gateway",
};

/** Stable key for a chat model across providers. */
export function chatModelKey(m: { provider: string; id: string }) {
  return `${m.provider}::${m.id}`;
}

import type { ChatAttachment, ChatFile, ChatMessage as Message, ChatParams, ToolCall } from "@/lib/session-types";

/** What the composer's file input accepts: images (via /api/upload) plus everything /api/chat/extract can read. */
const FILE_ACCEPT = `image/*,${EXTRACT_EXTENSIONS.join(",")}`;

// ---------------- Web Speech (voice input + TTS), feature-detected ----------------

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechWindow = Window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };

function speechCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Feature flags read through useSyncExternalStore so SSR renders without the buttons and hydration stays consistent.
const noopSubscribe = () => () => {};
const canListenSnapshot = () => speechCtor() !== null;
const canSpeakSnapshot = () => typeof window !== "undefined" && "speechSynthesis" in window;
const serverSnapshot = () => false;

// ---------------- Token/cost estimate helpers ----------------

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtCost(c: number): string {
  return c >= 0.1 ? c.toFixed(2) : c.toFixed(4);
}

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

// ---------------- Agent NDJSON stream handling ----------------
// Shared by a live POST stream and a re-attach replay (GET /api/runs/[id]/stream),
// so both paths run through the exact same event-handling switch.

/** One NDJSON line from an agent stream: AgentEvent fields plus the `{type:"run", id}` announcement. */
interface AgentWireEvent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  state?: ToolCall["state"];
  note?: string;
  images?: JobOutput[];
  result?: unknown;
  path?: string;
  tool?: string;
}

/** Reads an NDJSON body line by line into `handle`, flushing a trailing partial line. */
async function pumpNdjson(body: ReadableStream<Uint8Array>, handle: (line: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(handle);
  }
  if (buffer) handle(buffer);
}

/**
 * Applies agent events to the trailing assistant message. Tool cards patch by id
 * and the text accumulator rebuilds deterministically, so replaying a run's event
 * log from seq 0 into a fresh assistant message is idempotent.
 */
function agentEventApplier(ops: {
  patchLast: (fn: (m: Message) => Message) => void;
  onApproval: (a: { id: string; path: string; tool: string }) => void;
  onRunId: (id: string) => void;
}): { handle: (line: string) => void; error: () => string | null } {
  let text = "";
  let error: string | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    let ev: AgentWireEvent;
    try {
      ev = JSON.parse(line) as AgentWireEvent;
    } catch {
      return;
    }
    if (ev.type === "run" && ev.id) {
      ops.onRunId(ev.id);
    } else if (ev.type === "text" && ev.text) {
      text = text ? `${text}\n\n${ev.text}` : ev.text;
      ops.patchLast((m) => ({ ...m, text }));
    } else if (ev.type === "tool" && ev.id && ev.name) {
      const call: ToolCall = { id: ev.id, name: ev.name, args: ev.args ?? {}, state: ev.state ?? "running", note: ev.note, images: ev.images, result: ev.result };
      ops.patchLast((m) => {
        const tools = m.tools ?? [];
        const i = tools.findIndex((t) => t.id === call.id);
        return { ...m, tools: i === -1 ? [...tools, call] : tools.map((t, j) => (j === i ? { ...t, ...call, images: call.images ?? t.images } : t)) };
      });
    } else if (ev.type === "approval" && ev.id && ev.path) {
      ops.onApproval({ id: ev.id, path: ev.path, tool: ev.tool ?? "access" });
    } else if (ev.type === "error" && ev.text) {
      error = ev.text;
    }
  };
  return { handle, error: () => error };
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

/** A fenced code block with hover copy button; used as the markdown `pre` renderer. */
function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <div className="code-block group/code relative">
      <pre ref={preRef} {...props} />
      <button
        type="button"
        aria-label="Copy code"
        onClick={() => {
          void copyToClipboard(preRef.current?.innerText ?? "").then((ok) => {
            setCopied(ok);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1600);
          });
        }}
        className={`absolute right-2 top-2 grid size-7 place-items-center rounded-[8px] border border-line bg-paper-2/90 transition-opacity focus-visible:opacity-100 ${
          copied ? "text-green opacity-100" : "text-ink-muted opacity-0 hover:text-ink group-hover/code:opacity-100"
        }`}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** Assistant reply body rendered as markdown (GFM + syntax highlighting). Safe to re-render on streaming patches. */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: CodeBlock,
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

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
  onApprovePath,
  onUpload,
  onBranch,
  onPatchSession,
  system,
  params,
  projectId,
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
  /** Agent mode: the model may call Safelight tools. */
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
  /** Called when the user allows the agent a path beyond the workspace, so the session can remember it. */
  onApprovePath?: (path: string) => void;
  /** Uploads files into the Safelight input folder and returns references usable by both chat and Image mode. */
  onUpload: (files: File[]) => Promise<ChatAttachment[]>;
  /** Fork the conversation from a message: called with the history truncated after it. Hidden when absent. */
  onBranch?: (messages: Message[]) => void;
  /** Persists per-session tuning (system prompt, sampling params). Chat mode only this round. */
  onPatchSession?: (patch: Partial<{ system: string; params: ChatParams }>) => void;
  /** Per-session system prompt, sent with every request and appended server-side to the default. */
  system?: string;
  /** Per-session sampling parameters, sent with every request. */
  params?: ChatParams;
  /** Project of the active session, forwarded to the agent for scoped runs. */
  projectId?: string;
}) {
  const selected = models.find((m) => chatModelKey(m) === model) ?? null;
  const setMessages = onMessages;
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<ChatAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<ChatFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const noVision = pending.length > 0 && selected && selected.vision === false;

  const attach = useCallback(
    async (files: File[]) => {
      const imgs = files.filter((f) => f.type.startsWith("image/")).slice(0, 6 - pending.length);
      const docs = files.filter((f) => !f.type.startsWith("image/") && isExtractable(f.name)).slice(0, 4 - pendingFiles.length);
      if (!imgs.length && !docs.length) return;
      setUploading(true);
      try {
        if (imgs.length) {
          const added = await onUpload(imgs);
          setPending((p) => [...p, ...added].slice(0, 6));
        }
        for (const doc of docs) {
          if (doc.size > MAX_FILE_BYTES) throw new Error(`${doc.name} is larger than 10 MB.`);
          const form = new FormData();
          form.append("file", doc);
          const res = await fetch("/api/chat/extract", { method: "POST", body: form });
          const body = (await res.json().catch(() => ({}))) as { name?: string; text?: string; truncated?: boolean; error?: string };
          if (!res.ok || typeof body.text !== "string") throw new Error(body.error ?? `Could not read ${doc.name}.`);
          const file: ChatFile = { name: body.name ?? doc.name, text: body.text, truncated: body.truncated || undefined };
          setPendingFiles((p) => [...p.filter((x) => x.name !== file.name), file].slice(0, 4));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [onUpload, pending.length, pendingFiles.length],
  );
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<{ id: string; path: string; tool: string }[]>([]);
  // Agent runs are detached server-side; this view re-attaches after a reload.
  const [reconnected, setReconnected] = useState(false);
  const runIdRef = useRef<string | null>(null);
  // Deterministic per-session client id, so a reloaded page can find its running
  // agent run again (the browser-level clientId alone is shared by every session).
  const runClientId = `${clientId}#${sessionId}`;
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

  /** Patches the last (streaming) message; shared by the live stream and the re-attach replay. */
  const patchLast = useCallback((fn: (m: Message) => Message) => setMessages((list) => list.map((m, i) => (i === list.length - 1 ? fn(m) : m))), [setMessages]);
  const addApproval = useCallback((req: { id: string; path: string; tool: string }) => setApprovals((list) => (list.some((a) => a.id === req.id) ? list : [...list, req])), []);

  // Edit-and-resend: which user message is being edited, and its draft text.
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null);

  // Voice: push-to-talk recognition into the composer, and per-message TTS playback.
  const canListen = useSyncExternalStore(noopSubscribe, canListenSnapshot, serverSnapshot);
  const canSpeak = useSyncExternalStore(noopSubscribe, canSpeakSnapshot, serverSnapshot);
  const [listening, setListening] = useState(false);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const toggleMic = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return; // onend flips the state off
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
    rec.onresult = (e) => {
      const chunk = Array.from({ length: e.results.length - e.resultIndex }, (_, k) => e.results[e.resultIndex + k]?.[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (chunk) setInput((v) => (v.trim() ? `${v.trimEnd()} ${chunk}` : chunk));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }, [listening]);

  const toggleSpeak = useCallback(
    (index: number, text: string) => {
      if (!canSpeak) return;
      window.speechSynthesis.cancel();
      if (speakingIndex === index) {
        setSpeakingIndex(null);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.onend = () => setSpeakingIndex((cur) => (cur === index ? null : cur));
      utterance.onerror = () => setSpeakingIndex((cur) => (cur === index ? null : cur));
      window.speechSynthesis.speak(utterance);
      setSpeakingIndex(index);
    },
    [canSpeak, speakingIndex],
  );

  // Pricing for the composer's cost estimate; null while local/unpriced so nothing shows.
  const [rates, setRates] = useState<{ inPerMtok: number | null; outPerMtok: number | null } | null>(null);
  const provider = selected?.provider;
  const modelId = selected?.id;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve(); // keep every setState in this effect on an async continuation
      if (!provider || !modelId || provider === "ollama") {
        if (!cancelled) setRates(null);
        return;
      }
      try {
        const res = await fetch(`/api/chat/estimate?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(modelId)}`);
        const body = (await res.json().catch(() => ({}))) as { inPerMtok?: number | null; outPerMtok?: number | null };
        if (!cancelled) setRates(res.ok ? { inPerMtok: body.inPerMtok ?? null, outPerMtok: body.outPerMtok ?? null } : null);
      } catch {
        if (!cancelled) setRates(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, modelId]);

  // Rough size of what the next send would carry: full history + composer + attachments + system prompt, chars/4.
  const estTokens = useMemo(() => {
    let chars = input.length + (system?.length ?? 0);
    for (const m of messages) {
      chars += m.text.length;
      for (const f of m.files ?? []) chars += f.text.length;
    }
    for (const f of pendingFiles) chars += f.text.length;
    return Math.ceil(chars / 4);
  }, [messages, input, pendingFiles, system]);
  const estCost = rates?.inPerMtok != null && estTokens > 0 ? (estTokens / 1_000_000) * rates.inPerMtok : null;

  useEffect(() => {
    const t = threadRef.current;
    if (t) t.scrollTop = t.scrollHeight;
  }, [messages, thinking]);

  // The parent remounts this component per session (key=sessionId); abort any stream when that
  // happens. This only closes the view — a detached agent run continues server-side and the
  // re-attach effect picks it up again when the user returns to the session.
  useEffect(() => {
    void sessionId;
    return () => abortRef.current?.abort();
  }, [sessionId]);

  // Stop the mic and any speech playback when leaving the session.
  useEffect(
    () => () => {
      recognitionRef.current?.stop();
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    },
    [],
  );

  /** Sends the composer content, or — when `historyOverride` is given (regenerate) — re-runs that exact history without touching the composer. */
  const send = useCallback(async (historyOverride?: Message[]) => {
    const text = input.trim();
    if (thinking || !selected) return;
    if (!historyOverride && !text && pending.length === 0 && pendingFiles.length === 0) return;
    setError(null);
    const attachments = historyOverride ? [] : pending;
    const attachedFiles = historyOverride ? [] : pendingFiles;
    const history: Message[] = historyOverride ?? [
      ...messages,
      {
        role: "user",
        text: text || (attachments.length ? "Write a prompt for this image." : ""),
        images: attachments.length ? attachments : undefined,
        files: attachedFiles.length ? attachedFiles : undefined,
      },
    ];
    setMessages(() => [...history, { role: "assistant", text: "" }]);
    if (!historyOverride) {
      setInput("");
      setPending([]);
      setPendingFiles([]);
    }
    setThinking(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const hasParams = params && (params.temperature ?? params.topP ?? params.maxTokens) !== undefined;
      const payload = {
        provider: selected?.provider,
        model: selected?.id,
        messages: history.map((m) => ({
          role: m.role,
          content: m.text,
          images: m.images?.map((img) => ({ ref: img.ref })),
          files: m.files?.map((f) => ({ name: f.name, text: f.text })),
        })),
        // Per-session tuning; undefined fields drop out of the JSON body entirely.
        system: system?.trim() || undefined,
        params: hasParams ? params : undefined,
        projectId: projectId || undefined,
      };
      if (agent) {
        const res = await fetch(agentEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, preferredModel, clientId: runClientId, ...agentBody }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Agent failed (${res.status})`);
        }
        const applier = agentEventApplier({
          patchLast,
          onApproval: addApproval,
          onRunId: (id) => {
            runIdRef.current = id;
          },
        });
        await pumpNdjson(res.body, applier.handle);
        const agentError = applier.error();
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
      setApprovals([]);
      abortRef.current = null;
      runIdRef.current = null;
    }
  }, [input, pending, pendingFiles, thinking, selected, messages, setMessages, agent, preferredModel, runClientId, agentEndpoint, agentBody, system, params, projectId, patchLast, addApproval]);

  /** Drops the last assistant message and re-sends the user message before it through the normal send path. */
  const regenerate = useCallback(() => {
    const base = messages.slice(0, -1);
    if (thinking || messages[messages.length - 1]?.role !== "assistant" || base[base.length - 1]?.role !== "user") return;
    void send(base);
  }, [messages, thinking, send]);

  /** Edit-and-resend: replaces the edited user message, drops everything after it, and re-runs. */
  const resendEdited = useCallback(() => {
    if (!editing || thinking) return;
    const text = editing.text.trim();
    const original = messages[editing.index];
    if (!text || original?.role !== "user") return;
    const history = [...messages.slice(0, editing.index), { ...original, text }];
    setEditing(null);
    void send(history);
  }, [editing, thinking, messages, send]);

  // Agent runs are detached: the stop endpoint is what actually cancels the run;
  // aborting the fetch just closes this view of it right away.
  const stop = () => {
    const id = runIdRef.current;
    if (id) void fetch(`/api/runs/${encodeURIComponent(id)}/stop`, { method: "POST" }).catch(() => undefined);
    abortRef.current?.abort();
  };

  // Re-attach on mount (per session): if a detached run for this session is still
  // going (the page reloaded mid-run), rebuild the trailing assistant message from
  // the persisted event log — idempotent by construction — and continue live.
  const reattachTried = useRef(false);
  useEffect(() => {
    if (reattachTried.current) return;
    reattachTried.current = true;
    void (async () => {
      let attached = false;
      try {
        const res = await fetch(`/api/runs?activeFor=${encodeURIComponent(runClientId)}`);
        const body = (await res.json().catch(() => ({}))) as { run?: { id: string } | null };
        const live = res.ok ? body.run : null;
        if (!live || abortRef.current) return; // no live run, or the user already started a new send
        attached = true;
        const controller = new AbortController();
        abortRef.current = controller;
        runIdRef.current = live.id;
        setThinking(true);
        setReconnected(true);
        setError(null);
        // Drop the trailing in-progress assistant message (a reload leaves it half
        // written) and rebuild it entirely from the replayed event log.
        setMessages((list) => {
          const trimmed = list.length > 0 && list[list.length - 1].role === "assistant" ? list.slice(0, -1) : list;
          return [...trimmed, { role: "assistant", text: "" }];
        });
        const applier = agentEventApplier({
          patchLast,
          onApproval: addApproval,
          onRunId: (id) => {
            runIdRef.current = id;
          },
        });
        const stream = await fetch(`/api/runs/${encodeURIComponent(live.id)}/stream?from=0`, { signal: controller.signal });
        if (!stream.ok || !stream.body) throw new Error(`Could not re-attach to the running agent (${stream.status}).`);
        await pumpNdjson(stream.body, applier.handle);
        const agentError = applier.error();
        if (agentError) setError(agentError);
        patchLast((m) => ({ ...m, text: m.text || (m.tools?.length ? "" : agentError ? `Could not complete: ${agentError}` : "(empty reply)") }));
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError(err instanceof Error ? err.message : "Could not re-attach to the running agent.");
      } finally {
        if (attached) {
          setThinking(false);
          setReconnected(false);
          setApprovals([]);
          abortRef.current = null;
          runIdRef.current = null;
        }
      }
    })();
  }, [runClientId, setMessages, patchLast, addApproval]);

  const empty = messages.length === 0 && !thinking;
  const canRegenerate = !thinking && messages.length > 1 && messages[messages.length - 1]?.role === "assistant" && messages[messages.length - 2]?.role === "user";

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
            <div className="flex min-w-0 max-w-[82%] flex-col gap-2">
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
              {msg.files && msg.files.length > 0 ? (
                <div className={`flex flex-col gap-1.5 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                  {msg.files.map((f) => (
                    <details key={f.name} className="max-w-full rounded-[12px] border border-line bg-paper-2 px-3 py-1.5">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-mono text-[11px] text-ink-muted">
                        <FileText className="size-3 shrink-0" /> {f.name}
                        {f.truncated ? <span className="text-faint">· clipped</span> : null}
                      </summary>
                      <pre className="mt-1.5 max-h-52 overflow-auto whitespace-pre-wrap rounded-[8px] bg-pill/40 p-2 font-mono text-[11px] leading-relaxed text-ink-muted">{f.text}</pre>
                    </details>
                  ))}
                </div>
              ) : null}
              {editing && editing.index === i && msg.role === "user" ? (
                <div className="w-full min-w-[min(480px,72vw)] rounded-[14px] bg-green-wash p-1.5">
                  <textarea
                    value={editing.text}
                    onChange={(e) => setEditing({ index: i, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        resendEdited();
                      } else if (e.key === "Escape") {
                        setEditing(null);
                      }
                    }}
                    rows={1}
                    autoFocus
                    className="max-h-60 w-full resize-none border-0 bg-transparent px-2.5 py-2 font-sans text-[15px] leading-normal text-ink"
                    style={{ fieldSizing: "content" } as React.CSSProperties}
                  />
                  <div className="flex items-center justify-end gap-2 px-1 pb-1">
                    <span className="mr-auto font-mono text-[10.5px] text-faint">Replaces this message and everything after it</span>
                    <button type="button" onClick={() => setEditing(null)} className="btn-quiet h-7 rounded-full px-3 text-[12px]">
                      Cancel
                    </button>
                    <button type="button" onClick={resendEdited} disabled={!editing.text.trim() || thinking} className="btn-primary h-7 rounded-full px-3 text-[12px]">
                      Send
                    </button>
                  </div>
                </div>
              ) : msg.text || msg.role === "assistant" ? (
                <div
                  className={`min-w-0 text-[15px] leading-[1.6] text-ink [text-wrap:pretty] ${
                    msg.role === "user" ? "whitespace-pre-wrap rounded-[14px] bg-green-wash px-4 py-2.5" : ""
                  }`}
                >
                  {msg.role === "assistant" && msg.text ? (
                    <Markdown text={msg.text} />
                  ) : (
                    msg.text || (thinking && i === messages.length - 1 && !msg.tools?.length ? <span className="pulse text-ink-muted">…</span> : "")
                  )}
                </div>
              ) : null}
              {msg.role === "user" && !thinking && editing?.index !== i ? (
                <div className="flex flex-wrap items-center justify-end gap-4 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => setEditing({ index: i, text: msg.text })}
                    className="inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-faint transition-colors hover:text-ink"
                  >
                    <Pencil size={13} /> Edit
                  </button>
                  {onBranch ? (
                    <button
                      type="button"
                      onClick={() => onBranch(messages.slice(0, i + 1))}
                      className="inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-faint transition-colors hover:text-ink"
                    >
                      <GitBranch size={13} /> Branch from here
                    </button>
                  ) : null}
                </div>
              ) : null}
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
                  {i === messages.length - 1 && canRegenerate ? (
                    <button
                      type="button"
                      onClick={regenerate}
                      className="inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-faint transition-colors hover:text-ink"
                    >
                      <RefreshCw size={13} /> Regenerate
                    </button>
                  ) : null}
                  {onBranch && !thinking ? (
                    <button
                      type="button"
                      onClick={() => onBranch(messages.slice(0, i + 1))}
                      className="inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-faint transition-colors hover:text-ink"
                    >
                      <GitBranch size={13} /> Branch from here
                    </button>
                  ) : null}
                  {canSpeak ? (
                    <button
                      type="button"
                      onClick={() => toggleSpeak(i, msg.text)}
                      aria-pressed={speakingIndex === i}
                      className={`inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors ${
                        speakingIndex === i ? "text-terracotta" : "text-faint hover:text-ink"
                      }`}
                    >
                      {speakingIndex === i ? (
                        <>
                          <VolumeX size={13} /> Stop
                        </>
                      ) : (
                        <>
                          <Volume2 size={13} /> Read aloud
                        </>
                      )}
                    </button>
                  ) : null}
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
        {reconnected ? <div className="font-mono text-xs text-ink-muted">Reconnected to the running agent</div> : null}
        {thinking ? <div className="font-mono text-xs text-ink-muted">Thinking…</div> : null}
        {error ? <p className="font-mono text-xs text-danger">{error}</p> : null}
      </div>

      <div className="pb-2 pt-2">
        {noVision ? <p className="mb-2 font-mono text-[11px] text-terracotta">{selected?.label} cannot see images. Pick a vision model (tagged “vision”) or a cloud model.</p> : null}
        {approvals.map((a) => (
          <div key={a.id} className="develop mb-2.5 flex flex-wrap items-center gap-3 rounded-[16px] border border-terracotta/30 bg-terracotta-wash px-4 py-3">
            <span className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink">
              {a.tool === "run_command" ? (
                <>The agent asks to run a command:</>
              ) : a.tool === "mcp_tool" ? (
                <>The agent asks to use an MCP tool that can change things:</>
              ) : (
                <>
                  The agent wants <span className="font-medium">{a.tool.replace(/_/g, " ")}</span> access outside the workspace:
                </>
              )}
              <span className="mt-0.5 block truncate font-mono text-[12px] text-ink-muted" title={a.path}>{a.path}</span>
            </span>
            <span className="flex shrink-0 gap-2">
              <button
                type="button"
                className="btn-primary h-8 rounded-full px-4 text-[13px]"
                onClick={() => {
                  void fetch("/api/code/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: a.id, allow: true }) });
                  onApprovePath?.(a.path);
                  setApprovals((list) => list.filter((x) => x.id !== a.id));
                }}
              >
                Allow
              </button>
              <button
                type="button"
                className="btn-quiet h-8 rounded-full px-4 text-[13px]"
                onClick={() => {
                  void fetch("/api/code/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: a.id, allow: false }) });
                  setApprovals((list) => list.filter((x) => x.id !== a.id));
                }}
              >
                Deny
              </button>
            </span>
          </div>
        ))}
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
          {pendingFiles.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-3.5 pt-3">
              {pendingFiles.map((f) => (
                <span key={f.name} className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1 font-mono text-[11px] text-ink-muted">
                  <FileText className="size-3 shrink-0" />
                  <span className="truncate" title={f.name}>{f.name}</span>
                  {f.truncated ? <span className="shrink-0 text-faint">· clipped</span> : null}
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setPendingFiles((p) => p.filter((x) => x.name !== f.name))} className="grid size-4 shrink-0 place-items-center rounded-full text-ink-muted hover:text-ink">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2 py-2.5 pl-2.5 pr-2.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label="Attach a file" disabled={uploading || (pending.length >= 6 && pendingFiles.length >= 4)} onClick={() => fileRef.current?.click()} className="mb-1 grid size-9 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-pill hover:text-ink disabled:opacity-50">
                  {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="rounded-[8px] bg-ink px-2 py-1 font-mono text-[11px] text-paper">
                Attach a photo or a file — PDF, text, CSV, code (or drop / paste)
              </TooltipContent>
            </Tooltip>
            <input ref={fileRef} type="file" accept={FILE_ACCEPT} multiple hidden onChange={(e) => void attach(Array.from(e.target.files ?? []))} />
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
          {canListen ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={listening ? "Stop listening" : "Dictate"}
                  aria-pressed={listening}
                  onClick={toggleMic}
                  className={`mb-1 grid size-9 shrink-0 place-items-center rounded-full transition-colors ${
                    listening ? "bg-terracotta-wash text-terracotta" : "text-ink-muted hover:bg-pill hover:text-ink"
                  }`}
                >
                  <Mic className={`size-4 ${listening ? "animate-pulse" : ""}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="rounded-[8px] bg-ink px-2 py-1 font-mono text-[11px] text-paper">
                {listening ? "Listening — click to stop" : "Push to talk: dictate into the composer"}
              </TooltipContent>
            </Tooltip>
          ) : null}
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
                <Bot className="size-3.5" /> Safelight tools
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[260px] rounded-[8px] bg-ink px-2.5 py-1.5 font-sans text-[12px] leading-snug text-paper">
              Lets the model use Safelight tools: generate and edit images, list models, browse recent renders. Needs a tool-capable model.
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
              disabled={(!input.trim() && pending.length === 0 && pendingFiles.length === 0) || !selected || Boolean(noVision)}
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
                Lets the model use Safelight tools: generate and edit images, list models, browse recent renders. Needs a tool-capable model.
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
            {onPatchSession && !agentLocked ? <TunePopover system={system} params={params} onPatch={onPatchSession} /> : null}
          </div>
          <span className="flex items-center gap-3">
            {estTokens > 0 ? (
              <span
                title="Rough estimate — characters ÷ 4 across the conversation, attachments, and draft. Cost uses the input rate for the selected cloud model."
                className="font-mono text-[11px] text-faint"
              >
                ~{fmtTokens(estTokens)} tok{estCost != null ? ` · ~$${fmtCost(estCost)}` : ""}
              </span>
            ) : null}
            <span className="hidden font-mono text-[11px] text-faint lg:inline">Enter to send · Shift + Enter for a new line</span>
          </span>
        </div>
      </div>
    </main>
  );
}

/**
 * Per-session tuning: a system prompt appended to the default, plus sampling
 * parameters. Rendered next to the model picker in chat mode only; commits via
 * onPatch when the popover closes or a field blurs.
 */
export function TunePopover({ system, params, onPatch }: { system?: string; params?: ChatParams; onPatch: (patch: Partial<{ system: string; params: ChatParams }>) => void }) {
  const [open, setOpen] = useState(false);
  const [sys, setSys] = useState(system ?? "");
  const [temperature, setTemperature] = useState(params?.temperature?.toString() ?? "");
  const [topP, setTopP] = useState(params?.topP?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(params?.maxTokens?.toString() ?? "");
  const tuned = Boolean(system?.trim()) || (params && (params.temperature ?? params.topP ?? params.maxTokens) !== undefined);

  const commit = useCallback(() => {
    const num = (raw: string, int = false): number | undefined => {
      const v = int ? parseInt(raw, 10) : parseFloat(raw);
      return Number.isFinite(v) ? v : undefined;
    };
    const next: ChatParams = { temperature: num(temperature), topP: num(topP), maxTokens: num(maxTokens, true) };
    const hasParams = (next.temperature ?? next.topP ?? next.maxTokens) !== undefined;
    onPatch({ system: sys.trim() || undefined, params: hasParams ? next : undefined });
  }, [sys, temperature, topP, maxTokens, onPatch]);

  const numberField = (label: string, hint: string, value: string, set: (v: string) => void, props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint">{label}</span>
      <input
        type="number"
        value={value}
        placeholder={hint}
        onChange={(e) => set(e.target.value)}
        onBlur={commit}
        className="h-8 w-full rounded-[10px] border border-line bg-paper-2 px-2.5 font-mono text-[12.5px] text-ink placeholder:text-placeholder"
        {...props}
      />
    </label>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) commit();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Chat settings: system prompt and sampling"
              className={`grid size-8 shrink-0 place-items-center rounded-full border border-line transition-colors ${
                tuned ? "bg-terracotta-wash text-terracotta" : "bg-paper-2 text-ink-muted hover:bg-pill hover:text-ink"
              }`}
            >
              <SlidersHorizontal className="size-3.5" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="rounded-[8px] bg-ink px-2 py-1 font-mono text-[11px] text-paper">
          System prompt &amp; sampling for this chat
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" sideOffset={8} className="w-[340px] rounded-[16px] p-3.5">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint">System prompt — added to the default</span>
            <textarea
              value={sys}
              onChange={(e) => setSys(e.target.value)}
              onBlur={commit}
              rows={4}
              placeholder="Extra instructions for this chat…"
              className="max-h-48 w-full resize-none rounded-[10px] border border-line bg-paper-2 px-2.5 py-2 text-[13px] leading-normal text-ink placeholder:text-placeholder"
              style={{ fieldSizing: "content" } as React.CSSProperties}
            />
          </label>
          <div className="flex gap-2">
            {numberField("Temp", "0–2", temperature, setTemperature, { min: 0, max: 2, step: 0.1 })}
            {numberField("Top-p", "0–1", topP, setTopP, { min: 0, max: 1, step: 0.05 })}
            {numberField("Max tok", "auto", maxTokens, setMaxTokens, { min: 1, step: 1 })}
          </div>
          <p className="m-0 font-mono text-[10.5px] leading-relaxed text-faint">Saved with this chat. Blank fields use the provider defaults.</p>
        </div>
      </PopoverContent>
    </Popover>
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
      {call.name === "save_theme" && call.state === "done" ? <ThemeSwatch result={call.result} /> : null}
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

interface SavedTheme {
  name: string;
  description: string;
  colors: Record<string, string>;
  fonts: { display: string; body: string; mono?: string };
  contrast?: { textOnBg: number; textOnSurface: number; accentTextOnAccent: number };
}

/** A saved theme rendered as a small live preview: swatch row plus a card in the theme's own colors. */
function ThemeSwatch({ result }: { result: unknown }) {
  const theme = (result as { theme?: SavedTheme } | undefined)?.theme;
  const activeName = useSyncExternalStore(subscribeActiveTheme, getActiveThemeName, () => null);
  const [busy, setBusy] = useState(false);
  if (!theme?.colors) return null;
  const c = theme.colors;
  const isActive = activeName === theme.name;
  // New saves carry server-computed ratios; older themes get them recomputed here.
  let contrast = theme.contrast ?? null;
  if (!contrast) {
    try {
      contrast = themeContrast(c as unknown as ThemeColors);
    } catch {
      contrast = null;
    }
  }
  const applyThis = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/themes/${encodeURIComponent(theme.name)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "apply" }) });
      if (res.ok) applyTheme(theme.name, c as unknown as ThemeColors);
    } finally {
      setBusy(false);
    }
  };
  const resetThis = async () => {
    setBusy(true);
    try {
      await fetch(`/api/themes/${encodeURIComponent(theme.name)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear" }) }).catch(() => undefined);
      clearTheme();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-line p-3">
      <div className="flex flex-col gap-2.5 rounded-[14px] border border-line p-3.5" style={{ background: c.bg, color: c.text }}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-display text-[15px] font-semibold">{theme.name}</span>
          <span className="font-mono text-[10.5px]" style={{ color: c.muted }}>
            {theme.fonts.display} · {theme.fonts.body}
          </span>
        </div>
        {theme.description ? (
          <p className="m-0 text-[12.5px] leading-snug" style={{ color: c.muted }}>
            {theme.description}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="rounded-[8px] px-3 py-1.5 text-[12px] font-semibold" style={{ background: c.accent, color: c.accentText }}>
            Button
          </span>
          <span className="rounded-[8px] border px-3 py-1.5 text-[12px]" style={{ borderColor: c.muted, background: c.surface }}>
            Card
          </span>
          <span className="ml-auto flex gap-1">
            {Object.entries(c).map(([k, v]) => (
              <span key={k} title={`${k} ${v}`} className="size-4 rounded-full border border-black/10" style={{ background: v }} />
            ))}
          </span>
        </div>
      </div>
      {contrast ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10.5px] text-faint">
          <span title="WCAG contrast, text on bg">text/bg {contrast.textOnBg.toFixed(2)}:1</span>
          <span title="WCAG contrast, text on surface">text/surface {contrast.textOnSurface.toFixed(2)}:1</span>
          <span title="WCAG contrast, accentText on accent">accent {contrast.accentTextOnAccent.toFixed(2)}:1</span>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isActive ? (
          <button type="button" onClick={resetThis} disabled={busy} className="btn-quiet h-7 px-3 text-[12px]">
            Reset
          </button>
        ) : (
          <button type="button" onClick={applyThis} disabled={busy} className="btn-quiet h-7 px-3 text-[12px]">
            Apply
          </button>
        )}
        <span className="font-mono text-[10.5px] text-faint">Export:</span>
        {(["css", "tailwind", "tokens"] as const).map((format) => (
          <a key={format} href={`/api/themes/${encodeURIComponent(theme.name)}?format=${format}`} download className="font-mono text-[10.5px] text-terracotta underline underline-offset-2 hover:text-terracotta-deep">
            {format}
          </a>
        ))}
        <span className="ml-auto font-mono text-[10.5px] text-faint">{isActive ? "Applied — replaces both light and dark until cleared" : "Apply replaces both light and dark themes until cleared"}</span>
      </div>
    </div>
  );
}
