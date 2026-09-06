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
  // Next's own trailing-slash redirect (`/x/` → 308 `/x`) is switched off
  // so `/apps/<id>/` — the base path a proxied app is served under, which
  // a Vite dev server insists on with the slash — reaches the proxy as
  // typed; the middleware keeps that redirect for every other path.
  skipTrailingSlashRedirect: true,
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
  //
  // How wide the instrumentation half is, measured on Next 16.3.3 (TASK-725):
  // src/instrumentation-node.ts resolves path.join(CONFIG_ROOT, 'scripts',
  // 'terminal-server.mjs') and CONFIG_ROOT is read from the environment
  // (src/lib/config-store.ts), so @vercel/nft cannot resolve it and emits the
  // WHOLE project directory as an asset directory. instrumentation.js.nft.json
  // listed 6186 files — src/, scripts/, bench/, docs-site/, e2e/, .git … and,
  // during an update, all 4202 files of the previous build parked at
  // `.next-old`. That is where `.next/standalone/.next-old/standalone/server.js`
  // comes from, which scripts/postbuild.sh now removes and refuses to mistake
  // for this build's entry. Narrowing the sweep is a separate change: parts of
  // it are load-bearing today (`.next/standalone/scripts` comes from it, and
  // system-profile.ts resolves scripts/ from the process cwd).
  //
  // `.git` is in that 6186-file list too — 88 MB of it on the OpenClaw box,
  // measured 2026-09-05. TASK-692 read next@16.3.3's own source and concluded
  // the `.git/**` key below reaches the instrumentation trace
  // (next-trace-entrypoints-plugin.js keys `entryNameFilesMap` by
  // `entrypoint.name` for every server-compiler entrypoint, collect-build-
  // traces.js iterates that map, and `picomatch("*", {dot,contains})` matches
  // "instrumentation"), while flagging that a real device build with the line
  // in place was NOT measured.
  //
  // It has been measured now (TASK-670), on a box building THIS branch's own
  // beta head, with the key below already in the checked-out config:
  //
  //   every `.next/server/app/**/*.nft.json`   data 0   .git 0
  //   .next/server/middleware.js.nft.json      data 27  .git 0
  //   .next/server/instrumentation.js.nft.json data 32  .git 701
  //
  // So the key reaches ROUTE entries and nothing else, exactly as the
  // paragraph above says, and the source reading does not survive contact with
  // a real build. `.git` is NOT excluded at the source: scripts/postbuild.sh
  // sweeping it afterwards — and failing the build when a copy survives — is
  // what actually keeps it out of the artifact, and is load-bearing rather
  // than belt-and-braces. The key stays because it does its job for the route
  // traces; do not read it as covering the other two.
  //
  // Its companion, the checkout's own `.env`, genuinely has no switch: Next
  // copies `.env` and `.env.production` ITSELF, AFTER the trace, in
  // writeStandaloneDirectory() (next/dist/build/index.js) — nothing on that
  // path reads this config. On a box that file is 0600 and holds
  // GOOGLE_OAUTH_CLIENT_SECRET and, where install.sh was given one,
  // CLAWBOX_AI_API_KEY, so the copy is removed from the build artifact and its
  // survival fails the build. Nothing loses by it: systemd hands the real file
  // to clawbox-setup as an EnvironmentFile and @next/env never overwrites a
  // variable that is already in the environment.
  outputFileTracingExcludes: {
    // No "./" prefix: Next matches these globs relative to the tracing root,
    // and "./data/**" silently matched nothing — the build kept dying on
    // data/webapps/<app>/index.html whenever a webapp was created or removed
    // while it ran.
    "*": ["data/**", "**/data/webapps/**", "**/data/code-projects/**", ".git/**"],
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
