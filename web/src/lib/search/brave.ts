import "server-only";
import type { SearchProvider, SearchResult } from "./types";

/** Brave descriptions embed <strong> highlights; results should be plain text. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m] ?? " ")
    .trim();
}

/** Brave Search API — independent index, keyed via BRAVE_SEARCH_API_KEY. Preferred provider. */
export const brave: SearchProvider = {
  id: "brave",
  available: () => Boolean(process.env.BRAVE_SEARCH_API_KEY),
  async search(query, signal): Promise<SearchResult[]> {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
      headers: { "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY ?? "", accept: "application/json" },
      signal,
    });
    if (!res.ok) throw new Error(`Brave search failed (${res.status}).`);
    const body = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (body.web?.results ?? [])
      .filter((r) => typeof r.url === "string" && r.url)
      .map((r) => ({ title: stripTags(r.title ?? ""), url: r.url as string, snippet: stripTags(r.description ?? "").slice(0, 240) }));
  },
};
