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
  // Keep the runtime data directory out of the ROUTE traces — and know what
  // that does and does not buy.
  //
  // data/ holds the owner's live state — config, code projects, built webapps
  // — and it CHANGES WHILE THE BUILD RUNS. On 2026-08-26 a build died with
  // ENOENT on data/webapps/3d-shooter/index.html because the webapp was
  // deleted between the trace and the copy, and the box was left with no
  // standalone output at all: the site went down until the next build.
  //
  // Nothing needs it there either. Every reader resolves data/ from
  // CLAWBOX_ROOT (or the absolute /home/clawbox/clawbox default) at runtime,
  // so a copy inside .next/standalone is a stale duplicate even when the copy
  // succeeded.
  //
  // THIS EXCLUDE ONLY REACHES ROUTES, so data/ IS still traced into the
  // standalone bundle and the postbuild step in package.json is what removes
  // it. Next applies outputFileTracingExcludes per route entry; the middleware
  // and instrumentation traces are built separately and NO key reaches them.
  // Measured on Next 16.3.3 with a minimal app: with the exclude below, a
  // route's .nft.json is cleaned of data/ while middleware.js.nft.json keeps
  // its `../../data/config.json` entry and .next/standalone/data is created
  // anyway — and "*" vs "**" vs "middleware" vs "/middleware" changes nothing.
  // So do not "fix the glob" here: it already does its job, which is the route
  // half of the ENOENT hazard above. The middleware and instrumentation halves
  // are still open — Next copies those two traces with no error handling,
  // where the page traces are wrapped — and closing them means keeping the
  // paths out of the trace at the source, not another glob.
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
      // /api/*, /assets/* and the two gateway favicons are NOT rewritten here
      // any more. Next's rewrite proxy stamps its own x-forwarded-* headers on
      // the hop, and OpenClaw 2 answers 403 proxy_attribution_required to
      // forwarded attribution from an address it was not told to trust — which
      // 403'd every Control UI asset and left the OpenClaw app a blank dark
      // panel. They are route handlers now (src/app/api, src/app/assets,
      // src/app/favicon.svg, src/app/favicon-32.png) which proxy through
      // proxyGatewayRequest() with that header family stripped, the same way
      // production-server.js already handled WebSocket upgrades.
      //
      // Middleware still runs first either way (it precedes beforeFiles
      // rewrites AND route handlers), so the Hermes 404 gate and the auth gate
      // on these paths are unchanged.
      beforeFiles: [],
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
        // Everything but /apps/<id>/…: a project's own server proxied there
        // (src/lib/app-proxy.ts) answers with its own headers plus the
        // sandbox the proxy adds, and the desktop's script-src would refuse
        // a dev server's eval'd source maps.
        source: "/((?!apps/).*)",
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
              // Frames: code-server and the sandboxed webapp iframes are
              // same-origin, but an app the coding agent builds with its own
              // server (a Next.js app on :4199, a game with pointer lock) is
              // reached on the box's OWN HOST at that port — and that host is
              // whatever the owner typed: a LAN IP, clawbox.local, 10.42.0.1,
              // the tunnel. A static header cannot name it, and `'self'`
              // excludes every other port, so the desktop window showed
              // "This content is blocked" over a running app. The scheme
              // sources let those frames load; what protects the desktop is
              // the iframe sandbox (an opaque origin, no allow-same-origin —
              // src/lib/webapp-sandbox.ts), not this list.
              `frame-src 'self' blob: http: https:`,
              `frame-ancestors ${frameAncestors}`,
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
