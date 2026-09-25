export interface SizePreset {
  id: string;
  label: string;
  ratio: string;
  width: number;
  height: number;
}

/** Sizes at roughly one megapixel, all multiples of 32 as Qwen-Image prefers. */
export const SIZE_PRESETS: SizePreset[] = [
  { id: "square", label: "Square", ratio: "1:1", width: 1024, height: 1024 },
  { id: "portrait-3-4", label: "Portrait", ratio: "3:4", width: 896, height: 1152 },
  { id: "landscape-4-3", label: "Landscape", ratio: "4:3", width: 1152, height: 896 },
  { id: "portrait-9-16", label: "Tall", ratio: "9:16", width: 768, height: 1344 },
  { id: "landscape-16-9", label: "Wide", ratio: "16:9", width: 1344, height: 768 },
  { id: "portrait-2-3", label: "Photo", ratio: "2:3", width: 832, height: 1248 },
  { id: "landscape-3-2", label: "Photo wide", ratio: "3:2", width: 1248, height: 832 },
];

export const SIZE_SCALES = [
  { id: "0.5", label: "0.5 MP", factor: Math.SQRT1_2 },
  { id: "1", label: "1 MP", factor: 1 },
  { id: "2", label: "2 MP", factor: Math.SQRT2 },
  { id: "4", label: "4 MP", factor: 2 },
];

export function roundTo32(n: number): number {
  return Math.max(256, Math.round(n / 32) * 32);
}

export function scaledSize(preset: SizePreset, factor: number): { width: number; height: number } {
  return { width: roundTo32(preset.width * factor), height: roundTo32(preset.height * factor) };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}
