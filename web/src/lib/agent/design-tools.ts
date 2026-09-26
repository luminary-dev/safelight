import "server-only";
import { saveTheme } from "@/lib/db/sessions";
import type { ToolDef } from "./tools";

const MAX_PAGE_CHARS = 8000;

export const DESIGN_SYSTEM_PROMPT =
  "You are Safelight's design scout. Your job: explore the live internet for real visual references, then design UI themes grounded in what you find. " +
  "Use search_web to find sites, palettes, and typography worth studying, and fetch_page to read them — fetch_page also returns the hex colors and font families found in the page source. " +
  "Cite what inspired each choice. When a theme is ready, call save_theme with a short slug name, a one-line description, six colors (bg, surface, text, muted, accent, accentText — all hex), and fonts (display, body, mono). " +
  "Check contrast: text on bg and accentText on accent must be comfortably readable. Propose variations when asked, each as its own save_theme call.";

export function designToolDefs(): ToolDef[] {
  return [
    {
      name: "search_web",
      description: "Search the web. Returns titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The search query." } },
        required: ["query"],
      },
    },
    {
      name: "fetch_page",
      description: "Fetch a public web page. Returns its readable text plus every hex color and font-family found in the source.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "An http(s) URL." } },
        required: ["url"],
      },
    },
    {
      name: "save_theme",
      description: "Save a finished UI theme. It is stored on disk and shown to the user as a swatch card.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short kebab-case name, e.g. sea-glass." },
          description: { type: "string", description: "One line on the theme's mood and what inspired it." },
          colors: {
            type: "object",
            properties: {
              bg: { type: "string" },
              surface: { type: "string" },
              text: { type: "string" },
              muted: { type: "string" },
              accent: { type: "string" },
              accentText: { type: "string" },
            },
            required: ["bg", "surface", "text", "muted", "accent", "accentText"],
          },
          fonts: {
            type: "object",
            properties: { display: { type: "string" }, body: { type: "string" }, mono: { type: "string" } },
            required: ["display", "body"],
          },
        },
        required: ["name", "description", "colors", "fonts"],
      },
    },
  ];
}

/** Refuses URLs that could reach this machine or the local network. Exported for tests. */
export function guardUrl(raw: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs can be fetched.");
  const host = url.hostname.toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\.|^0\.|^10\.|^192\.168\.|^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host === "::1";
  if (privateHost) throw new Error("Local and private-network addresses cannot be fetched.");
  return url;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

const HEX_OK = /^#[0-9a-fA-F]{6}$/;

export async function executeDesignTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; note?: string }> {
  switch (name) {
    case "search_web": {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("Empty query.");
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "user-agent": "Mozilla/5.0 (Safelight design scout)" },
      });
      if (!res.ok) throw new Error(`Search failed (${res.status}).`);
      const html = await res.text();
      const results: { title: string; url: string; snippet: string }[] = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      for (const m of html.matchAll(re)) {
        if (results.length >= 8) break;
        let url = m[1];
        const uddg = url.match(/uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]);
        results.push({ title: stripHtml(m[2]), url, snippet: stripHtml(m[3] ?? "").slice(0, 240) });
      }
      return { result: { results }, note: `${results.length} results` };
    }
    case "fetch_page": {
      const url = guardUrl(args.url);
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Safelight design scout)", accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`The page returned ${res.status}.`);
      const type = res.headers.get("content-type") ?? "";
      if (!/text\/html|text\/plain|application\/xhtml/.test(type)) throw new Error(`Not a readable page (${type.split(";")[0]}).`);
      const html = (await res.text()).slice(0, 800 * 1024);
      const colors = [...new Set([...html.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()))].slice(0, 24);
      const fonts = [...new Set([...html.matchAll(/font-family:\s*['"]?([A-Za-z0-9 \-]+)/g)].map((m) => m[1].trim()))].slice(0, 12);
      return { result: { url: url.href, text: stripHtml(html).slice(0, MAX_PAGE_CHARS), colors, fonts }, note: `${colors.length} colors · ${fonts.length} fonts` };
    }
    case "save_theme": {
      const name = String(args.name ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      if (!name) throw new Error("Give the theme a short name.");
      const colors = (args.colors ?? {}) as Record<string, string>;
      for (const k of ["bg", "surface", "text", "muted", "accent", "accentText"]) {
        if (!HEX_OK.test(String(colors[k] ?? ""))) throw new Error(`colors.${k} must be a 6-digit hex like #84cc16.`);
      }
      const fonts = (args.fonts ?? {}) as Record<string, string>;
      const theme = {
        name,
        description: String(args.description ?? "").slice(0, 200),
        colors: Object.fromEntries(["bg", "surface", "text", "muted", "accent", "accentText"].map((k) => [k, String(colors[k]).toLowerCase()])),
        fonts: { display: String(fonts.display ?? ""), body: String(fonts.body ?? ""), mono: String(fonts.mono ?? "") },
        savedAt: Date.now(),
      };
      saveTheme(name, theme);
      return { result: { theme }, note: `saved ${name}` };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
