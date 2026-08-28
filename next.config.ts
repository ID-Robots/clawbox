import type { NextConfig } from "next";
import { execSync } from "child_process";

const isDev = process.env.NODE_ENV === "development";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://127.0.0.1:18789";
// LAN origins the box can reappear at after a network/hostname change —
// shared by connect-src (fetch probes) and img-src (the handoff overlays'
// <img> probes) so the two CSP directives can't drift apart.
const LOCAL_LAN_SOURCES = "http://*.local http://*.local:* https://*.local https://*.local:*";
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
  serverExternalPackages: ["better-sqlite3", "busboy", "sharp"],
  // sharp's native addon dlopen()s libvips at runtime, so Next's file tracing
  // — which follows `require`/`import` — never sees the shared object and
  // leaves it out of `.next/standalone`. The addon itself IS traced, which is
  // what makes the failure look so odd: the .node file is right there, and
  // loading it dies on `libvips-cpp.so.8.18.3: cannot open shared object file`.
  //
  // Nothing imported sharp before, so nothing noticed. The pet thumbnail route
  // does, so name the .so explicitly. Both libc variants are listed because the
  // trace is resolved at build time and a musl image would need the other one.
  // Never trace the runtime data directory into the standalone bundle.
  //
  // data/ holds the owner's live state — config, code projects, built webapps
  // — and it CHANGES WHILE THE BUILD RUNS. On 2026-08-26 a build died with
  // ENOENT on data/webapps/3d-shooter/index.html because the webapp was
  // deleted between the trace and the copy, and the box was left with no
  // standalone output at all: the site went down until the next build.
  //
  // Nothing needs it there. Every reader resolves data/ from CLAWBOX_ROOT as
  // an absolute path at runtime, so a copy inside .next/standalone would be a
  // stale duplicate even when the copy succeeded.
  outputFileTracingExcludes: {
    // No "./" prefix: Next matches these globs relative to the tracing root,
    // and "./data/**" silently matched nothing — the build kept dying on
    // data/webapps/<app>/index.html whenever a webapp was created or removed
    // while it ran.
    "*": ["data/**", "**/data/webapps/**", "**/data/code-projects/**"],
  },
  outputFileTracingIncludes: {
    "/setup-api/pets/thumb": [
      "./node_modules/@img/sharp-libvips-linux*/lib/**",
      "./node_modules/@img/sharp-linux*/lib/**",
    ],
  },
  allowedDevOrigins: ["http://clawbox.local"],
  devIndicators: false,
  compress: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
  async rewrites() {
    return {
      // Run before filesystem/pages check — proxy gateway paths.
      //
      // These are NOT edition-aware on purpose: rewrites are compiled into
      // .next/routes-manifest.json at BUILD time, but the edition is an
      // INSTALL-time property (install.sh builds via `su - clawbox`, which drops
      // CLAWBOX_EDITION from the environment, and it builds before the edition
      // lock is baked). A build-time gate would therefore bake the wrong answer
      // on a Hermes flash. The runtime gate lives in src/middleware.ts, which
      // runs *before* beforeFiles rewrites and 404s these paths on the Hermes
      // SKU (where the OpenClaw gateway is disabled+masked and would 502).
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
    // Origins allowed to embed this ClawBox in an iframe. The portal
    // (clawbox.com) mounts each linked device in an iframe on its
    // dashboard; extend via PORTAL_EMBED_ORIGINS=https://a,https://b.
    const portalEmbed = (process.env.PORTAL_EMBED_ORIGINS
      ?? "https://clawbox.com https://*.clawbox.com")
      .split(/[\s,]+/)
      .filter(Boolean);
    const frameAncestors = ["'self'", ...portalEmbed].join(" ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // X-Frame-Options is obsoleted by CSP frame-ancestors and only
          // understands a single origin, which can't express "self + portal".
          // We rely on frame-ancestors below to gate iframe embedding.
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            // `microphone=(self)` and nothing wider. Voice input in the chat
            // composer is a first-party feature of this UI, and a policy of
            // `microphone=()` disables it for the document itself: the browser
            // then answers getUserMedia with NotAllowedError even in a secure
            // context with the permission already granted, so the mic button
            // is a control that can never work. `self` restores it for this
            // origin only — a cross-origin frame still gets nothing unless the
            // embedder delegates AND this list names it, which it does not.
            // Camera and geolocation stay off: nothing in the UI asks for them.
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
              "style-src 'self' 'unsafe-inline'",
              // LOCAL_LAN_SOURCES in img-src: the WiFi/credentials handoff
              // overlays detect the box at its new address with an <img> probe
              // (fetch is CORS-blocked cross-origin), and without it the browser
              // CSP-blocks the probe before it leaves the page — the
              // auto-redirect never fires and users must follow the manual URL.
              `img-src 'self' data: blob: ${LOCAL_LAN_SOURCES}`,
              "font-src 'self'",
              // media-src is not inherited from img-src: without it media
              // falls back to default-src 'self', and a blob: <audio> — the
              // Voice tab's sample clip, fetched as WAV and played from an
              // object URL — is refused by every browser ("Media load rejected
              // by URL safety check") while the request itself succeeded.
              "media-src 'self' blob: data:",
              `connect-src 'self' ws: wss: ${LOCAL_LAN_SOURCES}`,
              // Allow code-server iframe and webapp iframes (same origin)
              `frame-src 'self' blob:`,
              `frame-ancestors ${frameAncestors}`,
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
