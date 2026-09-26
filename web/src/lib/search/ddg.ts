import "server-only";
import type { SearchProvider, SearchResult } from "./types";

// Moved verbatim from design-tools; ddg titles/snippets arrive as HTML fragments.
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** DuckDuckGo HTML scrape — keyless fallback of last resort; brittle by nature. */
export const ddg: SearchProvider = {
  id: "ddg",
  available: () => true,
  async search(query, signal): Promise<SearchResult[]> {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": "Mozilla/5.0 (Safelight design scout)" },
      signal,
    });
    if (!res.ok) throw new Error(`Search failed (${res.status}).`);
    const html = await res.text();
    const results: SearchResult[] = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    for (const m of html.matchAll(re)) {
      if (results.length >= 8) break;
      let url = m[1];
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      results.push({ title: stripHtml(m[2]), url, snippet: stripHtml(m[3] ?? "").slice(0, 240) });
    }
    return results;
  },
};
