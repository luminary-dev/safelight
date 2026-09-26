/**
 * jsdom has no 2D rasterizer, so these tests stub getContext with a recorder:
 * they assert the draw commands, coordinate mapping, and export plumbing —
 * honest about the fact that actual pixels are invisible here (Tier 8's job).
 */
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaskCanvas, OutpaintControls } from "./MaskCanvas";
import { renderApp, stubFetch } from "./test-utils";

interface FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  __strokes?: number;
}

/** Records draw calls and models "painted" as a stroke counter that snapshots/restores like ImageData. */
function makeFakeCtx() {
  let strokes = 0;
  const ctx = {
    calls: [] as string[],
    lastPut: null as FakeImageData | null,
    globalCompositeOperation: "source-over",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    beginPath: () => {},
    moveTo: (x: number, y: number) => ctx.calls.push(`moveTo(${x},${y})`),
    lineTo: (x: number, y: number) => ctx.calls.push(`lineTo(${x},${y})`),
    stroke: () => {
      strokes += 1;
      ctx.calls.push(`stroke:${ctx.globalCompositeOperation}`);
    },
    clearRect: () => {
      strokes = 0;
      ctx.calls.push("clearRect");
    },
    getImageData: (_x: number, _y: number, w: number, h: number): FakeImageData => {
      const data = new Uint8ClampedArray(w * h * 4);
      if (strokes > 0) for (let i = 3; i < data.length; i += 4) data[i] = 255; // painted ⇒ opaque alpha
      return { data, width: w, height: h, __strokes: strokes };
    },
    putImageData: (img: FakeImageData) => {
      if (typeof img.__strokes === "number") strokes = img.__strokes;
      ctx.lastPut = img;
      ctx.calls.push("putImageData");
    },
    createImageData: (w: number, h: number): FakeImageData => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  };
  return ctx;
}
type FakeCtx = ReturnType<typeof makeFakeCtx>;

let contexts: Map<HTMLCanvasElement, FakeCtx>;

beforeEach(() => {
  contexts = new Map();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, makeFakeCtx());
    return contexts.get(this) as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb: BlobCallback) {
    cb(new Blob(["fake-mask"], { type: "image/png" }));
  });
});
afterEach(() => vi.restoreAllMocks());

/** Loads the backdrop image at a natural size and gives the canvas a screen size, so coordinates map. */
function loadImage(natural: { w: number; h: number }, rect: { w: number; h: number }) {
  const img = screen.getByAltText("render.png");
  Object.defineProperty(img, "naturalWidth", { value: natural.w });
  Object.defineProperty(img, "naturalHeight", { value: natural.h });
  fireEvent.load(img);
  const canvas = screen.getByLabelText("Paint the area to replace") as HTMLCanvasElement;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: rect.w, height: rect.h, right: rect.w, bottom: rect.h, x: 0, y: 0, toJSON: () => ({}) });
  return canvas;
}

function strokeAcross(canvas: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
}

describe("MaskCanvas (inpaint)", () => {
  const props = { imageUrl: "/api/view?filename=render.png", imageName: "render.png", onClose: () => {} };

  it("maps brush strokes on a non-square image into natural-resolution coordinates", () => {
    stubFetch();
    renderApp(<MaskCanvas {...props} onSubmit={() => {}} />);
    // Natural 8×6 shown at 100×50: screen (50, 25) is natural (4, 3).
    const canvas = loadImage({ w: 8, h: 6 }, { w: 100, h: 50 });

    strokeAcross(canvas, { x: 25, y: 25 }, { x: 50, y: 25 });

    const ctx = contexts.get(canvas)!;
    expect(ctx.calls).toContain("moveTo(2,3)");
    expect(ctx.calls).toContain("lineTo(4,3)");
    expect(ctx.calls.filter((c) => c === "stroke:source-over")).toHaveLength(2);
  });

  it("maps pointer coordinates correctly AFTER a resize: the rect is re-read per event", () => {
    stubFetch();
    renderApp(<MaskCanvas {...props} onSubmit={() => {}} />);
    const canvas = loadImage({ w: 8, h: 6 }, { w: 100, h: 50 });
    strokeAcross(canvas, { x: 50, y: 25 }, { x: 50, y: 25 });
    expect(contexts.get(canvas)!.calls).toContain("moveTo(4,3)");

    // The window resizes: the same client point now maps through the new rect.
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    strokeAcross(canvas, { x: 50, y: 25 }, { x: 100, y: 50 });
    expect(contexts.get(canvas)!.calls).toContain("moveTo(2,1.5)");
    expect(contexts.get(canvas)!.calls).toContain("lineTo(4,3)");
  });

  it("Escape closes the dialog and the close button stays reachable", () => {
    stubFetch();
    const onClose = vi.fn();
    renderApp(<MaskCanvas {...props} onClose={onClose} onSubmit={() => {}} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the eraser paints with destination-out", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderApp(<MaskCanvas {...props} onSubmit={() => {}} />);
    const canvas = loadImage({ w: 8, h: 8 }, { w: 100, h: 100 });

    await user.click(screen.getByRole("radio", { name: /eraser/i }));
    strokeAcross(canvas, { x: 10, y: 10 }, { x: 20, y: 20 });

    expect(contexts.get(canvas)!.calls).toContain("stroke:destination-out");
  });

  it("gates Inpaint on paint + prompt, then hands back a white-on-black mask blob", async () => {
    stubFetch();
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderApp(<MaskCanvas {...props} onSubmit={onSubmit} />);
    const canvas = loadImage({ w: 4, h: 4 }, { w: 100, h: 100 });

    const inpaint = screen.getByRole("button", { name: /inpaint/i });
    expect(inpaint).toBeDisabled(); // nothing painted, no prompt

    strokeAcross(canvas, { x: 10, y: 10 }, { x: 50, y: 50 });
    expect(inpaint).toBeDisabled(); // still no prompt
    await user.type(screen.getByRole("textbox", { name: "Inpaint prompt" }), "a red door");
    expect(inpaint).toBeEnabled();

    await user.click(inpaint);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submission = onSubmit.mock.calls[0][0] as { mask: Blob; prompt: string; denoise: number };
    expect(submission.prompt).toBe("a red door");
    expect(submission.denoise).toBe(1);
    expect(submission.mask.type).toBe("image/png");
    // The export canvas received a mask where painted pixels are white and fully opaque.
    const exportCtx = [...contexts.values()].find((c) => c.lastPut);
    expect(exportCtx).toBeDefined();
    const px = exportCtx!.lastPut!.data;
    expect([px[0], px[1], px[2], px[3]]).toEqual([255, 255, 255, 255]);
  });

  it("Undo restores the pre-stroke state and Clear empties the mask", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderApp(<MaskCanvas {...props} onSubmit={() => {}} />);
    const canvas = loadImage({ w: 4, h: 4 }, { w: 100, h: 100 });

    const undo = screen.getByRole("button", { name: /undo/i });
    const clear = screen.getByRole("button", { name: /clear/i });
    expect(undo).toBeDisabled();
    expect(clear).toBeDisabled();

    strokeAcross(canvas, { x: 10, y: 10 }, { x: 30, y: 30 });
    expect(undo).toBeEnabled();
    expect(clear).toBeEnabled();

    await user.click(undo);
    expect(undo).toBeDisabled(); // the one-level undo slot is spent
    expect(contexts.get(canvas)!.calls).toContain("putImageData");

    strokeAcross(canvas, { x: 10, y: 10 }, { x: 30, y: 30 });
    await user.click(clear);
    expect(contexts.get(canvas)!.calls).toContain("clearRect");
    // Cleared means nothing to inpaint again.
    await user.type(screen.getByRole("textbox", { name: "Inpaint prompt" }), "anything");
    expect(screen.getByRole("button", { name: /inpaint/i })).toBeDisabled();
  });
});

describe("OutpaintControls", () => {
  const props = { imageUrl: "/api/view?filename=render.png", imageName: "render.png", onClose: () => {} };

  function loadOutpaintImage(w: number, h: number) {
    const img = screen.getByAltText("render.png");
    Object.defineProperty(img, "naturalWidth", { value: w });
    Object.defineProperty(img, "naturalHeight", { value: h });
    fireEvent.load(img);
  }

  it("computes per-side pixels from the chosen directions and percent", async () => {
    stubFetch();
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderApp(<OutpaintControls {...props} onSubmit={onSubmit} />);
    loadOutpaintImage(1024, 768);

    // Defaults: left + right at 25 % of the width; the projected size is shown.
    expect(screen.getByText("1536 × 768")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Outpaint prompt" }), "open sky");
    await user.click(screen.getByRole("button", { name: /outpaint/i }));

    expect(onSubmit).toHaveBeenCalledWith({ left: 256, top: 0, right: 256, bottom: 0, feathering: 24, prompt: "open sky" });
  });

  it("cannot run without a direction or a prompt, and says why", async () => {
    stubFetch();
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderApp(<OutpaintControls {...props} onSubmit={onSubmit} />);
    loadOutpaintImage(512, 512);

    const run = screen.getByRole("button", { name: /outpaint/i });
    expect(run).toBeDisabled(); // no prompt yet
    expect(run).toHaveAttribute("title", "Describe what surrounds the image");

    await user.click(screen.getByRole("button", { name: "Left" }));
    await user.click(screen.getByRole("button", { name: "Right" }));
    expect(run).toHaveAttribute("title", "Pick at least one direction");

    await user.type(screen.getByRole("textbox", { name: "Outpaint prompt" }), "forest");
    expect(run).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Top" }));
    expect(run).toBeEnabled();
    await user.click(run);
    expect(onSubmit).toHaveBeenCalledWith({ left: 0, top: 128, right: 0, bottom: 0, feathering: 24, prompt: "forest" });
  });
});
