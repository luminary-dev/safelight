import { describe, expect, it } from "vitest";
import { clipText, extractAttachment, isExtractable, MAX_TEXT_CHARS } from "./attachments";

/** Builds a tiny but valid single-page PDF with one text run; offsets are computed, so PDF.js parses it without recovery. */
function buildPdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= bodies.length; i++) {
    offsets[i] = out.length; // ASCII only, so chars == bytes
    out += `${i} 0 obj\n${bodies[i - 1]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= bodies.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("isExtractable", () => {
  it("accepts text, data, and code extensions regardless of case", () => {
    for (const name of ["notes.txt", "README.md", "data.CSV", "config.json", "script.py", "page.tsx", "doc.PDF"]) {
      expect(isExtractable(name)).toBe(true);
    }
  });

  it("rejects images, binaries, and extensionless names", () => {
    for (const name of ["photo.png", "movie.mp4", "app.exe", "archive.zip", "Makefile"]) {
      expect(isExtractable(name)).toBe(false);
    }
  });
});

describe("clipText", () => {
  it("keeps short text and strips null bytes", () => {
    expect(clipText("a\u0000b  ")).toEqual({ text: "ab", truncated: false });
  });

  it("clips to the limit and flags it", () => {
    const { text, truncated } = clipText("x".repeat(MAX_TEXT_CHARS + 100));
    expect(text.length).toBe(MAX_TEXT_CHARS);
    expect(truncated).toBe(true);
  });
});

describe("extractAttachment", () => {
  it("decodes a UTF-8 text file and strips the BOM", async () => {
    const out = await extractAttachment("notes.txt", utf8("﻿hello world"));
    expect(out).toEqual({ name: "notes.txt", text: "hello world", truncated: false });
  });

  it("passes CSV through as-is", async () => {
    const csv = "name,qty\nfilm,3\npaper,12";
    const out = await extractAttachment("stock.csv", utf8(csv));
    expect(out.text).toBe(csv);
    expect(out.truncated).toBe(false);
  });

  it("clips oversized text and reports truncation", async () => {
    const out = await extractAttachment("big.md", utf8("y".repeat(MAX_TEXT_CHARS + 5)));
    expect(out.text.length).toBe(MAX_TEXT_CHARS);
    expect(out.truncated).toBe(true);
  });

  it("rejects unsupported extensions", async () => {
    await expect(extractAttachment("photo.png", utf8("nope"))).rejects.toThrow(/unsupported/i);
  });

  it("rejects files over the size limit", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    await expect(extractAttachment("big.txt", big)).rejects.toThrow(/10 MB/);
  });

  it("extracts text from a PDF via unpdf", async () => {
    const out = await extractAttachment("hello.pdf", buildPdf("Hello Safelight"));
    expect(out.text).toContain("Hello Safelight");
    expect(out.truncated).toBe(false);
  });
});
