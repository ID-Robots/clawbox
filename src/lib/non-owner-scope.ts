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
//     settings to read, the public setup status, the update status the
//     /updating page polls, and whether the box is online (the tray's dot —
//     `network/internet` answers `online`/`latencyMs` and nothing of the
//     network's configuration);
//   * their own open windows (`desktop/state`, TASK-1306) — read and written,
//     because the route keys the file on the SESSION's user, never the
//     request's, so there is nobody else's to reach.
//
// Everything else — Settings, the assistant and its gateway, Files, the
// coding agent, the app store, VNC — runs as the owner's Linux account or
// changes the whole box, cannot be scoped per user yet, and stays owner-only:
// 403 `owner_only` for code, a redirect to the desktop (with a notice) for a
// page.
//
// Pure (no `fs`, no Next) so middleware.test.ts and non-owner-scope.test.ts
// judge exactly the table middleware uses.

/** The desktop apps a non-owner is shown. Every other app is the owner's (see the header above). */
export const NON_OWNER_APP_IDS: readonly string[] = ["terminal"];

/**
 * The store-installed apps (skills and web apps) a desktop may offer ANYWHERE —
 * the icon grid, the launcher, the shelf and every openApp(id) path. They are
 * all the owner's, so a non-owner's desktop gets none of them. One rule, used
 * by both of page.tsx's lists, so the grid and the launcher cannot disagree.
 */
export function installedAppIdsFor(isOwner: boolean, installed: readonly string[]): readonly string[] {
  return isOwner ? installed : [];
}

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
  // `{ online, latencyMs, checkedAt }` from one cached ping — no interface,
  // SSID, address or credential. The tray drew "No internet" for everyone but
  // the owner while this was refused. src/tests/routes/network-internet.test.ts
  // pins the answer to those three fields, so the route cannot start carrying
  // network configuration without this line being looked at again.
  "/setup-api/network/internet",
  // Monitor mode: where each monitor of the row is, so another user's desktop
  // on the spread window lays its shelf and windows out per monitor too. The
  // route answers a non-owner only that (`desktopViewOf`: positions, labels,
  // the main monitor, the row's size) — no modes, no physical sizes, no trial
  // — and every write there stays the owner's.
  "/setup-api/monitors",
]);

/**
 * /setup-api paths a non-owner may READ AND WRITE (GET/HEAD/PUT), by exact
 * path. Only routes that are scoped to the session's own user belong here.
 */
const NON_OWNER_API_OWN_STATE: ReadonlySet<string> = new Set([
  "/setup-api/desktop/state",
]);

/** Pages a non-owner may open. Any other page navigation is sent to the desktop. */
const NON_OWNER_PAGES: ReadonlySet<string> = new Set(["/", "/updating", "/app/terminal"]);

/**
 * Where a non-owner's navigation to an owner page lands: the desktop, told why
 * (src/app/page.tsx reads the `notice` and shows `desktop.ownerOnlyNotice`).
 */
export const OWNER_ONLY_NOTICE = "owner-only";
export const NON_OWNER_HOME = `/?notice=${OWNER_ONLY_NOTICE}`;

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

/**
 * What a request says it wants back:
 *   - `navigation` — a page load or a frame (a person typing an address);
 *   - `fetch` — code asking for data or a subresource (fetch/XHR, an <img>, the
 *     Next router's RSC requests);
 *   - `unknown` — the request does not say (curl, a script, a browser that
 *     sends no Fetch Metadata — which is every browser on the box's plain-HTTP
 *     LAN address, since `Sec-Fetch-*` is only sent to secure origins).
 */
export type RequestIntent = "navigation" | "fetch" | "unknown";

const NAVIGATION_DESTS = new Set(["document", "iframe", "frame", "embed", "object"]);

/** Read a request's intent from its headers — Fetch Metadata first, then the Next router's marks, then Accept. */
export function requestIntent(headers: Headers): RequestIntent {
  const dest = headers.get("sec-fetch-dest");
  if (dest) return NAVIGATION_DESTS.has(dest) ? "navigation" : "fetch";
  if (headers.get("rsc") === "1" || headers.has("next-router-prefetch") || headers.has("next-action")) return "fetch";
  const accept = (headers.get("accept") ?? "").toLowerCase();
  if (accept.includes("text/html")) return "navigation";
  if (accept.includes("application/json")) return "fetch";
  return "unknown";
}

export interface NonOwnerRequest {
  /** The RAW pathname — the string the router will route, not a case-folded copy. */
  pathname: string;
  method: string;
  searchParams: URLSearchParams;
  /** See `requestIntent`. */
  intent: RequestIntent;
}

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** `/settings`, `/app/files` — a page address, as opposed to `/config.json` or `/x.js`. */
function looksLikePage(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".");
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
    if (NON_OWNER_API_OWN_STATE.has(pathname)) return isRead || method === "PUT" ? "allow" : "deny";
    if (!isRead) return "deny";
    if (NON_OWNER_API_READS.has(pathname)) return "allow";
    if (pathname === "/setup-api/preferences" && isReadablePreferenceQuery(req.searchParams)) return "allow";
    return "deny";
  }

  // API trees answer code, so they answer 403 JSON however they are asked —
  // a person who types /setup-api/users into the address bar reads the refusal.
  if (GATEWAY_PREFIXES.some((p) => underPrefix(pathname, p))) return "deny";

  if (NON_OWNER_PAGES.has(pathname)) return isRead ? "allow" : "deny";

  if (!isRead) return "deny";

  if (req.intent === "navigation") return "redirect-home";

  if (STATIC_MEDIA_RE.test(pathname)) return "allow";

  // A page address asked for without saying what is wanted is treated as the
  // navigation it almost always is: the redirect serves nothing either way, and
  // a raw JSON 403 in a browser tab is no answer for a person. Code that says it
  // is code (`fetch`) keeps the 403 it can read.
  if (req.intent === "unknown" && looksLikePage(pathname)) return "redirect-home";

  return "deny";
}
