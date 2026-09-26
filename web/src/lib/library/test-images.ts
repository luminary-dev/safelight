import sharp from "sharp";

/** Deterministic noise PNG (LCG), midrange values so brightness shifts never clamp. */
export function noisePng(seed: number, w = 32, h = 32): Promise<Buffer> {
  const px = Buffer.alloc(w * h * 3);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < px.length; i++) {
    s = (1103515245 * s + 12345) >>> 0;
    px[i] = 30 + (s % 170);
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** Deterministic striped PNG — strong structure, so its dHash survives resizes. */
export function stripePng(fx: number, fy: number, w = 64, h = 64): Promise<Buffer> {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(128 + 100 * Math.sin(0.35 * fx * x + 0.35 * fy * y));
      const i = (y * w + x) * 3;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
