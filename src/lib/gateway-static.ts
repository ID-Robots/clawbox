/**
 * Which paths are the OpenClaw Control UI's own static files.
 *
 * One list, read by two places that must agree:
 *   - src/middleware.ts, to let them load WITHOUT a session cookie;
 *   - src/app/[...gateway]/route.ts, to serve them as bytes rather than
 *     answering with the SPA shell.
 *
 * Why credential-less matters: the gateway links its stylesheet as
 * `<link rel="stylesheet" crossorigin href="…">`, and its lazy-panel loader
 * injects chunk links with `crossOrigin=""` too. `crossorigin` (anonymous)
 * omits credentials EVEN SAME-ORIGIN, so those requests arrive with no
 * `clawbox_session` cookie and an auth gate turns them into a redirect to
 * /login. Module scripts default to `same-origin` credentials, which is why
 * the JS always loaded and only styling broke.
 *
 * Why it is a prefix list and not "anything that looks like a file": these
 * prefixes are the gateway's, so opening them exposes the compiled front-end
 * of an open-source project and nothing else. A blanket extension rule would
 * also cover ClawBox's own routes.
 */

/** Directory trees the Control UI serves (kept with a trailing slash). */
const GATEWAY_STATIC_PREFIXES = [
  "/assets/",
  "/themes/",
  "/fonts/",
  "/file-icons/",
  "/provider-icons/",
  "/app-art/",
  "/plugin-art/",
];

/** Single files it serves from the root. */
const GATEWAY_STATIC_FILES = new Set([
  "/asset-manifest.json",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
]);

/**
 * Extensions a bundler emits. The gate is an allow-list so a static prefix
 * cannot become a general unauthenticated window onto the gateway.
 */
const STATIC_EXTENSIONS = [
  ".js", ".mjs", ".css", ".map", ".json", ".webmanifest",
  // The font OFL notices and provider-icon attribution live under these trees
  // and are the only files in them that are not a bundle.
  ".txt", ".md",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico",
];

/** True for a path under one of the gateway's static trees with a static extension. */
export function isGatewayStaticPath(pathname: string): boolean {
  if (GATEWAY_STATIC_FILES.has(pathname)) return true;
  if (!GATEWAY_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  const lower = pathname.toLowerCase();
  return STATIC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * True when this request may skip the session gate: a READ of a gateway static
 * file. Writes are never admitted, whatever the path looks like.
 */
export function isPublicGatewayAsset(pathname: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return isGatewayStaticPath(pathname);
}
