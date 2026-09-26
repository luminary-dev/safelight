/**
 * Shared harness for the `component` (jsdom) project: a provider-wrapped render
 * (next-intl + tooltips, mirroring app/layout.tsx) and a strict fetch stub that
 * throws on any request no test declared, so nothing ever escapes jsdom.
 * Test-only — imported from *.test.tsx files.
 */
import { cleanup, render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import messages from "@/i18n/en.json";
import { resetFactorySequence } from "@/test/factories";

// ---------- jsdom gaps that Radix / cmdk / motion expect ----------
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  window.scrollTo = () => undefined;
  // Node's implementations reject jsdom Files; object URLs are cosmetic in tests.
  URL.createObjectURL = () => "blob:safelight-test";
  URL.revokeObjectURL = () => undefined;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => undefined;
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => undefined;
}

// Vitest runs without globals, so Testing Library cannot auto-register cleanup.
afterEach(() => cleanup());

beforeEach(() => {
  localStorage.clear();
  resetFactorySequence();
  // Any fetch a test did not declare fails the test loudly (sync throw, not a rejection).
  vi.stubGlobal("fetch", (input: unknown) => {
    throw new Error(`Unstubbed fetch in test: ${String(input)}`);
  });
});

// ---------- providers (mirrors app/layout.tsx) ----------

function Providers({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
    </NextIntlClientProvider>
  );
}

/** render() wrapped in the same providers the app shell supplies. */
export function renderApp(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">): RenderResult {
  return render(ui, { wrapper: Providers, ...options });
}

export { Providers as AppProviders };

// ---------- strict fetch stub ----------

export interface FetchCall {
  method: string;
  url: string;
  /** JSON-parsed request body when it was a JSON string, otherwise the raw body. */
  body: unknown;
}

export interface FetchRoute {
  /** Defaults to GET. */
  method?: string;
  /** A string matches the exact URL or `url?query`; a RegExp is tested against the full URL. */
  url: string | RegExp;
  /** A plain object becomes a 200 JSON response; use a function for status codes or streams. */
  reply: object | ((call: FetchCall) => Response | object | Promise<Response | object>);
}

/** A JSON Response; build a fresh one per reply — bodies are single-use. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/**
 * Replaces global fetch with a strict stub: requests must match a declared
 * route (first match wins) or the test fails. Returns the recorded calls.
 */
export function stubFetch(...routes: FetchRoute[]) {
  const calls: FetchCall[] = [];
  const matches = (r: FetchRoute, method: string, url: string) => {
    if ((r.method ?? "GET").toUpperCase() !== method) return false;
    return typeof r.url === "string" ? url === r.url || url.startsWith(`${r.url}?`) : r.url.test(url);
  };
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else {
      body = init?.body;
    }
    const call: FetchCall = { method, url, body };
    calls.push(call);
    const route = routes.find((r) => matches(r, method, url));
    if (!route) throw new Error(`Unexpected fetch in test: ${method} ${url}`);
    const replied = typeof route.reply === "function" ? await route.reply(call) : route.reply;
    return replied instanceof Response ? replied : json(replied);
  });
  vi.stubGlobal("fetch", mock);
  const of = (method: string, url: string | RegExp) =>
    calls.filter((c) => c.method === method.toUpperCase() && (typeof url === "string" ? c.url === url || c.url.startsWith(`${url}?`) : url.test(c.url)));
  return { calls, of, mock };
}

/** A hand-cranked NDJSON response: push events line by line, then close. */
export function ndjsonStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    push(event: object) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    close() {
      controller.close();
    },
  };
}
