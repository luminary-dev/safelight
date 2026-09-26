import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { dhash, dhashFromRaw, hamming } from "./dhash";
import { stripePng } from "./test-images";

describe("dhash", () => {
  it("is a deterministic 16-hex-char hash", async () => {
    const img = await stripePng(1, 0.3);
    const a = await dhash(img);
    const b = await dhash(img);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
  });

  it("stays close for a brightened and a resized copy", async () => {
    const base = await stripePng(1, 0.3);
    const h0 = await dhash(base);
    const brighter = await sharp(base).linear(1, 18).png().toBuffer();
    const resized = await sharp(base).resize(128, 128).png().toBuffer();
    expect(hamming(h0, await dhash(brighter))).toBeLessThanOrEqual(6);
    expect(hamming(h0, await dhash(resized))).toBeLessThanOrEqual(6);
  });

  it("is far for a structurally different image", async () => {
    const a = await dhash(await stripePng(1, 0.3));
    const b = await dhash(await stripePng(0.2, 1.4));
    expect(hamming(a, b)).toBeGreaterThan(6);
  });

  it("computes hamming distance per bit, penalising length mismatch", () => {
    expect(hamming("00", "00")).toBe(0);
    expect(hamming("00", "07")).toBe(3);
    expect(hamming("f0", "0f")).toBe(8);
    expect(hamming("00", "000")).toBe(4);
  });

  it("dhashFromRaw sets a bit when the left pixel is brighter", () => {
    // Row pattern 9 wide: strictly decreasing → every comparison true → all ones.
    const px = new Uint8Array(72);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) px[y * 9 + x] = 200 - x * 10;
    expect(dhashFromRaw(px)).toBe("ffffffffffffffff");
  });
});

describe("dhash edge cases", () => {
  it("a solid-color image hashes to all zero bits (no neighbour is ever brighter)", async () => {
    const flat = await sharp(Buffer.alloc(48 * 48 * 3, 128), { raw: { width: 48, height: 48, channels: 3 } }).png().toBuffer();
    expect(await dhash(flat)).toBe("0000000000000000");
  });

  it("hashes a 1x1 image without falling over (fill-resize to the 9x8 strip)", async () => {
    const px = await sharp(Buffer.from([200, 60, 30]), { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer();
    expect(await dhash(px)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects corrupt bytes instead of answering a junk hash", async () => {
    await expect(dhash(Buffer.from("not an image"))).rejects.toThrow();
  });

  it("false-positive resistance: distinct noise fields stay far apart", async () => {
    const a = await dhash(await stripePng(1, 0.3));
    const rotated = await dhash(await sharp(await stripePng(1, 0.3)).rotate(90).png().toBuffer());
    // A 90° rotation is a different image to a dHash — it must NOT group.
    expect(hamming(a, rotated)).toBeGreaterThan(6);
  });
});
