import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { config, middleware } from "./middleware";

/**
 * middleware.ts is the host-allowlist + CSRF origin control on every /api route
 * (TEST-BRIEF §8, §15 — gate 6's evidence). Handlers are called directly; a 200
 * with the x-middleware-next marker means the request was let through.
 */

function req(method: string, headers: Record<string, string>, urlPath = "/api/health"): NextRequest {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new NextRequest(new Request(`http://localhost:3001${urlPath}`, { method, headers: h }));
}

function passed(res: Response): boolean {
  return res.status === 200 && res.headers.get("x-middleware-next") === "1";
}

afterEach(() => {
  delete process.env.SAFELIGHT_ALLOWED_HOSTS;
});

describe("host allowlist", () => {
  it("lets an allowed host through", () => {
    expect(passed(middleware(req("GET", { host: "localhost:3001" })))).toBe(true);
    expect(passed(middleware(req("GET", { host: "127.0.0.1:3001" })))).toBe(true);
    expect(passed(middleware(req("GET", { host: "LOCALHOST" })))).toBe(true);
  });

  it("refuses a foreign host with a 403 and no next marker", async () => {
    const res = middleware(req("GET", { host: "evil.example:3001" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("x-middleware-next")).toBeNull();
    expect(((await res.json()) as { error: string }).error).toMatch(/host/i);
  });

  it("refuses a request with no Host header at all", () => {
    expect(middleware(req("GET", {})).status).toBe(403);
  });

  it("allows the IPv6 loopback host it advertises in the allowlist", () => {
    // "[::1]:3001".split(":")[0] is "[" — the allowlist entry "[::1]" needs bracket-aware parsing.
    expect(passed(middleware(req("GET", { host: "[::1]:3001" })))).toBe(true);
    expect(passed(middleware(req("GET", { host: "[::1]" })))).toBe(true);
  });

  it("honors SAFELIGHT_ALLOWED_HOSTS extras, trimmed and case-insensitive", () => {
    process.env.SAFELIGHT_ALLOWED_HOSTS = " studio.lan , MyBox.Local ";
    expect(passed(middleware(req("GET", { host: "studio.lan:3001" })))).toBe(true);
    expect(passed(middleware(req("GET", { host: "mybox.local" })))).toBe(true);
    expect(middleware(req("GET", { host: "other.lan" })).status).toBe(403);
  });

  it("does not treat an extra allowed host as a wildcard", () => {
    process.env.SAFELIGHT_ALLOWED_HOSTS = "studio.lan";
    expect(middleware(req("GET", { host: "evil.studio.lan" })).status).toBe(403);
  });
});

describe("origin check on mutating methods", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses a foreign Origin on %s", async (method) => {
    const res = middleware(req(method, { host: "localhost:3001", origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/cross-origin/i);
  });

  it("allows a mutating request with no Origin — the documented curl/script case", () => {
    expect(passed(middleware(req("POST", { host: "localhost:3001" })))).toBe(true);
  });

  it("allows a same-origin mutating request", () => {
    expect(passed(middleware(req("POST", { host: "localhost:3001", origin: "http://localhost:3001" })))).toBe(true);
  });

  it("allows an allowlisted IPv6 Origin on a mutating request", () => {
    expect(passed(middleware(req("POST", { host: "[::1]:3001", origin: "http://[::1]:3001" })))).toBe(true);
  });

  it("accepts a same-hostname Origin on a different port — the check is hostname-only by design", () => {
    // Documented behavior: allowedHosts() compares hostnames, so localhost:9999 → localhost:3001 passes.
    expect(passed(middleware(req("POST", { host: "localhost:3001", origin: "http://localhost:9999" })))).toBe(true);
  });

  it("refuses a malformed Origin header", async () => {
    const res = middleware(req("POST", { host: "localhost:3001", origin: "not a url" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/malformed origin/i);
  });

  it("does not check Origin on GET — reads are not CSRF-able", () => {
    expect(passed(middleware(req("GET", { host: "localhost:3001", origin: "https://evil.example" })))).toBe(true);
  });

  it("accepts a foreign-Origin mutation once the origin host is allowlisted via SAFELIGHT_ALLOWED_HOSTS", () => {
    process.env.SAFELIGHT_ALLOWED_HOSTS = "studio.lan";
    expect(passed(middleware(req("POST", { host: "localhost:3001", origin: "http://studio.lan:3001" })))).toBe(true);
  });
});

describe("mount point", () => {
  it("is mounted on /api only, so non-/api paths are unaffected", () => {
    expect(config.matcher).toBe("/api/:path*");
  });
});
