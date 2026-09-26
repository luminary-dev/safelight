import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Required so next-intl resolves the request config (src/i18n/request.ts):
// without it, NextIntlClientProvider/getTranslations throw on the server.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  // Native modules and worker-thread users: load from node_modules at runtime instead of bundling.
  serverExternalPackages: ["better-sqlite3", "sharp", "pino"],
  // Explicit so a stray flag can never silently disable the gate. Lint runs separately in `pnpm verify`.
  typescript: { ignoreBuildErrors: false },
  headers: async () => {
    const dev = process.env.NODE_ENV !== "production";
    // The inline pre-paint theme script needs 'unsafe-inline'; dev HMR needs eval and websockets.
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
