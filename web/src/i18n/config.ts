/**
 * Single-locale i18n configuration. English is the only shipped locale; every
 * UI string still flows through the message catalog (src/i18n/en.json) so a
 * second locale is a catalog file away.
 *
 * TODO(i18n): the future locale switch is a settings key (e.g. `locale` on
 * /api/settings). When it lands, resolve the saved locale here and in
 * src/i18n/request.ts instead of the fixed constant, and add the new
 * catalog(s) beside en.json. Do not add locale routing — Safelight is a
 * single-user local app and the locale is a preference, not a URL.
 */
export const LOCALES = ["en"] as const;
export type AppLocale = (typeof LOCALES)[number];

/** The active locale. Fixed to English until the settings-backed switch exists. */
export const locale: AppLocale = "en";

const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "fa", "he", "ur"]);

/** Writing direction for the active locale; <html dir> and the logical (ms-/me-/ps-/pe-/start-/end-) utilities follow it. */
export const dir: "ltr" | "rtl" = RTL_LOCALES.has(locale) ? "rtl" : "ltr";
