import "server-only";
import sharp from "sharp";

/**
 * 64-bit difference hash. The image is reduced to a 9×8 grayscale strip and each
 * bit records whether a pixel is brighter than its right-hand neighbour — cheap,
 * and stable across resizes, re-encodes and small colour shifts.
 */
export function dhashFromRaw(pixels: Uint8Array): string {
  let hex = "";
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = y * 9 + x;
      nibble = (nibble << 1) | (pixels[i] > pixels[i + 1] ? 1 : 0);
      if (++bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

export async function dhash(input: string | Buffer): Promise<string> {
  const raw = await sharp(input).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  return dhashFromRaw(raw);
}

/** Hamming distance between two hex hashes; length mismatch counts a whole nibble. */
export function hamming(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let d = Math.abs(a.length - b.length) * 4;
  for (let i = 0; i < n; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}
