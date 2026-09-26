import { afterEach, describe, expect, it, vi } from "vitest";
import { brave } from "./brave";
import { ddg } from "./ddg";
import { tavily } from "./tavily";

const savedBrave = process.env.BRAVE_SEARCH_API_KEY;
const savedTavily = process.env.TAVILY_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedBrave === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = savedBrave;
  if (savedTavily === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = savedTavily;
});

function stubFetch(body: unknown, ok = true) {
  const calls: { input: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: ok ? 200 : 500 });
  });
  return calls;
}

const signal = new AbortController().signal;

describe("availability follows env keys", () => {
  it("brave/tavily need their keys; ddg never does", () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.TAVILY_API_KEY;
    expect(brave.available()).toBe(false);
    expect(tavily.available()).toBe(false);
    expect(ddg.available()).toBe(true);
    process.env.BRAVE_SEARCH_API_KEY = "bk";
    process.env.TAVILY_API_KEY = "tk";
    expect(brave.available()).toBe(true);
    expect(tavily.available()).toBe(true);
  });
});

describe("brave adapter", () => {
  it("sends the token header and maps results", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "bk";
    const calls = stubFetch({ web: { results: [{ title: "A <strong>title</strong>", url: "https://a.example/", description: "desc &amp; more" }] } });
    const results = await brave.search("q one", signal);
    expect(calls[0].input).toContain("https://api.search.brave.com/res/v1/web/search?q=q%20one");
    expect((calls[0].init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("bk");
    expect(results).toEqual([{ title: "A title", url: "https://a.example/", snippet: "desc & more" }]);
  });

  it("throws on a non-2xx response", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "bk";
    stubFetch({}, false);
    await expect(brave.search("q", signal)).rejects.toThrow(/Brave search failed \(500\)/);
  });
});

describe("tavily adapter", () => {
  it("POSTs the api_key in the body and maps results", async () => {
    process.env.TAVILY_API_KEY = "tk";
    const calls = stubFetch({ results: [{ title: "T", url: "https://t.example/", content: "clean extract" }] });
    const results = await tavily.search("q", signal);
    expect(calls[0].input).toBe("https://api.tavily.com/search");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ api_key: "tk", query: "q" });
    expect(results).toEqual([{ title: "T", url: "https://t.example/", snippet: "clean extract" }]);
  });
});

describe("ddg adapter", () => {
  it("parses the html results page and decodes uddg redirect urls", async () => {
    const html = `
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=x">Example <b>Page</b></a>
      <a rel="nofollow" class="result__a" href="https://plain.example/">Plain</a>
    `;
    stubFetch(html);
    const results = await ddg.search("q", signal);
    expect(results.map((r) => r.url)).toEqual(["https://example.com/page", "https://plain.example/"]);
    expect(results[0].title).toBe("Example Page");
  });

  it("throws on a non-2xx response", async () => {
    stubFetch("", false);
    await expect(ddg.search("q", signal)).rejects.toThrow(/Search failed \(500\)/);
  });
});
