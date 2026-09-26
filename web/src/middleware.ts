import { NextResponse, type NextRequest } from "next/server";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function allowedHosts(): Set<string> {
  const extra = (process.env.SAFELIGHT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set(["localhost", "127.0.0.1", "[::1]", ...extra]);
}

/** Hostname from a Host header. Bracketed IPv6 literals ("[::1]:3000") contain colons, so a plain split(":") would truncate them to "[". */
function hostHeaderName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  return h.split(":")[0];
}

/**
 * Two localhost-app defenses on every API route:
 * - Host allowlist, so DNS-rebinding pages cannot reach the API through a hostname they control.
 * - Origin check on mutating methods, so a hostile web page cannot CSRF renders, key writes, or
 *   file edits. Requests without an Origin (curl, scripts, same-origin GET) pass; browsers always
 *   send Origin on cross-site mutations.
 */
export function middleware(request: NextRequest) {
  const hostname = hostHeaderName(request.headers.get("host") ?? "");
  if (!allowedHosts().has(hostname)) {
    return NextResponse.json({ error: "This host is not allowed to reach the Safelight API." }, { status: 403 });
  }
  if (MUTATING.has(request.method)) {
    const origin = request.headers.get("origin");
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        return NextResponse.json({ error: "Malformed Origin header." }, { status: 403 });
      }
      if (!allowedHosts().has(originHost)) {
        return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
      }
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
