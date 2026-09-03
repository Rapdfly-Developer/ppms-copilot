import type { NextConfig } from "next";

// PPMS Core is the only host allowed to embed this Copilot in an iframe.
// Never accept a wildcard — always specify the exact production origin.
const PPMS_ORIGIN = process.env.NEXT_PUBLIC_PPMS_ORIGIN ?? "https://ppmsai.com";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@anthropic-ai/sdk"],
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      // Browser fetch goes only to this project's own API routes
      "connect-src 'self'",
      // Only PPMS Core may embed us — no wildcards
      `frame-ancestors ${PPMS_ORIGIN}`,
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Clinical data endpoints: never cache
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
