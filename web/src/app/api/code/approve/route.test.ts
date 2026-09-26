import type { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { waitForApproval } from "@/lib/agent/approvals";
import { POST } from "./route";

/**
 * /api/code/approve resolves in-flight approval questions (TEST-BRIEF §8):
 * unknown id → { ok: false }, a real resolve settles the waiting promise,
 * and a double-resolve is a no-op.
 */

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:3001/api/code/approve", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as unknown as NextRequest,
  );
}

describe("POST /api/code/approve", () => {
  it("answers { ok: false } for an unknown approval id", async () => {
    const res = await post({ id: "never-asked", allow: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("resolves a pending approval to allow=true and reports ok", async () => {
    const pending = waitForApproval("q-1", 5000);
    const res = await post({ id: "q-1", allow: true });
    expect(await res.json()).toEqual({ ok: true });
    await expect(pending).resolves.toBe(true);
  });

  it("anything but allow === true is a deny", async () => {
    const pending = waitForApproval("q-deny", 5000);
    await post({ id: "q-deny", allow: "yes" });
    await expect(pending).resolves.toBe(false);
  });

  it("a double-resolve is a no-op reported as ok:false", async () => {
    const pending = waitForApproval("q-2", 5000);
    await post({ id: "q-2", allow: false });
    await expect(pending).resolves.toBe(false);
    const second = await post({ id: "q-2", allow: true });
    expect(await second.json()).toEqual({ ok: false });
  });

  it("rejects malformed JSON and a missing id with 400", async () => {
    expect((await post("{oops")).status).toBe(400);
    expect((await post({ allow: true })).status).toBe(400);
  });
});
