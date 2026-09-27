// What a signed-in ClawBox user who is NOT the owner may reach — TASK-1256.
//
// An ALLOW-list, like the bootstrap gate in src/lib/setup-api-gate.ts and for
// the same reason: ~100 routes were written for exactly one person, the owner,
// and a deny-list would serve every route nobody remembered to name. So a
// non-owner gets only the surfaces that are scoped per user today:
//
//   * the desktop page itself, rendered with the owner-only apps hidden;
//   * the Terminal — /terminal-ws is proxied by production-server.js, which
//     starts the shell AS the logged-in Linux user (scripts/terminal-server.mjs
//     through config/clawbox-user-helper.sh), never as the owner;
//   * who they are (`users/me`), the box's language and their terminal
//     settings to read, the public setup status and the update status the
//     /updating page polls.
//
// Everything else — Settings, the assistant and its gateway, Files, the
// coding agent, the app store, VNC — runs as the owner's Linux account or
// changes the whole box, cannot be scoped per user yet, and stays owner-only:
// 403 `owner_only` for code, a redirect to the desktop for a page.
//
// Pure (no `fs`, no Next) so middleware.test.ts and non-owner-scope.test.ts
// judge exactly the table middleware uses.

/** The desktop apps a non-owner is shown. Every other app is the owner's (see the header above). */
export const NON_OWNER_APP_IDS: readonly string[] = ["terminal"];

/** Preference keys a non-owner may READ. Writes stay owner-only: preferences are box-wide. */
export const NON_OWNER_READABLE_PREF_KEYS: ReadonlySet<string> = new Set([
  "ui_language",
  "terminal_settings",
]);

/** /setup-api reads (GET/HEAD) a non-owner may make, by exact path. */
const NON_OWNER_API_READS: ReadonlySet<string> = new Set([
  "/setup-api/users/me",
  "/setup-api/setup/status",
  "/setup-api/terminal/shells",
  "/setup-api/update/status",
]);

/** Pages a non-owner may open. Any other page navigation is sent to the desktop. */
const NON_OWNER_PAGES: ReadonlySet<string> = new Set(["/", "/updating", "/app/terminal"]);

/**
 * Static media the desktop draws (wallpapers, pet sprites, icons, fonts) —
 * never a script, stylesheet or JSON document, because a path that is not a
 * file in public/ falls through to the gateway catch-all, and the gateway is
 * the owner's.
 */
const STATIC_MEDIA_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp3|wav|ogg|webm|mp4)$/i;

/** The gateway's own trees: owner-only however the file ends. */
const GATEWAY_PREFIXES = ["/api", "/assets", "/__openclaw__", "/avatar"];

export type NonOwnerVerdict = "allow" | "deny" | "redirect-home";

export interface NonOwnerRequest {
  /** The RAW pathname — the string the router will route, not a case-folded copy. */
  pathname: string;
  method: string;
  searchParams: URLSearchParams;
  /** A top-level navigation or frame, as opposed to a fetch a page makes. */
  isDocument: boolean;
}

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** `GET /setup-api/preferences?keys=a,b` where every key is one a non-owner may read — and nothing else. */
function isReadablePreferenceQuery(params: URLSearchParams): boolean {
  const names = [...new Set([...params.keys()])];
  if (names.length !== 1 || names[0] !== "keys") return false;
  const values = params.getAll("keys");
  if (values.length !== 1) return false;
  const keys = values[0].split(",").map((k) => k.trim());
  return keys.length > 0 && keys.every((k) => NON_OWNER_READABLE_PREF_KEYS.has(k));
}

export function nonOwnerVerdict(req: NonOwnerRequest): NonOwnerVerdict {
  const { pathname } = req;
  const method = req.method.toUpperCase();
  const isRead = method === "GET" || method === "HEAD";

  if (underPrefix(pathname, "/setup-api")) {
    if (!isRead) return "deny";
    if (NON_OWNER_API_READS.has(pathname)) return "allow";
    if (pathname === "/setup-api/preferences" && isReadablePreferenceQuery(req.searchParams)) return "allow";
    return "deny";
  }

  if (GATEWAY_PREFIXES.some((p) => underPrefix(pathname, p))) return "deny";

  if (NON_OWNER_PAGES.has(pathname)) return isRead ? "allow" : "deny";

  if (req.isDocument) return isRead ? "redirect-home" : "deny";

  if (isRead && STATIC_MEDIA_RE.test(pathname)) return "allow";

  return "deny";
}
