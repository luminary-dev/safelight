import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatNumber, formatTime } from "./i18n-format";

describe("formatBytes", () => {
  it("answers ? for missing or non-finite input", () => {
    expect(formatBytes(null)).toBe("?");
    expect(formatBytes(undefined)).toBe("?");
    expect(formatBytes(Number.NaN)).toBe("?");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("?");
  });

  it("keeps sub-kilobyte sizes in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1,023 B");
  });

  it("shows one decimal under 100 and whole numbers above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(3.2 * 1024 ** 3)).toBe("3.2 GB");
  });

  it("caps at terabytes", () => {
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
    expect(formatBytes(5000 * 1024 ** 4)).toBe("5,000 TB");
  });
});

describe("formatNumber", () => {
  it("applies locale grouping", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it("honours fraction digit options", () => {
    expect(formatNumber(3.14159, { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe("3.14");
    expect(formatNumber(12.7, { maximumFractionDigits: 0 })).toBe("13");
  });
});

describe("formatDate / formatTime", () => {
  // Fixed instant; assertions stay timezone-agnostic (day may shift ±1 locally).
  const ms = Date.UTC(2026, 0, 15, 12, 30);

  it("renders a short month, day, year and a time", () => {
    const out = formatDate(ms);
    expect(out).toMatch(/Jan 1[456], 2026/);
    expect(out).toMatch(/\d{2}:\d{2}/);
  });

  it("renders the time of day alone", () => {
    expect(formatTime(ms)).toMatch(/^\d{2}:\d{2}(\s?[AP]M)?$/);
  });
});
