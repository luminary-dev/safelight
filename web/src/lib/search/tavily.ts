import "server-only";
import type { SearchProvider, SearchResult } from "./types";

/** Tavily — LLM-optimised search, keyed via TAVILY_API_KEY. */
export const tavily: SearchProvider = {
  id: "tavily",
  available: () => Boolean(process.env.TAVILY_API_KEY),
  async search(query, signal): Promise<SearchResult[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY ?? "", query, max_results: 8 }),
      signal,
    });
    if (!res.ok) throw new Error(`Tavily search failed (${res.status}).`);
    const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (body.results ?? [])
      .filter((r) => typeof r.url === "string" && r.url)
      .map((r) => ({ title: r.title ?? "", url: r.url as string, snippet: (r.content ?? "").slice(0, 240) }));
  },
};
