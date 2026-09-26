import { http, HttpResponse, type HttpHandler } from "msw";
import { sendJson, startFakeServer, type FakeServer } from "./http";

/**
 * Two halves, matching how the search subsystem reaches the network:
 *
 * 1) searchApiHandlers(script) — MSW handlers for the three hardcoded search
 *    hosts (Brave, Tavily, DuckDuckGo HTML), returning each provider's real
 *    response shape. Scriptable per provider: results or an HTTP error.
 *
 * 2) startPageServer() — a real 127.0.0.1 http server for fetch_page tests:
 *    an HTML page with hex colors and font-families, a redirect chain, a
 *    redirect to an arbitrary target (e.g. a private address), a non-HTML
 *    response, and an oversized body.
 *
 * The "public hostname that resolves to loopback" case (DNS rebinding) cannot
 * be simulated by a URL alone: guardUrl() passes any non-private-looking name
 * and assertPublicHost() then does a real dns.lookup. A test that wants this
 * case must stub resolution itself, e.g.
 *   vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] }))
 * and fetch a name like "rebind.example". The page server cannot fake DNS for you.
 */

export interface SearchScript {
  brave?: { results?: { title: string; url: string; description: string }[]; status?: number };
  tavily?: { results?: { title: string; url: string; content: string }[]; status?: number };
  ddg?: { results?: { title: string; url: string; snippet: string }[]; status?: number };
}

/** The Brave wire shape (descriptions carry <strong> highlights in real life). */
export function braveBody(results: { title: string; url: string; description: string }[]): Record<string, unknown> {
  return { query: { original: "q" }, web: { results } };
}

export function tavilyBody(results: { title: string; url: string; content: string }[]): Record<string, unknown> {
  return { query: "q", results, response_time: 0.42 };
}

/** DuckDuckGo's HTML results page, with the uddg= redirect wrapping real DDG uses. */
export function ddgHtml(results: { title: string; url: string; snippet: string }[]): string {
  const items = results
    .map(
      (r) => `
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}&amp;rut=abc123">${r.title}</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}">${r.snippet}</a>
  </div>`,
    )
    .join("\n");
  return `<!DOCTYPE html><html><head><title>q at DuckDuckGo</title></head><body><div id="links" class="results">${items}</div></body></html>`;
}

const DEFAULT_RESULTS = [
  { title: "Result <strong>one</strong>", url: "https://example.com/one", description: "First &amp; finest" },
  { title: "Result two", url: "https://example.com/two", description: "Second" },
];

export function searchApiHandlers(script: SearchScript = {}): HttpHandler[] {
  return [
    http.get("https://api.search.brave.com/res/v1/web/search", () => {
      const s = script.brave ?? {};
      if (s.status) return HttpResponse.json({ error: "scripted" }, { status: s.status });
      return HttpResponse.json(braveBody(s.results ?? DEFAULT_RESULTS));
    }),
    http.post("https://api.tavily.com/search", () => {
      const s = script.tavily ?? {};
      if (s.status) return HttpResponse.json({ error: "scripted" }, { status: s.status });
      return HttpResponse.json(tavilyBody(s.results ?? DEFAULT_RESULTS.map((r) => ({ title: r.title, url: r.url, content: r.description }))));
    }),
    http.get("https://html.duckduckgo.com/html/", () => {
      const s = script.ddg ?? {};
      if (s.status) return new HttpResponse("scripted error", { status: s.status });
      const results = s.results ?? DEFAULT_RESULTS.map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
      return new HttpResponse(ddgHtml(results), { headers: { "content-type": "text/html" } });
    }),
  ];
}

// ---------------------------------------------------------------------------
// Page server

export const SAMPLE_PAGE_HTML = `<!DOCTYPE html>
<html><head>
<title>Sea Glass Studio</title>
<style>
  body { background: #0a1628; color: #e2e8f0; font-family: 'Inter', sans-serif; }
  .accent { color: #84cc16; }
  h1 { font-family: 'Fraunces', serif; }
</style>
</head><body>
<h1>Sea Glass</h1>
<p class="accent">A palette worth studying: #84cc16 on #0a1628.</p>
<script>console.log("ignored");</script>
</body></html>`;

export interface PageRoute {
  status?: number;
  contentType?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

export interface FakePageServer extends FakeServer {
  /** Overrides or adds a path. Defaults documented on startPageServer. */
  setRoute(path: string, route: PageRoute): void;
  /** Paths requested, in order. */
  hits: string[];
}

/**
 * Routes served out of the box:
 *   /page              HTML with hex colors (#84cc16, #0a1628, #e2e8f0) and fonts (Inter, Fraunces)
 *   /redirect/3        302 → /redirect/2 → /redirect/1 → /page (a 3-hop chain)
 *   /redirect-loop     302 → itself, forever (exceeds any hop limit)
 *   /redirect-to?url=… 302 → the given absolute URL (point it at a private address)
 *   /binary            content-type image/png (the non-HTML case)
 *   /huge              text/html, ~2 MB body (the oversized case)
 *   /plain             text/plain body
 */
export async function startPageServer(): Promise<FakePageServer> {
  const routes = new Map<string, PageRoute>();
  const hits: string[] = [];

  const base = await startFakeServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const p = url.pathname;
    hits.push(p + url.search);

    const custom = routes.get(p);
    if (custom) {
      res.writeHead(custom.status ?? 200, { "content-type": custom.contentType ?? "text/html; charset=utf-8", ...custom.headers });
      res.end(custom.body ?? "");
      return;
    }

    if (p === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SAMPLE_PAGE_HTML);
      return;
    }
    const chain = /^\/redirect\/(\d+)$/.exec(p);
    if (chain) {
      const n = Number(chain[1]);
      res.writeHead(302, { location: n > 1 ? `/redirect/${n - 1}` : "/page" });
      res.end();
      return;
    }
    if (p === "/redirect-loop") {
      res.writeHead(302, { location: "/redirect-loop" });
      res.end();
      return;
    }
    if (p === "/redirect-to") {
      res.writeHead(302, { location: url.searchParams.get("url") ?? "/page" });
      res.end();
      return;
    }
    if (p === "/binary") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (p === "/huge") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // ~2 MB — comfortably past fetch_page's 800 KiB read cap.
      const block = `<p>${"padding ".repeat(1000)}</p>\n`;
      for (let written = 0; written < 2 * 1024 * 1024; written += block.length) res.write(block);
      res.end();
      return;
    }
    if (p === "/plain") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("just text");
      return;
    }
    sendJson(res, 404, { error: `no page route for ${p}` });
  });

  return {
    ...base,
    hits,
    setRoute: (path, route) => {
      routes.set(path, route);
    },
  };
}
