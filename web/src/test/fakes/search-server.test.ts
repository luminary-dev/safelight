import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { searchApiHandlers, startPageServer, type FakePageServer } from "./search-server";

/**
 * The search adapters (brave/tavily/ddg) hardcode their hosts, so the fakes'
 * fidelity is proven by running the REAL adapters in src/lib/search/* against
 * the MSW handlers. The page server is exercised with raw fetch.
 */

const msw = setupServer(...searchApiHandlers());
const signal = new AbortController().signal;

beforeAll(() => {
  msw.listen({ onUnhandledRequest: "bypass" }); // page server lives on 127.0.0.1
  process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
  process.env.TAVILY_API_KEY = "test-tavily-key";
});
afterEach(() => msw.resetHandlers(...searchApiHandlers()));
afterAll(() => {
  msw.close();
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.TAVILY_API_KEY;
});

describe("search API shapes through the real adapters", () => {
  it("brave: results parsed, <strong> highlights stripped", async () => {
    const { brave } = await import("@/lib/search/brave");
    const results = await brave.search("sea glass", signal);
    expect(results[0]).toEqual({ title: "Result one", url: "https://example.com/one", snippet: "First & finest" });
    expect(results).toHaveLength(2);
  });

  it("tavily: results parsed from the POST shape", async () => {
    const { tavily } = await import("@/lib/search/tavily");
    const results = await tavily.search("sea glass", signal);
    expect(results[1]).toMatchObject({ url: "https://example.com/two" });
  });

  it("ddg: HTML scraped, uddg redirect unwrapped", async () => {
    const { ddg } = await import("@/lib/search/ddg");
    const results = await ddg.search("sea glass", signal);
    expect(results[0].url).toBe("https://example.com/one");
    expect(results[0].title).toBe("Result one");
  });

  it("scripts an error status per provider", async () => {
    msw.resetHandlers(...searchApiHandlers({ brave: { status: 429 } }));
    const { brave } = await import("@/lib/search/brave");
    await expect(brave.search("q", signal)).rejects.toThrow(/429/);
  });
});

describe("page server", () => {
  let pages: FakePageServer;
  beforeAll(async () => {
    pages = await startPageServer();
  });
  afterAll(async () => {
    await pages.close();
  });

  it("serves an HTML page carrying extractable colors and fonts", async () => {
    const res = await fetch(`${pages.url}/page`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("#84cc16");
    expect(html).toContain("'Fraunces'");
  });

  it("walks a redirect chain hop by hop (manual redirect mode)", async () => {
    let url = `${pages.url}/redirect/3`;
    const hops: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(url, { redirect: "manual" });
      hops.push(res.status);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).href;
        continue;
      }
      break;
    }
    expect(hops).toEqual([302, 302, 302, 200]);
    expect(url).toBe(`${pages.url}/page`);
  });

  it("redirect-loop never resolves; redirect-to targets an arbitrary URL", async () => {
    const loop = await fetch(`${pages.url}/redirect-loop`, { redirect: "manual" });
    expect(loop.status).toBe(302);
    expect(loop.headers.get("location")).toBe("/redirect-loop");
    const away = await fetch(`${pages.url}/redirect-to?url=${encodeURIComponent("http://127.0.0.1:1/private")}`, { redirect: "manual" });
    expect(away.headers.get("location")).toBe("http://127.0.0.1:1/private");
  });

  it("serves a non-HTML content type and an oversized HTML body", async () => {
    const binary = await fetch(`${pages.url}/binary`);
    expect(binary.headers.get("content-type")).toBe("image/png");
    const huge = await fetch(`${pages.url}/huge`);
    const body = await huge.text();
    expect(body.length).toBeGreaterThan(1024 * 1024); // past fetch_page's 800 KiB cap
  });

  it("custom routes override defaults and hits are recorded", async () => {
    pages.setRoute("/page", { status: 503, body: "down" });
    expect((await fetch(`${pages.url}/page`)).status).toBe(503);
    expect(pages.hits.filter((h) => h.startsWith("/page")).length).toBeGreaterThan(0);
  });
});
