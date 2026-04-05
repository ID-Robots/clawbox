import type { NextConfig } from "next";
import { execSync } from "child_process";

const isDev = process.env.NODE_ENV === "development";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:18789";
const CODE_SERVER_PORT = process.env.CODE_SERVER_PORT || "8080";
const CODE_SERVER_URL = `http://127.0.0.1:${CODE_SERVER_PORT}`;
// Git-based version: "v2.0.0" on tag, "v2.0.0-3-gca62836" after commits
const APP_VERSION = (() => {
  try {
    return execSync("git describe --tags --always", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
})();

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "busboy"],
  allowedDevOrigins: ["http://clawbox.local"],
  devIndicators: false,
  compress: true,
  poweredByHeader: false,
  experimental: {
    // Default is 10MB — raise to match available disk space (no in-memory buffering)
    proxyClientMaxBodySize: 500 * 1024 * 1024 * 1024,
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
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
      afterFiles: [
        // Proxy code-server through same origin (avoids port/CSP/CORS issues)
        {
          source: "/code-server/:path*",
          destination: `${CODE_SERVER_URL}/:path*`,
        },
      ],
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
            value: [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "connect-src 'self' ws: wss:",
              // Allow code-server iframe and webapp iframes (same origin)
              `frame-src 'self' blob:`,
              "frame-ancestors 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
