"use client";

import { BookOpen, ChevronDown, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ControlType, ImageCapabilities, ModelCatalog, ModelEntry } from "@/lib/comfy/types";
import { SIZE_PRESETS, SIZE_SCALES, randomSeed, scaledSize } from "@/lib/presets";
import { addSweepGroup, toRequest, type Settings } from "@/lib/safelight-state";
import { ScrollStrip } from "@/components/ui/scroll-strip";
import { cn } from "@/lib/utils";
import { InputImages } from "./ImageControls";
import { ModelPicker, type PickerOption } from "./ModelPicker";
import { Select, Slider, Toggle } from "./ui";

const SEGMENT_ON = "h-8 rounded-[9px]! px-3 font-display text-[13px] font-medium text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:font-semibold data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]";

const CONTROL_PATCH_FILE = "Z-Image-Turbo-Fun-Controlnet-Union.safetensors";

function browserClientId(): string {
  try {
    return localStorage.getItem("safelight.clientId.v1") ?? "safelight";
  } catch {
    return "safelight";
  }
}

/**
 * ControlNet guidance for image edits, collapsed by default. The uploaded reference image
 * becomes the control map (canny is traced automatically; depth/pose expect a ready-made map),
 * gated on the control patch the connected ComfyUI actually has.
 */
function ControlNetSection({ modelName, controlType, controlStrength, onChange }: { modelName: string; controlType: "" | ControlType; controlStrength: number; onChange: (patch: { controlType?: "" | ControlType; controlStrength?: number }) => void }) {
  const [open, setOpen] = useState(false);
  const [caps, setCaps] = useState<ImageCapabilities | null>(null);
  useEffect(() => {
    if (!open || caps) return;
    let stale = false;
    fetch("/api/generate")
      .then((r) => (r.ok ? (r.json() as Promise<ImageCapabilities>) : null))
      .then((c) => !stale && c && setCaps(c))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [open, caps]);

  const isZ = /z[-_]?image/i.test(modelName);
  const fitting = (caps?.controlnet.patches ?? []).filter((p) => (isZ ? /z[-_]?image/i.test(p) : /qwen/i.test(p) && !/z[-_]?image/i.test(p)));
  const reason = !caps
    ? "Checking what ComfyUI has installed…"
    : !caps.online
      ? "ComfyUI is offline."
      : !caps.controlnet.node
        ? "The local ComfyUI is missing the QwenImageDiffsynthControlnet node — update it to a build that ships ControlNet patches."
        : fitting.length === 0
          ? `No control patch fits this model. Download "${CONTROL_PATCH_FILE}" into ComfyUI's "model_patches" folder (the model manager can fetch it) and pick a Z-Image-Turbo model.`
          : null;

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 self-start text-[12px] font-medium text-faint hover:text-ink">
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} /> ControlNet
        {controlType ? <span className="rounded-full bg-pill px-2 py-0.5 font-mono text-[10px] text-ink">{controlType}</span> : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-2 rounded-[12px] bg-paper p-3">
          {reason ? <p className="text-[12px] leading-relaxed text-ink-muted [text-wrap:pretty]">{reason}</p> : null}
          <div className="form-row">
            <span className="form-label">Guide by</span>
            <Select
              value={controlType}
              onChange={(v) => onChange({ controlType: v as "" | ControlType })}
              placeholder="Off"
              options={[
                { value: "", label: "Off" },
                { value: "canny", label: "Edges (canny)" },
                { value: "depth", label: "Depth map" },
                { value: "pose", label: "Pose map" },
              ]}
              ariaLabel="ControlNet type"
              className={reason ? "pointer-events-none opacity-50" : ""}
            />
          </div>
          {controlType && !reason ? (
            <div className="form-row">
              <span className="form-label">Strength</span>
              <Slider value={controlStrength} min={0} max={2} step={0.05} onChange={(v) => onChange({ controlStrength: v })} />
            </div>
          ) : null}
          {controlType && !reason ? (
            <p className="text-[11.5px] leading-relaxed text-faint [text-wrap:pretty]">
              {controlType === "canny"
                ? "The first input image is traced into edges that guide the render."
                : `The first input image must already be a ${controlType} map — the ${controlType === "depth" ? "Depth Estimation" : "Pose Map"} blueprints make one.`}
              {" Using patch "}
              <code className="code">{fitting[0]}</code>.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface SavedPromptDto {
  id: string;
  title: string;
  text: string;
  negative: string;
  tags: string[];
}

/** Auto title for a saved prompt: its first few words. */
function autoPromptTitle(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(" ");
  return (words.length > 48 ? `${words.slice(0, 48).trimEnd()}…` : words) || "Untitled prompt";
}

/**
 * The prompt library popover: save the current prompt, insert a saved one
 * (wildcards like `{a|b}` and `__title__` expand at render time), or delete.
 */
function PromptsPopover({ prompt, negativePrompt, onApply }: { prompt: string; negativePrompt: string; onApply: (patch: { prompt?: string; negativePrompt?: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SavedPromptDto[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const t = setTimeout(
      async () => {
        try {
          const res = await fetch(`/api/prompts${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`, { signal: controller.signal });
          if (!res.ok) return;
          const data = (await res.json()) as { prompts?: SavedPromptDto[] };
          setItems(data.prompts ?? []);
        } catch {
          /* aborted or offline */
        }
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [open, query, reloadKey]);

  const save = async () => {
    if (!prompt.trim()) {
      setNote("Nothing to save — the prompt is empty.");
      return;
    }
    try {
      const res = await fetch("/api/prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: autoPromptTitle(prompt), text: prompt, negative: negativePrompt }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Saving failed.");
      setNote("Saved.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Saving failed.");
    }
  };

  const remove = async (id: string) => {
    try {
      await fetch(`/api/prompts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      /* the reload shows the truth either way */
    }
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="btn-quiet h-7 px-2 text-[12px]" title="Saved prompts">
        <BookOpen className="size-3.5" /> Prompts
      </button>
      {open ? (
        <div className="absolute right-0 z-40 mt-1.5 flex w-[min(300px,calc(100vw-48px))] flex-col gap-2 rounded-[14px] border border-line bg-paper-2 p-3 shadow-[var(--shadow-raised)]">
          <div className="flex items-center gap-2">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by title or tag" className="field h-8 flex-1 text-[12px]" aria-label="Search saved prompts" />
            <button type="button" className="btn-quiet h-8 shrink-0 px-2 text-[12px]" onClick={() => void save()} title="Save the current prompt">
              Save
            </button>
          </div>
          {note ? <p className="text-[11.5px] text-faint">{note}</p> : null}
          <div className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
            {items === null ? (
              <p className="p-1 text-[12px] text-faint">Loading…</p>
            ) : items.length === 0 ? (
              <p className="p-1 text-[12px] leading-relaxed text-faint [text-wrap:pretty]">
                Nothing saved yet. Save prompts here, then reuse them — <code className="code">{"{a|b}"}</code> picks one at render time and <code className="code">__title__</code> inserts another saved prompt.
              </p>
            ) : (
              items.map((p) => (
                <div key={p.id} className="group flex items-start gap-1.5 rounded-[10px] p-1.5 hover:bg-pill">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    title={p.text}
                    onClick={() => {
                      onApply({ prompt: p.text, ...(p.negative ? { negativePrompt: p.negative } : {}) });
                      setOpen(false);
                    }}
                  >
                    <span className="block truncate text-[12.5px] font-medium text-ink">{p.title}</span>
                    <span className="block truncate text-[11px] text-faint">{p.text}</span>
                  </button>
                  <button type="button" className="btn-quiet h-6 shrink-0 px-1 opacity-0 group-hover:opacity-100" aria-label={`Delete "${p.title}"`} onClick={() => void remove(p.id)}>
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type SweepKind = "" | "seed" | "cfg" | "steps";

interface SweepQueuedPoint {
  id: string;
  seed: number;
  value: number;
  label: string;
}

/** The left settings column in Image mode: prompt, shape, count, model, and the create button. */
export function Composer({
  catalog,
  online,
  settings,
  onChange,
  onSelectModel,
  onUpload,
  uploading,
  canGenerate,
  submitting,
  error,
  onGenerate,
  onOpenKeys,
}: {
  catalog: ModelCatalog | null;
  online: boolean;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onSelectModel: (m: ModelEntry) => void;
  onUpload: (files: File[]) => Promise<void>;
  uploading: boolean;
  canGenerate: boolean;
  submitting: boolean;
  error: string | null;
  onGenerate: () => void;
  onOpenKeys: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const isQwen = settings.model?.family === "qwen-image";
  const isCloud = settings.model?.folder === "cloud";
  const isEdit = settings.mode === "img2img";
  const modelKey = (m: ModelEntry) => `${m.folder}:${m.name}`;
  const options: PickerOption[] = (catalog?.models ?? []).map((m) => ({
    key: modelKey(m),
    label: m.label,
    tags: m.tags,
    provider: m.folder === "cloud" ? (m.provider ?? "openai") : "local",
    hint: m.folder === "cloud" ? (m.edit ? "text + image edits" : "text only") : m.name.split("/").pop(),
  }));
  const needsBackend = !isCloud && !online && Boolean(settings.model);
  const sizeLocked = isEdit && isQwen && settings.matchInputSize;
  const applyPreset = (presetId: string, scaleId: string) => {
    const preset = SIZE_PRESETS.find((p) => p.id === presetId) ?? SIZE_PRESETS[0];
    const scale = SIZE_SCALES.find((s) => s.id === scaleId) ?? SIZE_SCALES[1];
    onChange({ presetId, scaleId, ...scaledSize(preset, scale.factor) });
  };
  const pickerDefaultOpen = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("picker") === "1";
  const mp = ((settings.width * settings.height) / 1e6).toFixed(settings.width * settings.height >= 1e6 ? 0 : 1);

  // ---------- prompt enhance (with undo) ----------
  const [undoPrompt, setUndoPrompt] = useState<string | null>(null);
  const [enhanceBusy, setEnhanceBusy] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const enhance = async () => {
    const original = settings.prompt;
    if (!original.trim() || enhanceBusy) return;
    setEnhanceBusy(true);
    setEnhanceError(null);
    try {
      const res = await fetch("/api/prompts/enhance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: original, clientId: browserClientId() }),
      });
      const data = (await res.json()) as { text?: string; error?: string };
      if (!res.ok || !data.text) throw new Error(data.error ?? "Enhance failed.");
      setUndoPrompt(original);
      onChange({ prompt: data.text });
    } catch (err) {
      setEnhanceError(err instanceof Error ? err.message : "Enhance failed.");
    } finally {
      setEnhanceBusy(false);
    }
  };

  // ---------- swap guard banner state (§O); the probe effect lives below ----------
  const [swapWarning, setSwapWarning] = useState<string | null>(null);
  const [warningDismissedFor, setWarningDismissedFor] = useState<string | null>(null);

  // ---------- sweep (seed / parameter grid) ----------
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepKind, setSweepKind] = useState<SweepKind>("");
  const [sweepCount, setSweepCount] = useState(4);
  const [sweepValues, setSweepValues] = useState("");
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepError, setSweepError] = useState<string | null>(null);
  const parsedSweepValues = sweepValues
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .slice(0, 6);
  const sweepActive = sweepKind !== "" && settings.mode === "txt2img" && !isCloud;
  const sweepReady = !sweepActive || sweepKind === "seed" || parsedSweepValues.length >= 2;
  const sweepPointCount = sweepKind === "seed" ? sweepCount : parsedSweepValues.length;

  const runSweep = async () => {
    if (!settings.model || sweepKind === "") return;
    setSweepBusy(true);
    setSweepError(null);
    try {
      const seed = settings.lockSeed ? settings.seed : randomSeed();
      const sweep = sweepKind === "seed" ? { kind: "seed", count: sweepCount } : { kind: sweepKind, values: parsedSweepValues };
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...toRequest(settings, seed), clientId: browserClientId(), sweep }),
      });
      const data = (await res.json()) as { group?: string; points?: SweepQueuedPoint[]; warning?: string; error?: string };
      if (!res.ok || !data.group || !data.points) throw new Error(data.error ?? "Failed to queue the sweep.");
      addSweepGroup({
        group: data.group,
        kind: sweepKind,
        prompt: settings.prompt,
        width: settings.width,
        height: settings.height,
        startedAt: Date.now(),
        cells: data.points.map((p) => ({ ...p, state: "queued" as const, outputs: [] })),
      });
      if (data.warning) setSwapWarning(data.warning);
    } catch (err) {
      setSweepError(err instanceof Error ? err.message : "Failed to queue the sweep.");
    } finally {
      setSweepBusy(false);
    }
  };

  // ---------- swap guard probe (§O): a debounced preflight estimate on size/model changes ----------
  const modelName = settings.model?.name;
  const modelFolder = settings.model?.folder;
  const teKey = settings.textEncoders.join("|");
  useEffect(() => {
    const controller = new AbortController();
    const local = Boolean(modelName) && modelFolder !== "cloud" && online;
    const t = setTimeout(
      async () => {
        if (!local) {
          setSwapWarning(null);
          return;
        }
        try {
          const res = await fetch("/api/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              preflight: true,
              model: { name: modelName, folder: modelFolder },
              textEncoders: teKey ? teKey.split("|") : [],
              vae: settings.vae || undefined,
              width: settings.width,
              height: settings.height,
            }),
            signal: controller.signal,
          });
          if (!res.ok) return;
          const data = (await res.json()) as { warning?: string | null };
          setSwapWarning(data.warning ?? null);
        } catch {
          /* aborted or offline: keep the last verdict */
        }
      },
      local ? 500 : 0,
    );
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [modelName, modelFolder, teKey, settings.vae, settings.width, settings.height, online]);

  const generate = () => {
    if (sweepActive) {
      if (sweepReady && !sweepBusy) void runSweep();
      return;
    }
    onGenerate();
  };

  return (
    // At compact (lg, 1024–1279) the column runs tighter paddings so the fixed
    // grid track in Safelight.tsx squeezes the Stage less; xl restores them.
    <section className="flex min-h-0 flex-col gap-4 overflow-y-auto border-b border-line p-5 pb-0 lg:gap-3 lg:border-b-0 lg:border-r lg:p-4 lg:pb-0 xl:gap-4 xl:p-5 xl:pb-0">
      <ToggleGroup type="single" value={settings.mode} onValueChange={(v) => v && onChange({ mode: v as Settings["mode"] })} spacing={0} className="grid w-full grid-cols-2 rounded-[12px] bg-paper p-1" aria-label="Generation mode">
        <ToggleGroupItem value="txt2img" className={SEGMENT_ON}>
          From words
        </ToggleGroupItem>
        <ToggleGroupItem value="img2img" className={SEGMENT_ON}>
          From a photo
        </ToggleGroupItem>
      </ToggleGroup>

      {swapWarning && warningDismissedFor !== swapWarning ? (
        <div className="flex items-start gap-2 rounded-[12px] border border-terracotta/50 bg-paper px-3 py-2">
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink [text-wrap:pretty]">
            <span className="font-medium">Memory:</span> {swapWarning}
          </p>
          <button type="button" className="btn-quiet h-6 shrink-0 px-1.5" aria-label="Dismiss memory warning" onClick={() => setWarningDismissedFor(swapWarning)}>
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {/* No min-h-0 here: inside the scrolling column this block must never
          shrink below its content, or the heading and textarea paint over the
          sections below it (measured at 1024 with More settings open). */}
      <div className="flex flex-1 flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="min-w-0 font-display text-[19px] font-bold tracking-[-0.01em] text-ink">What should we make?</h2>
          <div className="flex shrink-0 items-center gap-1.5">
            <PromptsPopover prompt={settings.prompt} negativePrompt={settings.negativePrompt} onApply={onChange} />
            <button type="button" className="btn-quiet h-7 px-2 text-[12px]" onClick={() => void enhance()} disabled={enhanceBusy || !settings.prompt.trim()} title="Expand the prompt with concrete visual detail">
              <Sparkles className="size-3.5" /> {enhanceBusy ? "Enhancing…" : "Enhance"}
            </button>
          </div>
        </div>
        {undoPrompt !== null || enhanceError ? (
          <div className="flex items-center gap-2">
            {undoPrompt !== null ? (
              <button
                type="button"
                className="btn-quiet h-6 px-2 text-[11.5px]"
                onClick={() => {
                  onChange({ prompt: undoPrompt });
                  setUndoPrompt(null);
                }}
              >
                <Undo2 className="size-3" /> Undo enhance
              </button>
            ) : null}
            {enhanceError ? <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-danger">{enhanceError}</p> : null}
          </div>
        ) : null}
        {isEdit ? (
          <InputImages
            images={settings.images}
            max={isQwen ? 10 : isCloud ? (settings.model?.edit ? 4 : 0) : 1}
            uploading={uploading}
            onUpload={onUpload}
            onRemove={(ref) => onChange({ images: settings.images.filter((i) => i.ref !== ref) })}
            hint={
              isQwen
                ? "First image is edited, the rest are references. Mention them as <image1>, <image2>."
                : isCloud
                  ? settings.model?.edit
                    ? "The provider edits the first image using the others as references."
                    : "This cloud model does not accept input images."
                  : "Resized to the output size and re-noised by the strength below."
            }
          />
        ) : null}
        <textarea
          value={settings.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (canGenerate) generate();
            }
          }}
          rows={4}
          placeholder={isEdit ? "Describe the change" : "Describe what you want to see"}
          className="min-h-[110px] w-full flex-1 resize-none rounded-[16px] bg-paper p-3.5 text-[15px] leading-[1.55] text-ink outline-none placeholder:text-placeholder focus:shadow-[var(--focus-ring)]"
        />
      </div>

      {!sizeLocked ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-faint">Shape</span>
            {!isCloud ? (
              <span className="font-mono text-[11px] text-placeholder">
                {settings.width} × {settings.height}
              </span>
            ) : null}
          </div>
          {/* One deliberate scroll row instead of wrapping/clipping pills (§2, §5.16).
              min-h-11 below lg keeps the focusable strip at the 44px touch minimum. */}
          <ScrollStrip label="Aspect ratio and size presets" className="min-h-11 items-center py-0.5 lg:min-h-0">
            {/* The toggle groups own ArrowLeft/Right for roving focus; keep those
                key presses from also scrolling the strip underneath them. */}
            <div
              className="flex w-max items-center gap-2"
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
              }}
            >
              <ToggleGroup type="single" value={settings.presetId} onValueChange={(v) => v && applyPreset(v, settings.scaleId)} className="flex-nowrap gap-1" aria-label="Aspect ratio">
                {SIZE_PRESETS.map((p) => (
                  <ToggleGroupItem key={p.id} value={p.id} title={p.label} className="h-7 shrink-0 rounded-[9px]! border border-line bg-transparent px-2 font-mono text-[11px] text-ink-muted hover:bg-pill hover:text-ink data-[state=on]:border-ink data-[state=on]:bg-ink data-[state=on]:text-paper-2">
                    {p.ratio}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {!isCloud ? (
                <ToggleGroup type="single" value={settings.scaleId} onValueChange={(v) => v && applyPreset(settings.presetId, v)} spacing={0} className="shrink-0 rounded-[10px] bg-paper p-[3px]" aria-label="Output size">
                  {SIZE_SCALES.map((sc) => (
                    <ToggleGroupItem key={sc.id} value={sc.id} className="h-6 rounded-[7px]! px-2.5 font-mono text-[10.5px] text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]">
                      {sc.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              ) : null}
            </div>
          </ScrollStrip>
        </div>
      ) : null}

      {isEdit && isQwen ? <Toggle checked={settings.matchInputSize} onChange={(v) => onChange({ matchInputSize: v })} label="Match the input image" /> : null}

      {isEdit && !isCloud ? <ControlNetSection modelName={settings.model?.name ?? ""} controlType={settings.controlType} controlStrength={settings.controlStrength} onChange={onChange} /> : null}

      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-faint">How many</span>
        <ToggleGroup type="single" value={String(settings.batch)} onValueChange={(v) => v && onChange({ batch: Number(v) })} spacing={0} className="rounded-[12px] bg-paper p-1" aria-label="Batch size">
          {(isCloud ? [1, 2, 4] : [1, 2, 4, 8]).map((n) => (
            <ToggleGroupItem key={n} value={String(n)} className="h-7 w-9 rounded-[9px]! font-display text-[14px] font-medium text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:font-semibold data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]">
              {n}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {!isCloud && settings.mode === "txt2img" ? (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => setSweepOpen((o) => !o)} className="inline-flex items-center gap-1.5 self-start text-[12px] font-medium text-faint hover:text-ink">
            <ChevronDown className={cn("size-3 transition-transform", sweepOpen && "rotate-180")} /> Sweep
            {sweepKind ? <span className="rounded-full bg-pill px-2 py-0.5 font-mono text-[10px] text-ink">{sweepKind}</span> : null}
          </button>
          {sweepOpen ? (
            <div className="flex flex-col gap-2 rounded-[12px] bg-paper p-3">
              <div className="form-row">
                <span className="form-label">Sweep</span>
                <Select
                  value={sweepKind}
                  onChange={(v) => setSweepKind(v as SweepKind)}
                  placeholder="Off"
                  options={[
                    { value: "", label: "Off" },
                    { value: "seed", label: "Seed variations" },
                    { value: "cfg", label: "CFG values" },
                    { value: "steps", label: "Step counts" },
                  ]}
                  ariaLabel="Sweep type"
                />
              </div>
              {sweepKind === "seed" ? (
                <div className="form-row">
                  <span className="form-label">Count</span>
                  <Slider value={sweepCount} min={2} max={9} step={1} onChange={(v) => setSweepCount(Math.round(v))} />
                </div>
              ) : null}
              {sweepKind === "cfg" || sweepKind === "steps" ? (
                <div className="form-row">
                  <span className="form-label">Values</span>
                  <input value={sweepValues} onChange={(e) => setSweepValues(e.target.value)} placeholder={sweepKind === "cfg" ? "1, 2.5, 4" : "10, 20, 30"} className="field h-9 font-mono text-xs" aria-label="Sweep values (comma-separated)" />
                </div>
              ) : null}
              {sweepKind ? (
                <p className="text-[11.5px] leading-relaxed text-faint [text-wrap:pretty]">
                  {sweepKind === "seed"
                    ? `Renders ${sweepCount} variations of these settings with seeds derived from the ${settings.lockSeed ? "locked" : "base"} seed. The results appear as a grid on the Stage.`
                    : !sweepReady
                      ? "Enter 2–6 comma-separated values."
                      : `Renders one image per ${sweepKind} value (${parsedSweepValues.join(", ")}), same seed. The results appear as a grid on the Stage.`}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2.5 rounded-[16px] bg-paper p-3.5">
        {catalog ? (
          <ModelPicker
            options={options}
            value={settings.model ? modelKey(settings.model) : null}
            onChange={(key) => {
              const m = catalog.models.find((x) => modelKey(x) === key);
              if (m) onSelectModel(m);
            }}
            onAddKey={onOpenKeys}
            defaultOpen={pickerDefaultOpen}
            placeholder="Choose a model"
            emptyHint={online ? "No image models found in ~/models." : "ComfyUI is offline and no cloud key is set."}
            className="min-w-0 w-full"
          />
        ) : (
          <span className="pulse h-[52px] w-full rounded-[14px] bg-pill" />
        )}
        {!isCloud ? (
          <div className="flex items-center justify-between font-mono text-[12px] text-faint">
            <span>
              {settings.steps} steps · {mp} MP
            </span>
            <span>{settings.lockSeed ? `seed ${settings.seed}` : "random seed"}</span>
          </div>
        ) : null}
      </div>

      {!isCloud ? (
        <button type="button" onClick={() => setAdvanced((a) => !a)} className="inline-flex items-center gap-1.5 self-start text-[12px] font-medium text-faint hover:text-ink">
          <ChevronDown className={cn("size-3 transition-transform", advanced && "rotate-180")} /> {advanced ? "Fewer settings" : "More settings"}
        </button>
      ) : null}

      {advanced && !isCloud && catalog ? (
        <div className="flex flex-col">
          <div className="form-row">
            <span className="form-label">Steps</span>
            <Slider value={settings.steps} min={1} max={80} step={1} onChange={(v) => onChange({ steps: v })} />
          </div>
          <div className="form-row">
            <span className="form-label">Seed</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={settings.seed}
                disabled={!settings.lockSeed}
                onChange={(e) => onChange({ seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                className="field h-9 flex-1 font-mono text-xs disabled:opacity-60"
                aria-label="Seed"
              />
              <Button type="button" variant="outline" size="sm" onClick={() => onChange({ lockSeed: !settings.lockSeed })} className="h-9 rounded-[10px] border-line bg-paper-2 font-mono text-[11px] text-ink hover:bg-pill">
                {settings.lockSeed ? "Locked" : "Random"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => onChange({ seed: randomSeed(), lockSeed: true })} className="h-9 rounded-[10px] border-line bg-paper-2 font-mono text-[11px] text-ink hover:bg-pill">
                New
              </Button>
            </div>
          </div>
          <div className="form-row">
            <span className="form-label">CFG</span>
            <Slider value={settings.cfg} min={0} max={20} step={0.5} onChange={(v) => onChange({ cfg: v })} />
          </div>
          {isEdit && !isQwen ? (
            <div className="form-row">
              <span className="form-label">Strength</span>
              <Slider value={settings.denoise} min={0} max={1} step={0.05} onChange={(v) => onChange({ denoise: v })} />
            </div>
          ) : null}
          {isEdit && isQwen ? (
            <div className="form-row">
              <span className="form-label">Ref res</span>
              <Slider value={settings.refResolution} min={0} max={2048} step={32} onChange={(v) => onChange({ refResolution: v })} />
            </div>
          ) : null}
          <div className="form-row items-start">
            <span className="form-label pt-2">Negative</span>
            <textarea value={settings.negativePrompt} onChange={(e) => onChange({ negativePrompt: e.target.value })} rows={2} placeholder={isQwen && settings.cfg <= 1 ? "Ignored at CFG 1" : "What to avoid"} className="field resize-y text-[13px]" />
          </div>
          <div className="form-row">
            <span className="form-label">Sampler</span>
            <div className="grid grid-cols-2 gap-2">
              <Select value={settings.sampler} onChange={(v) => onChange({ sampler: v })} options={catalog.samplers.map((x) => ({ value: x, label: x }))} ariaLabel="Sampler" />
              <Select value={settings.scheduler} onChange={(v) => onChange({ scheduler: v })} options={catalog.schedulers.map((x) => ({ value: x, label: x }))} ariaLabel="Scheduler" />
            </div>
          </div>
          {settings.model && settings.model.folder !== "checkpoints" ? (
            <div className="form-row">
              <span className="form-label">Encoder</span>
              <Select
                value={settings.textEncoders[0] ?? ""}
                onChange={(v) => onChange({ textEncoders: [v, ...settings.textEncoders.slice(1)] })}
                placeholder="Select a text encoder"
                options={[{ value: "", label: "" }, ...catalog.textEncoders.map((x) => ({ value: x, label: x }))]}
              />
            </div>
          ) : null}
          {settings.model?.family === "flux" ? (
            <div className="form-row">
              <span className="form-label">CLIP-L</span>
              <Select
                value={settings.textEncoders[1] ?? ""}
                onChange={(v) => onChange({ textEncoders: [settings.textEncoders[0] ?? "", v] })}
                placeholder="Select a CLIP-L encoder"
                options={[{ value: "", label: "" }, ...catalog.textEncoders.map((x) => ({ value: x, label: x }))]}
              />
            </div>
          ) : null}
          <div className="form-row">
            <span className="form-label">VAE</span>
            <Select
              value={settings.vae}
              onChange={(v) => onChange({ vae: v })}
              placeholder={settings.model?.folder === "checkpoints" ? "Use the checkpoint's VAE" : "Select a VAE"}
              options={[{ value: "", label: "" }, ...catalog.vaes.map((x) => ({ value: x, label: x }))]}
            />
          </div>
          {catalog.loras.length > 0 ? (
            <div className="form-row items-start">
              <span className="form-label pt-2">LoRA</span>
              <div className="flex flex-col gap-2">
                <Select value={settings.lora} onChange={(v) => onChange({ lora: v })} placeholder="None" options={[{ value: "", label: "" }, ...catalog.loras.map((x) => ({ value: x, label: x }))]} />
                {settings.lora ? <Slider value={settings.loraStrength} min={-1} max={2} step={0.05} onChange={(v) => onChange({ loraStrength: v })} /> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {needsBackend ? (
        <p className="rounded-[12px] border border-danger/30 bg-danger-wash px-3 py-2 text-[13px] leading-relaxed text-ink">
          ComfyUI is offline. Local models need it (<code className="code">pnpm comfy</code>), or pick a cloud model.
        </p>
      ) : null}
      {error ? <p className="break-words font-mono text-[11px] leading-relaxed text-danger">{error}</p> : null}
      {sweepError ? <p className="break-words font-mono text-[11px] leading-relaxed text-danger">{sweepError}</p> : null}

      {/* Sticky within the scrolling column from lg up (below lg the whole page
          scrolls and sticky would only dangle past the fold): "More settings"
          can grow the form, but Generate stays reachable at every width (§5.16).
          The section keeps pb-0 and the footer carries the bottom padding
          itself, so the opaque footer reaches the column's bottom edge and
          scrolled content cannot peek out beneath it. */}
      <div className="z-10 mt-auto flex items-center gap-3 bg-paper-2 pb-5 pt-2 lg:sticky lg:bottom-0 lg:pb-4 xl:pb-5">
        <button id="generate-button" type="button" disabled={!canGenerate || sweepBusy || (sweepActive && !sweepReady)} onClick={generate} className="btn-primary h-[52px] min-w-0 flex-1 rounded-[14px] text-[15px]">
          {submitting || sweepBusy ? "Queueing" : sweepActive ? `Create ${sweepPointCount} variations` : settings.batch > 1 ? `Create ${settings.batch} images` : "Create image"}
          <span className="font-mono text-[12px] font-medium opacity-70">⌘⏎</span>
        </button>
      </div>
    </section>
  );
}
