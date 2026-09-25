"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ModelCatalog, ModelEntry } from "@/lib/comfy/types";
import { SIZE_PRESETS, SIZE_SCALES, randomSeed, scaledSize } from "@/lib/presets";
import type { Settings } from "@/lib/studio-state";
import { cn } from "@/lib/utils";
import { InputImages } from "./ImageControls";
import { ModelPicker, type PickerOption } from "./ModelPicker";
import { Select, Slider, Toggle } from "./ui";

const SEGMENT_ON = "h-8 rounded-[9px]! px-3 font-display text-[13px] font-medium text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:font-semibold data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]";

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

  return (
    <section className="flex min-h-0 flex-col gap-4 overflow-y-auto border-b border-line p-5 lg:border-b-0 lg:border-r">
      <ToggleGroup type="single" value={settings.mode} onValueChange={(v) => v && onChange({ mode: v as Settings["mode"] })} spacing={0} className="grid w-full grid-cols-2 rounded-[12px] bg-paper p-1" aria-label="Generation mode">
        <ToggleGroupItem value="txt2img" className={SEGMENT_ON}>
          From words
        </ToggleGroupItem>
        <ToggleGroupItem value="img2img" className={SEGMENT_ON}>
          From a photo
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="flex flex-col gap-2.5">
        <h2 className="font-display text-[19px] font-bold tracking-[-0.01em] text-ink">What should we make?</h2>
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
              if (canGenerate) onGenerate();
            }
          }}
          rows={4}
          placeholder={isEdit ? "Describe the change" : "Describe what you want to see"}
          className="w-full resize-none rounded-[16px] bg-paper p-3.5 text-[15px] leading-[1.55] text-ink outline-none placeholder:text-placeholder focus:shadow-[var(--focus-ring)]"
          style={{ fieldSizing: "content", minHeight: 110 } as React.CSSProperties}
        />
      </div>

      {!sizeLocked ? (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-faint">Shape</span>
          <ToggleGroup type="single" value={settings.presetId} onValueChange={(v) => v && applyPreset(v, settings.scaleId)} className="flex-wrap gap-1.5" aria-label="Aspect ratio">
            {SIZE_PRESETS.map((p) => {
              const w = p.width >= p.height ? 14 : Math.round((14 * p.width) / p.height);
              const h = p.height >= p.width ? 14 : Math.round((14 * p.height) / p.width);
              return (
                <ToggleGroupItem key={p.id} value={p.id} title={p.label} className="h-8 gap-2 rounded-[10px]! border border-line bg-transparent px-2.5 font-mono text-[11px] text-ink hover:bg-pill data-[state=on]:border-ink data-[state=on]:bg-ink data-[state=on]:text-paper-2">
                  <span className="block rounded-[2px] border border-current" style={{ width: w, height: h }} />
                  {p.ratio}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
          {!isCloud ? (
            <div className="flex items-center gap-3">
              <ToggleGroup type="single" value={settings.scaleId} onValueChange={(v) => v && applyPreset(settings.presetId, v)} spacing={0} className="rounded-[10px] bg-paper p-[3px]" aria-label="Output size">
                {SIZE_SCALES.map((sc) => (
                  <ToggleGroupItem key={sc.id} value={sc.id} className="h-6 rounded-[7px]! px-2.5 font-mono text-[10.5px] text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]">
                    {sc.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <span className="font-mono text-[11px] text-faint">
                {settings.width} × {settings.height}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {isEdit && isQwen ? <Toggle checked={settings.matchInputSize} onChange={(v) => onChange({ matchInputSize: v })} label="Match the input image" /> : null}

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

      <div className="mt-auto flex items-center gap-3 pt-2">
        <button id="generate-button" type="button" disabled={!canGenerate} onClick={onGenerate} className="btn-primary h-[52px] flex-1 rounded-[14px] text-[15px]">
          {submitting ? "Queueing" : settings.batch > 1 ? `Create ${settings.batch} images` : "Create image"}
          <span className="font-mono text-[12px] font-medium opacity-70">⌘⏎</span>
        </button>
      </div>
    </section>
  );
}
