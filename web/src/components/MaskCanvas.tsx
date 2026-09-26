"use client";

/* eslint-disable @next/next/no-img-element */
import { Brush, Eraser, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Slider } from "./ui";

/** What the inpaint dialog hands back: the black/white mask PNG plus the edit's words. */
export interface InpaintSubmission {
  mask: Blob;
  prompt: string;
  denoise: number;
}

export interface OutpaintSubmission {
  left: number;
  top: number;
  right: number;
  bottom: number;
  feathering: number;
  prompt: string;
}

const TOOL_ON = "h-7 rounded-[8px]! px-2 font-mono text-[11px] text-ink-muted hover:bg-transparent hover:text-ink data-[state=on]:bg-paper-2 data-[state=on]:text-ink data-[state=on]:shadow-[var(--shadow-hairline)]";

function DialogShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex flex-col bg-paper/95 backdrop-blur-md">
      <div className="flex items-center justify-between gap-3 px-6 py-4">
        <p className="font-display text-[17px] font-semibold text-ink">{title}</p>
        <button type="button" className="btn-quiet px-2" aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      {children}
    </div>
  );
}

/**
 * Mask brush over the selected Stage image. Paint the area to replace, describe the change,
 * and the exported black/white mask (white = repaint) is handed to `onSubmit`.
 */
export function MaskCanvas({ imageUrl, imageName, busy, onClose, onSubmit }: { imageUrl: string; imageName: string; busy?: boolean; onClose: () => void; onSubmit: (s: InpaintSubmission) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const undoRef = useRef<ImageData | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [brushSize, setBrushSize] = useState(48);
  const [painted, setPainted] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [denoise, setDenoise] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const sizeCanvas = useCallback((img: HTMLImageElement) => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === img.naturalWidth) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
  }, []);

  /** Pointer position in the canvas's own (natural-resolution) pixels. */
  const canvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * canvas.width, y: ((e.clientY - rect.top) / rect.height) * canvas.height };
  };

  const strokeTo = (canvas: HTMLCanvasElement, p: { x: number; y: number }) => {
    const ctx = canvas.getContext("2d");
    const from = lastRef.current ?? p;
    if (!ctx) return;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = "rgba(255,70,60,0.85)";
    ctx.lineWidth = (brushSize / canvas.getBoundingClientRect().width) * canvas.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0) return;
    undoRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setCanUndo(true);
    drawingRef.current = true;
    lastRef.current = null;
    canvas.setPointerCapture(e.pointerId);
    strokeTo(canvas, canvasPoint(e));
    setPainted(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    strokeTo(e.currentTarget, canvasPoint(e));
  };

  const endStroke = () => {
    drawingRef.current = false;
    lastRef.current = null;
  };

  const undo = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !undoRef.current) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.putImageData(undoRef.current, 0, 0);
    undoRef.current = null;
    setCanUndo(false);
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    undoRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    setCanUndo(true);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setPainted(false);
  };

  /** Black/white PNG at the image's natural size: every painted pixel becomes white. */
  const exportMask = (): Promise<Blob> => {
    const src = canvasRef.current;
    if (!src || src.width === 0) return Promise.reject(new Error("The image has not loaded yet."));
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d");
    const srcCtx = src.getContext("2d");
    if (!ctx || !srcCtx) return Promise.reject(new Error("Canvas is unavailable in this browser."));
    const pixels = srcCtx.getImageData(0, 0, src.width, src.height).data;
    const mask = ctx.createImageData(src.width, src.height);
    for (let i = 0; i < pixels.length; i += 4) {
      const on = pixels[i + 3] > 32 ? 255 : 0;
      mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = on;
      mask.data[i + 3] = 255;
    }
    ctx.putImageData(mask, 0, 0);
    return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not export the mask."))), "image/png"));
  };

  const submit = async () => {
    setError(null);
    try {
      const mask = await exportMask();
      onSubmit({ mask, prompt, denoise });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export the mask.");
    }
  };

  return (
    <DialogShell title="Inpaint" onClose={onClose}>
      <div className="flex flex-wrap items-center gap-3 px-6 pb-3">
        <ToggleGroup type="single" value={tool} onValueChange={(v) => v && setTool(v as "brush" | "eraser")} spacing={0} className="rounded-[10px] bg-pill p-[3px]" aria-label="Mask tool">
          <ToggleGroupItem value="brush" className={TOOL_ON}>
            <Brush className="size-3.5" /> Brush
          </ToggleGroupItem>
          <ToggleGroupItem value="eraser" className={TOOL_ON}>
            <Eraser className="size-3.5" /> Eraser
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex w-44 items-center gap-2">
          <span className="form-label shrink-0">Size</span>
          <Slider value={brushSize} min={4} max={160} step={2} onChange={setBrushSize} />
        </div>
        <button type="button" className="btn-quiet h-7" onClick={undo} disabled={!canUndo} title="Undo the last stroke">
          <RotateCcw className="size-3.5" /> Undo
        </button>
        <button type="button" className="btn-quiet h-7" onClick={clear} disabled={!painted} title="Clear the mask">
          <Trash2 className="size-3.5" /> Clear
        </button>
        <div className="ml-auto flex w-52 items-center gap-2" title="1 fully repaints the masked area; lower keeps more of the original">
          <span className="form-label shrink-0">Strength</span>
          <Slider value={denoise} min={0.2} max={1} step={0.05} onChange={setDenoise} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="relative max-h-full max-w-full">
          <img src={imageUrl} alt={imageName} draggable={false} className="max-h-[62vh] max-w-full select-none rounded-[8px] object-contain" onLoad={(e) => sizeCanvas(e.currentTarget)} />
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none rounded-[8px]"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            aria-label="Paint the area to replace"
          />
        </div>
      </div>
      <div className="flex items-center gap-3 px-6 py-4">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && painted && prompt.trim() && !busy && void submit()}
          placeholder="What should appear in the painted area?"
          className="field h-11 flex-1 text-[14px]"
          aria-label="Inpaint prompt"
        />
        <button type="button" className="btn-primary h-11 rounded-[12px] px-5" disabled={!painted || !prompt.trim() || busy} onClick={() => void submit()} title={!painted ? "Paint over the area to replace first" : !prompt.trim() ? "Describe what should appear there" : undefined}>
          {busy ? "Queueing…" : "Inpaint"}
        </button>
      </div>
      {error ? <p className="px-6 pb-4 font-mono text-[11px] text-danger">{error}</p> : null}
    </DialogShell>
  );
}

const DIRECTIONS = [
  { id: "left", label: "Left" },
  { id: "top", label: "Top" },
  { id: "right", label: "Right" },
  { id: "bottom", label: "Bottom" },
] as const;

type Direction = (typeof DIRECTIONS)[number]["id"];

/** Direction + percent outpainting controls: pick sides, how far to extend, and describe the surroundings. */
export function OutpaintControls({ imageUrl, imageName, busy, onClose, onSubmit }: { imageUrl: string; imageName: string; busy?: boolean; onClose: () => void; onSubmit: (s: OutpaintSubmission) => void }) {
  const [dirs, setDirs] = useState<Direction[]>(["left", "right"]);
  const [percent, setPercent] = useState(25);
  const [feathering, setFeathering] = useState(24);
  const [prompt, setPrompt] = useState("");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  const px = (side: Direction): number => {
    if (!natural || !dirs.includes(side)) return 0;
    const base = side === "left" || side === "right" ? natural.w : natural.h;
    return Math.round((percent / 100) * base);
  };

  const submit = () => onSubmit({ left: px("left"), top: px("top"), right: px("right"), bottom: px("bottom"), feathering, prompt });
  const ready = Boolean(natural) && dirs.length > 0 && prompt.trim().length > 0 && !busy;

  return (
    <DialogShell title="Outpaint" onClose={onClose}>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div
          className="rounded-[8px] border border-dashed border-terracotta/70 transition-[padding]"
          style={{
            paddingLeft: dirs.includes("left") ? `${Math.min(30, percent * 0.6)}px` : 0,
            paddingRight: dirs.includes("right") ? `${Math.min(30, percent * 0.6)}px` : 0,
            paddingTop: dirs.includes("top") ? `${Math.min(30, percent * 0.6)}px` : 0,
            paddingBottom: dirs.includes("bottom") ? `${Math.min(30, percent * 0.6)}px` : 0,
          }}
        >
          <img src={imageUrl} alt={imageName} draggable={false} className="max-h-[56vh] max-w-full rounded-[4px] object-contain" onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-6 pt-4">
        <ToggleGroup type="multiple" value={dirs} onValueChange={(v) => setDirs(v as Direction[])} spacing={0} className="rounded-[10px] bg-pill p-[3px]" aria-label="Directions to extend">
          {DIRECTIONS.map((d) => (
            <ToggleGroupItem key={d.id} value={d.id} className={TOOL_ON}>
              {d.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex w-52 items-center gap-2" title="How far to extend, as a share of the image's size">
          <span className="form-label shrink-0">Extend</span>
          <Slider value={percent} min={5} max={100} step={5} onChange={setPercent} />
          <span className="w-10 shrink-0 font-mono text-[11px] text-faint">{percent}%</span>
        </div>
        <div className="flex w-48 items-center gap-2" title="Soft edge between the old and new canvas, in pixels">
          <span className="form-label shrink-0">Feather</span>
          <Slider value={feathering} min={0} max={128} step={4} onChange={setFeathering} />
        </div>
        {natural ? (
          <span className="font-mono text-[11px] text-faint">
            {natural.w + px("left") + px("right")} × {natural.h + px("top") + px("bottom")}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-3 px-6 py-4">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ready && submit()}
          placeholder="What surrounds the image?"
          className="field h-11 flex-1 text-[14px]"
          aria-label="Outpaint prompt"
        />
        <button
          type="button"
          className="btn-primary h-11 rounded-[12px] px-5"
          disabled={!ready}
          onClick={submit}
          title={dirs.length === 0 ? "Pick at least one direction" : !prompt.trim() ? "Describe what surrounds the image" : undefined}
        >
          {busy ? "Queueing…" : "Outpaint"}
        </button>
      </div>
    </DialogShell>
  );
}
