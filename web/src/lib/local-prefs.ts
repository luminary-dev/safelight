import { DEFAULT_SETTINGS, type Settings } from "@/lib/safelight-state";

/**
 * Client-side preference helpers. All reads fall back to the pre-rename studio.* keys once,
 * copying the value forward, so upgrades keep their settings.
 */

export function loadString(key: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  try {
    const value = localStorage.getItem(key);
    if (value !== null) return value;
    // Migration shim: settings written before the Safelight rename live under studio.*.
    const legacy = localStorage.getItem(key.replace(/^safelight\./, "studio."));
    if (legacy !== null) {
      localStorage.setItem(key, legacy);
      return legacy;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = loadString(key, "");
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Restores prompt and sampling preferences. Model and images are re-resolved against the live catalog. */
export function loadSavedSettings(settingsKey: string): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(settingsKey);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...saved, images: [], model: saved.model ?? null };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
