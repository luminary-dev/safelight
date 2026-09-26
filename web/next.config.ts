import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Explicit so a stray flag can never silently disable the gate. Lint runs separately in `pnpm verify`.
  typescript: { ignoreBuildErrors: false },
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    },
  ],
};

export default nextConfig;
