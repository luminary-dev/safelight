import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/chat/estimate?${qs}`));

describe("GET /api/chat/estimate", () => {
  it("returns per-Mtok rates for a priced cloud model", async () => {
    const res = await get("provider=anthropic&model=claude-sonnet-4-5-20250929");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inPerMtok).toBe(3);
    expect(body.outPerMtok).toBe(15);
    expect(body.local).toBe(false);
  });

  it("answers null rates for local providers", async () => {
    const res = await get("provider=ollama&model=llama3.2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inPerMtok).toBeNull();
    expect(body.local).toBe(true);
  });

  it("answers null rates for unpriced models", async () => {
    const res = await get("provider=openai&model=totally-unknown-model");
    const body = await res.json();
    expect(body.inPerMtok).toBeNull();
    expect(body.outPerMtok).toBeNull();
  });

  it("requires a model", async () => {
    const res = await get("provider=openai");
    expect(res.status).toBe(400);
  });
});
