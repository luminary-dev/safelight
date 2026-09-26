import { describe, expect, it } from "vitest";
import { guardUrl } from "./design-tools";

const BLOCKED = [
  "http://localhost/x",
  "http://localhost:3001/api/keys",
  "https://127.0.0.1/",
  "http://127.1.2.3/",
  "http://0.0.0.0/",
  "http://10.0.0.5/",
  "http://192.168.1.1/admin",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://169.254.169.254/latest/meta-data/",
  "http://foo.local/",
  "http://backend.internal/",
  "ftp://example.com/file",
  "file:///etc/passwd",
];

const ALLOWED = ["https://example.com/", "http://example.org/page?q=1", "https://sub.domain.co.uk/path"];

describe("guardUrl", () => {
  it.each(BLOCKED)("blocks %s", (url) => {
    expect(() => guardUrl(url)).toThrow();
  });

  it.each(ALLOWED)("allows %s", (url) => {
    expect(guardUrl(url).href).toContain("://");
  });

  it("rejects garbage", () => {
    expect(() => guardUrl("not a url")).toThrow(/not a valid URL/);
  });

  it("does not block public 172.x outside the private range", () => {
    expect(() => guardUrl("http://172.32.0.1/")).not.toThrow();
  });
});

import { isForbiddenAddress } from "./design-tools";

describe("isForbiddenAddress", () => {
  const forbidden = ["127.0.0.1", "127.8.8.8", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.9.9", "192.168.0.10", "169.254.169.254", "100.64.0.1", "100.127.1.1", "::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip"];
  const allowed = ["8.8.8.8", "104.16.0.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"];

  it.each(forbidden)("forbids %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each(allowed)("allows %s", (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeDesignTool against the search fakes, the page server, and the real DB
// cache (TEST-BRIEF §6 / §9 design toolset): search_web through the real
// provider chain, fetch_page's guards and extraction, save_theme's gates.

import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { listThemes } from "@/lib/db/sessions";
import { setSetting } from "@/lib/db/settings";
import { invalidateLocalOnlyCache } from "@/lib/privacy";
import { makeTestDb, type TestDb } from "@/test/fixtures/db";
import { searchApiHandlers, startPageServer, type FakePageServer, type SearchScript } from "@/test/fakes/search-server";
import { executeDesignTool } from "./design-tools";

/**
 * assertPublicHost does a real dns.lookup; every hostname in these tests
 * resolves to a public address unless a test flips `dns.address` to simulate
 * DNS rebinding (a public-looking name answering with a loopback address).
 */
const dns = vi.hoisted(() => ({ address: "93.184.216.34" }));
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: dns.address, family: 4 }],
}));

const script: SearchScript = {};
const searchMsw = setupServer(...searchApiHandlers(script));
let db: TestDb;
let pages: FakePageServer;

beforeAll(async () => {
  searchMsw.listen({ onUnhandledRequest: "bypass" }); // bypass keeps the in-process page server reachable
  pages = await startPageServer();
});

beforeEach(async () => {
  db = await makeTestDb();
  dns.address = "93.184.216.34";
  delete script.brave;
  delete script.tavily;
  delete script.ddg;
  vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
  vi.stubEnv("TAVILY_API_KEY", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.cleanup();
});

afterAll(async () => {
  searchMsw.close();
  await pages.close();
});

describe("search_web through the real chain", () => {
  it("uses Brave first when its key is present, stripping markup from results", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "bk");
    const { result, note } = await executeDesignTool("search_web", { query: "sea glass palettes" });
    const r = result as { provider: string; results: { title: string; url: string; snippet: string }[] };
    expect(r.provider).toBe("brave");
    expect(r.results[0]).toEqual({ title: "Result one", url: "https://example.com/one", snippet: "First & finest" });
    expect(note).toBe("2 results · brave");
  });

  it("fails over to Tavily when Brave errors", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "bk");
    vi.stubEnv("TAVILY_API_KEY", "tk");
    script.brave = { status: 500 };
    const { result } = await executeDesignTool("search_web", { query: "failover check" });
    expect((result as { provider: string }).provider).toBe("tavily");
  });

  it("falls back to the keyless DuckDuckGo scrape, decoding uddg redirects", async () => {
    const { result } = await executeDesignTool("search_web", { query: "no keys anywhere" });
    const r = result as { provider: string; results: { url: string }[] };
    expect(r.provider).toBe("ddg");
    expect(r.results.map((x) => x.url)).toContain("https://example.com/one");
  });

  it("a cache hit answers from the DB without re-requesting any provider", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "bk");
    let braveRequests = 0;
    const count = ({ request }: { request: Request }) => {
      if (new URL(request.url).hostname === "api.search.brave.com") braveRequests++;
    };
    searchMsw.events.on("request:start", count);
    const first = await executeDesignTool("search_web", { query: "Cache Me" });
    expect(braveRequests).toBe(1);
    script.brave = { status: 500 }; // a re-request would now fail over or throw
    const second = await executeDesignTool("search_web", { query: "cache me  " }); // normalised query shares the entry
    searchMsw.events.removeListener("request:start", count);
    expect(braveRequests).toBe(1);
    expect((second.result as { provider: string }).provider).toBe("brave");
    expect(second.result).toEqual(first.result);
  });

  it("rejects an empty query", async () => {
    await expect(executeDesignTool("search_web", { query: "  " })).rejects.toThrow(/Empty query/);
  });

  it("is blocked by Local only mode with the standard message", async () => {
    setSetting("localOnly", true);
    invalidateLocalOnlyCache();
    try {
      await expect(executeDesignTool("search_web", { query: "x" })).rejects.toThrow("Local only is on — web search is disabled. Turn it off in Settings to use it.");
    } finally {
      setSetting("localOnly", false);
      invalidateLocalOnlyCache();
    }
  });
});

describe("fetch_page", () => {
  /**
   * guardUrl refuses loopback hosts by design, so the tests browse
   * https://scout.example/... and a fetch wrapper rewrites that host onto the
   * in-process page server. The DNS mock keeps assertPublicHost satisfied.
   */
  const PAGE_HOST = "scout.example";

  function routeToPageServer() {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.hostname === PAGE_HOST) return real(`http://127.0.0.1:${pages.port}${u.pathname}${u.search}`, init);
      return real(input, init);
    });
  }

  const page = (p: string) => executeDesignTool("fetch_page", { url: `https://${PAGE_HOST}${p}` });

  it("returns stripped text plus deduped, lowercased colors and fonts", async () => {
    routeToPageServer();
    const { result, note } = await page("/page");
    const r = result as { url: string; text: string; colors: string[]; fonts: string[] };
    expect(r.text).toContain("Sea Glass");
    expect(r.text).not.toContain("console.log"); // scripts are stripped
    expect([...r.colors].sort()).toEqual(["#0a1628", "#84cc16", "#e2e8f0"]); // #84cc16 appears twice in the source
    expect(r.fonts).toEqual(["Inter", "Fraunces"]);
    expect(note).toBe("3 colors · 2 fonts");
  });

  it("refuses a non-HTML response by content type", async () => {
    routeToPageServer();
    await expect(page("/binary")).rejects.toThrow("Not a readable page (image/png).");
  });

  it("truncates an oversized page to the text cap instead of failing", async () => {
    routeToPageServer();
    const { result } = await page("/huge");
    expect((result as { text: string }).text.length).toBeLessThanOrEqual(8000);
  });

  it("follows a redirect chain, re-checking every hop, and lands on the page", async () => {
    routeToPageServer();
    const before = pages.hits.length;
    const { result } = await page("/redirect/3");
    expect((result as { colors: string[] }).colors).toContain("#84cc16");
    expect(pages.hits.slice(before)).toEqual(["/redirect/3", "/redirect/2", "/redirect/1", "/page"]);
  });

  it("stops a redirect loop at the hop limit", async () => {
    routeToPageServer();
    await expect(page("/redirect-loop")).rejects.toThrow("Too many redirects.");
  });

  it("refuses a redirect that points at a private address", async () => {
    routeToPageServer();
    await expect(page(`/redirect-to?url=${encodeURIComponent("http://192.168.1.1/admin")}`)).rejects.toThrow(
      "Local and private-network addresses cannot be fetched.",
    );
  });

  it("refuses a public-looking hostname that resolves to loopback (DNS rebinding)", async () => {
    dns.address = "127.0.0.1";
    await expect(executeDesignTool("fetch_page", { url: "https://rebind.example/" })).rejects.toThrow(
      "That hostname resolves to a private or local address.",
    );
  });

  it("names the status of a failing page", async () => {
    routeToPageServer();
    await expect(page("/no-such-route")).rejects.toThrow("The page returned 404.");
  });

  it("propagates a fetch timeout to the caller", async () => {
    // The real 15 s AbortSignal.timeout cannot be advanced from vitest's fake
    // timers (it lives in Node internals), so the timeout rejection is injected.
    vi.stubGlobal("fetch", () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })));
    await expect(executeDesignTool("fetch_page", { url: "https://slow.example/" })).rejects.toThrow(/timeout/i);
  });

  it("is blocked by Local only mode", async () => {
    setSetting("localOnly", true);
    invalidateLocalOnlyCache();
    try {
      await expect(page("/page")).rejects.toThrow("Local only is on — page fetching is disabled. Turn it off in Settings to use it.");
    } finally {
      setSetting("localOnly", false);
      invalidateLocalOnlyCache();
    }
  });
});

describe("save_theme", () => {
  const GOOD_COLORS = { bg: "#0A1628", surface: "#101F33", text: "#E2E8F0", muted: "#94A3B8", accent: "#84CC16", accentText: "#0A1628" };
  const FONTS = { display: "Fraunces", body: "Inter", mono: "JetBrains Mono" };

  it("saves a passing theme with lowercased colors and reports the minimum contrast", async () => {
    const { result, note } = await executeDesignTool("save_theme", { name: "sea-glass", description: "Lime on deep navy", colors: GOOD_COLORS, fonts: FONTS });
    const theme = (result as { theme: { name: string; colors: Record<string, string>; contrast: Record<string, number> } }).theme;
    expect(theme.name).toBe("sea-glass");
    expect(theme.colors).toEqual({ bg: "#0a1628", surface: "#101f33", text: "#e2e8f0", muted: "#94a3b8", accent: "#84cc16", accentText: "#0a1628" });
    expect(note).toMatch(/^saved sea-glass · contrast \d+(\.\d+)?:1 min$/);
    expect(listThemes().map((t) => t.name)).toContain("sea-glass");
  });

  it('normalises the slug: "Sea Glass!!" → sea-glass', async () => {
    const { result } = await executeDesignTool("save_theme", { name: "Sea Glass!!", description: "d", colors: GOOD_COLORS, fonts: FONTS });
    expect((result as { theme: { name: string } }).theme.name).toBe("sea-glass");
  });

  it("caps the slug at 40 characters", async () => {
    const { result } = await executeDesignTool("save_theme", { name: "x".repeat(60), description: "d", colors: GOOD_COLORS, fonts: FONTS });
    expect((result as { theme: { name: string } }).theme.name).toBe("x".repeat(40));
  });

  it("rejects a name that normalises to nothing", async () => {
    await expect(executeDesignTool("save_theme", { name: "!!!", description: "d", colors: GOOD_COLORS, fonts: FONTS })).rejects.toThrow("Give the theme a short name.");
  });

  it.each(["bg", "surface", "text", "muted", "accent", "accentText"])("validates colors.%s as 6-digit hex", async (key) => {
    const bad = { ...GOOD_COLORS, [key]: "tomato" };
    await expect(executeDesignTool("save_theme", { name: "t", description: "d", colors: bad, fonts: FONTS })).rejects.toThrow(
      `colors.${key} must be a 6-digit hex like #84cc16.`,
    );
    const missing = { ...GOOD_COLORS } as Record<string, string>;
    delete missing[key];
    await expect(executeDesignTool("save_theme", { name: "t", description: "d", colors: missing, fonts: FONTS })).rejects.toThrow(`colors.${key} must be a 6-digit hex`);
  });

  it("rejects a failing WCAG pair with the ratio and remediation, and stores nothing", async () => {
    const lowContrast = { ...GOOD_COLORS, text: "#777777", bg: "#666666" };
    await expect(executeDesignTool("save_theme", { name: "murky", description: "d", colors: lowContrast, fonts: FONTS })).rejects.toThrow(
      /Contrast too low \(WCAG AA needs 4\.5:1 for text\): text on bg is \d+\.\d{2}:1.*Adjust the colors and save again\./,
    );
    expect(listThemes().map((t) => t.name)).not.toContain("murky");
  });

  it("truncates the description to 200 characters", async () => {
    const { result } = await executeDesignTool("save_theme", { name: "longdesc", description: "d".repeat(300), colors: GOOD_COLORS, fonts: FONTS });
    expect((result as { theme: { description: string } }).theme.description).toHaveLength(200);
  });
});

describe("unknown design tools", () => {
  it("name the tool in the error", async () => {
    await expect(executeDesignTool("mystery", {})).rejects.toThrow("Unknown tool: mystery");
  });
});
