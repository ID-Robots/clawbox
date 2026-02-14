import type { NextConfig } from "next";

const GATEWAY_URL = "http://127.0.0.1:18789";

const nextConfig: NextConfig = {
  output: "standalone",
  compress: true,
  poweredByHeader: false,
  async rewrites() {
    return {
      // Run before filesystem/pages check — proxy gateway paths
      beforeFiles: [
        // Gateway API (must come before Next.js page resolution)
        {
          source: "/api/:path*",
          destination: `${GATEWAY_URL}/api/:path*`,
        },
        // Gateway static assets
        {
          source: "/assets/:path*",
          destination: `${GATEWAY_URL}/assets/:path*`,
        },
        // Gateway favicons
        {
          source: "/favicon.svg",
          destination: `${GATEWAY_URL}/favicon.svg`,
        },
        {
          source: "/favicon-32.png",
          destination: `${GATEWAY_URL}/favicon-32.png`,
        },
      ],
      afterFiles: [],
      // Fallback: anything not matched by Next.js → proxy to gateway
      fallback: [
        {
          source: "/:path*",
          destination: `${GATEWAY_URL}/:path*`,
        },
      ],
    };
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
