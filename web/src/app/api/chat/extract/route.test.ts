import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { POST } from "./route";

function multipart(file?: File): NextRequest {
  const form = new FormData();
  if (file) form.append("file", file);
  return new Request("http://localhost/api/chat/extract", { method: "POST", body: form }) as unknown as NextRequest;
}

describe("POST /api/chat/extract", () => {
  it("extracts a text file", async () => {
    const res = await POST(multipart(new File(["hello from a note"], "note.txt", { type: "text/plain" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ name: "note.txt", text: "hello from a note", truncated: false });
  });

  it("passes CSV through as-is", async () => {
    const csv = "a,b\n1,2";
    const res = await POST(multipart(new File([csv], "data.csv", { type: "text/csv" })));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe(csv);
  });

  it("clips long content and flags truncation", async () => {
    const res = await POST(multipart(new File(["z".repeat(60_000)], "long.md")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text.length).toBe(50_000);
    expect(body.truncated).toBe(true);
  });

  it("rejects a missing file", async () => {
    const res = await POST(multipart());
    expect(res.status).toBe(400);
  });

  it("rejects unsupported types", async () => {
    const res = await POST(multipart(new File(["x"], "photo.png", { type: "image/png" })));
    expect(res.status).toBe(415);
  });

  it("rejects files over 10 MB", async () => {
    const res = await POST(multipart(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.txt")));
    expect(res.status).toBe(413);
  });
});
