"use client";

/* eslint-disable @next/next/no-img-element */
import { Lock as LockSimple, LockOpen as LockSimpleOpen, Plus, RefreshCw as ArrowsClockwise, X } from "lucide-react";
import { useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ModelCatalog } from "@/lib/comfy/types";
import { SIZE_PRESETS, SIZE_SCALES, randomSeed, roundTo32, scaledSize } from "@/lib/presets";
import type { Settings, UploadedImage } from "@/lib/safelight-state";
import { Label, Select, Slider, Toggle } from "./ui";

export function Options({ catalog, settings, onChange }: { catalog: ModelCatalog; settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const isQwen = settings.model?.family === "qwen-image";
  const isCloud = settings.model?.folder === "cloud";
  const isEdit = settings.mode === "img2img";
  const needsEncoder = settings.model && settings.model.folder !== "checkpoints";
  const needsTwo = settings.model?.family === "flux";
  const sizeLocked = isEdit && isQwen && settings.matchInputSize;

  const applyPreset = (presetId: string, scaleId: string) => {
    const preset = SIZE_PRESETS.find((p) => p.id === presetId) ?? SIZE_PRESETS[0];
    const scale = SIZE_SCALES.find((s) => s.id === scaleId) ?? SIZE_SCALES[1];
    onChange({ presetId, scaleId, ...scaledSize(preset, scale.factor) });
  };

  return (
    <div className="card mt-3.5 grid gap-6 p-5 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div>
          <Label hint={sizeLocked ? "follows input" : `${settings.width} × ${settings.height}`}>Size</Label>
          {isEdit && isQwen ? (
            <div className="mb-2">
              <Toggle checked={settings.matchInputSize} onChange={(v) => onChange({ matchInputSize: v })} label="Match the input image" />
            </div>
          ) : null}
          {!sizeLocked ? (
            <>
              <ToggleGroup type="single" value={settings.presetId} onValueChange={(v) => v && applyPreset(v, settings.scaleId)} className="flex-wrap gap-1.5" aria-label="Aspect ratio">
                {SIZE_PRESETS.map((p) => {
                  const w = p.width >= p.height ? 16 : Math.round((16 * p.width) / p.height);
                  const h = p.height >= p.width ? 16 : Math.round((16 * p.height) / p.width);
                  return (
                    <ToggleGroupItem key={p.id} value={p.id} title={p.label} className="h-9 gap-2 rounded-full! border border-line bg-transparent px-3 font-mono text-xs text-ink hover:bg-paper-2 data-[state=on]:border-green data-[state=on]:bg-green data-[state=on]:text-paper-2">
                      <span className="block rounded-[2px] border border-current" style={{ width: w, height: h }} />
                      {p.ratio}
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
              <ToggleGroup type="single" value={settings.scaleId} onValueChange={(v) => v && applyPreset(settings.presetId, v)} spacing={0} className="mt-2 rounded-full bg-pill p-[3px]" aria-label="Output size">
                {SIZE_SCALES.map((sc) => (
                  <ToggleGroupItem key={sc.id} value={sc.id} className="h-7 rounded-full! px-3 font-mono text-[11px] text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:text-ink data-[state=on]:shadow-[0_1px_2px_rgba(35,33,29,0.12)]">
                    {sc.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  type="number"
                  step={32}
                  min={256}
                  max={4096}
                  value={settings.width}
                  aria-label="Width"
                  onChange={(e) => onChange({ width: Number(e.target.value) || settings.width })}
                  onBlur={(e) => onChange({ width: roundTo32(Number(e.target.value) || settings.width) })}
                  className="field font-mono text-xs"
                />
                <input
                  type="number"
                  step={32}
                  min={256}
                  max={4096}
                  value={settings.height}
                  aria-label="Height"
                  onChange={(e) => onChange({ height: Number(e.target.value) || settings.height })}
                  onBlur={(e) => onChange({ height: roundTo32(Number(e.target.value) || settings.height) })}
                  className="field font-mono text-xs"
                />
              </div>
            </>
          ) : null}
        </div>
        {isEdit && isQwen ? (
          <div>
            <Label hint={settings.refResolution === 0 ? "native" : `${settings.refResolution}px`}>Reference resolution</Label>
            <Slider value={settings.refResolution} min={0} max={2048} step={32} onChange={(v) => onChange({ refResolution: v })} />
          </div>
        ) : null}
        {isEdit && !isQwen && !isCloud ? (
          <div>
            <Label hint={settings.denoise.toFixed(2)}>Strength</Label>
            <Slider value={settings.denoise} min={0} max={1} step={0.05} onChange={(v) => onChange({ denoise: v })} />
          </div>
        ) : null}
        <div hidden={isCloud}>
          <Label>Negative prompt {isQwen && settings.cfg <= 1 ? <span className="font-mono text-[11px] font-normal text-faint">ignored at cfg 1</span> : null}</Label>
          <textarea value={settings.negativePrompt} onChange={(e) => onChange({ negativePrompt: e.target.value })} rows={2} placeholder="What to avoid" className="field resize-y" />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {isCloud ? (
          <>
            <div>
              <Label hint={`${settings.batch} image${settings.batch > 1 ? "s" : ""}`}>Batch</Label>
              <Slider value={settings.batch} min={1} max={4} step={1} onChange={(v) => onChange({ batch: v })} />
            </div>
            <p className="text-[13px] leading-relaxed text-faint">
              Cloud models pick their own sampling. Size is mapped to the closest aspect ratio the provider supports.
            </p>
          </>
        ) : null}
        <div hidden={isCloud}>
          <Label hint={String(settings.steps)}>Steps</Label>
          <Slider value={settings.steps} min={1} max={80} step={1} onChange={(v) => onChange({ steps: v })} />
        </div>
        <div hidden={isCloud}>
          <Label hint={settings.cfg.toFixed(1)}>CFG</Label>
          <Slider value={settings.cfg} min={0} max={20} step={0.5} onChange={(v) => onChange({ cfg: v })} />
        </div>
        <div hidden={isCloud}>
          <Label hint={`${settings.batch} image${settings.batch > 1 ? "s" : ""}`}>Batch</Label>
          <Slider value={settings.batch} min={1} max={8} step={1} onChange={(v) => onChange({ batch: v })} />
        </div>
        <div hidden={isCloud}>
          <Label>Seed</Label>
          <div className="flex gap-1.5">
            <input
              type="number"
              min={0}
              value={settings.seed}
              disabled={!settings.lockSeed}
              onChange={(e) => onChange({ seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
              className="field flex-1 font-mono text-xs disabled:opacity-60"
            />
            <button type="button" className="btn-quiet px-2.5" title={settings.lockSeed ? "Locked. Click to randomize each run." : "Random each run. Click to lock."} onClick={() => onChange({ lockSeed: !settings.lockSeed })}>
              {settings.lockSeed ? <LockSimple size={15} /> : <LockSimpleOpen size={15} />}
            </button>
            <button type="button" className="btn-quiet px-2.5" title="New random seed" onClick={() => onChange({ seed: randomSeed(), lockSeed: true })}>
              <ArrowsClockwise size={15} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2" hidden={isCloud}>
          <div>
            <Label>Sampler</Label>
            <Select value={settings.sampler} onChange={(v) => onChange({ sampler: v })} options={catalog.samplers.map((x) => ({ value: x, label: x }))} ariaLabel="Sampler" />
          </div>
          <div>
            <Label>Scheduler</Label>
            <Select value={settings.scheduler} onChange={(v) => onChange({ scheduler: v })} options={catalog.schedulers.map((x) => ({ value: x, label: x }))} ariaLabel="Scheduler" />
          </div>
        </div>
        {needsEncoder ? (
          <>
            <div>
              <Label>{needsTwo ? "Text encoder (T5)" : "Text encoder"}</Label>
              <Select
                value={settings.textEncoders[0] ?? ""}
                onChange={(v) => onChange({ textEncoders: [v, ...settings.textEncoders.slice(1)] })}
                placeholder="Select a text encoder"
                options={[{ value: "", label: "" }, ...catalog.textEncoders.map((x) => ({ value: x, label: x }))]}
              />
            </div>
            {needsTwo ? (
              <div>
                <Label>Text encoder (CLIP-L)</Label>
                <Select
                  value={settings.textEncoders[1] ?? ""}
                  onChange={(v) => onChange({ textEncoders: [settings.textEncoders[0] ?? "", v] })}
                  placeholder="Select a CLIP-L encoder"
                  options={[{ value: "", label: "" }, ...catalog.textEncoders.map((x) => ({ value: x, label: x }))]}
                />
              </div>
            ) : null}
          </>
        ) : null}
        <div hidden={isCloud}>
          <Label hint={settings.model?.folder === "checkpoints" ? "optional" : undefined}>VAE</Label>
          <Select
            value={settings.vae}
            onChange={(v) => onChange({ vae: v })}
            placeholder={settings.model?.folder === "checkpoints" ? "Use the checkpoint's VAE" : "Select a VAE"}
            options={[{ value: "", label: "" }, ...catalog.vaes.map((x) => ({ value: x, label: x }))]}
          />
        </div>
        {catalog.loras.length > 0 && !isCloud ? (
          <div>
            <Label hint={settings.lora ? settings.loraStrength.toFixed(2) : undefined}>LoRA</Label>
            <Select value={settings.lora} onChange={(v) => onChange({ lora: v })} placeholder="None" options={[{ value: "", label: "" }, ...catalog.loras.map((x) => ({ value: x, label: x }))]} />
            {settings.lora ? (
              <div className="mt-2">
                <Slider value={settings.loraStrength} min={-1} max={2} step={0.05} onChange={(v) => onChange({ loraStrength: v })} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function InputImages({
  images,
  max,
  uploading,
  onUpload,
  onRemove,
  hint,
}: {
  images: UploadedImage[];
  max: number;
  uploading: boolean;
  onUpload: (files: File[]) => Promise<void>;
  onRemove: (ref: string) => void;
  hint: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const room = Math.max(0, max - images.length);

  const handleFiles = (list: FileList | null) => {
    if (!list) return;
    const files = Array.from(list)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, room);
    if (files.length) void onUpload(files);
  };

  return (
    <div className="mb-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`flex flex-wrap gap-2.5 rounded-2xl border border-dashed p-2.5 transition-colors ${over ? "border-green bg-green-wash" : "border-line"}`}
      >
        {images.map((img, i) => (
          <div key={img.ref} className="group relative h-[96px] w-[96px] overflow-hidden rounded-[10px] border border-line bg-pill">
            <img src={img.previewUrl} alt={`Input ${i + 1}`} className="h-full w-full object-cover" />
            <span className="absolute left-1.5 top-1.5 rounded bg-paper-2/90 px-1.5 py-0.5 font-mono text-[10px] text-ink">{max > 1 ? `image${i + 1}` : "input"}</span>
            <button
              type="button"
              aria-label="Remove image"
              onClick={() => onRemove(img.ref)}
              className="absolute right-1.5 top-1.5 rounded-full bg-paper-2/90 p-1 text-ink opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {room > 0 ? (
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="flex h-[96px] w-[96px] flex-col items-center justify-center gap-1 rounded-[10px] border border-line bg-paper-2 text-ink-muted transition-colors hover:border-faint disabled:opacity-50"
          >
            {uploading ? <ArrowsClockwise size={18} className="animate-spin" /> : <Plus size={18} />}
            <span className="font-mono text-[10px] uppercase tracking-[0.08em]">{uploading ? "Uploading" : images.length ? "Add" : "Drop or pick"}</span>
          </button>
        ) : null}
        <input ref={inputRef} type="file" accept="image/*" multiple={max > 1} hidden onChange={(e) => handleFiles(e.target.files)} />
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-faint">{hint}</p>
    </div>
  );
}
