import { locale } from "@/i18n/config";

/**
 * Locale-aware formatting for the shell. Everything goes through Intl with the
 * active catalog locale, so a future locale switch reformats numbers, dates and
 * file sizes without touching call sites. Formatter instances are cached —
 * Intl construction is expensive and these run inside render.
 */

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options ?? {});
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, f);
  }
  return f;
}

function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, f);
  }
  return f;
}

/** Plain number with the locale's grouping and decimal separators. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return numberFormat(options).format(value);
}

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/**
 * Human file size: binary steps with the conventional short labels, one decimal
 * under 100, whole numbers above ("512 B", "1.5 MB", "204 GB"). The numeric
 * part is Intl-formatted so separators follow the locale.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${formatNumber(bytes, { maximumFractionDigits: 0 })} B`;
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < BYTE_UNITS.length - 1);
  const digits = v >= 100 ? 0 : 1;
  return `${formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${BYTE_UNITS[i]}`;
}

/** Medium date + time, e.g. "Sep 26, 2026, 09:41 AM" in English. Invalid input renders as "" instead of throwing. */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return dateFormat({ year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}

/** Time of day only, e.g. "09:41 AM" in English. Invalid input renders as "" instead of throwing. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return dateFormat({ hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}
