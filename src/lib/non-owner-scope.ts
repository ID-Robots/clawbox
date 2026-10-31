// What a signed-in ClawBox user who is NOT the owner may reach.
//
// EVERYTHING THE OWNER GETS, with four exceptions. Every ClawBox user signs
// in with their own Linux password and gets the same desktop as the owner:
// every built-in and installed app, Files, the browser, the coding agent, the
// app store, the remote desktop, Prime Radiant, Memory Shard — and Settings.
// What stays the owner's:
//
//   1. The owner's chat. Each user has their own main conversation, tabs and
//      history instead (src/lib/chat-scope.ts) — scoped in the chat routes,
//      and on the gateway socket by production-server.js's relay
//      (scripts/gateway-user-relay.js). The harnesses' own consoles list every
//      conversation on the box, so they stay the owner's: the gateway's
//      Control UI and its HTTP trees (`/api`, `/assets`, `/__openclaw__`,
//      `/avatar`, the catch-all pages), and the Hermes dashboard (its own
//      proxy, scripts/hermes-dashboard-proxy.js). A user's chat still reaches
//      the pictures the agent sent in THEIR conversation
//      (`/api/chat/media/outgoing/<their key>/…`).
//   2. Secrets in clear. The gateway's shared token is never handed to a user
//      (`/setup-api/gateway` injects it into the Control UI page;
//      `gateway/ws-config` answers a user without it), and the routes that
//      would show a key, token or password show it masked to them.
//   3. The owner's account itself: its password and the factory reset that
//      wipes it. Removing the owner is refused for everyone
//      (src/lib/clawbox-users.ts).
//   4. The box's AI settings. Which model the whole box chats on, its
//      providers and their sign-ins, its assistant, its local AI engines, its
//      cloud defaults, its voice and its transcription are ONE setting for
//      everybody on the box, so a user reads them like the owner — the
//      desktop and Settings show them — and only the owner changes them: a
//      user's WRITE to `BOX_AI_SETTINGS_API` answers 403. A user's first
//      desktop load used to move the owner's chat model, because the chat's
//      own model migration posted `/setup-api/chat/model` for them. Their own
//      chat, its spoken replies and the local engines' inference stay theirs.
//
// A DENY-list now, where it used to be an allow-list of the four per-user
// surfaces a non-owner had: the exceptions are what is named, and a route
// added later is the owner's desktop for every user, like everything else.
//
// THE OWNER MAY SHARE OPENCLAW. "Share OpenClaw with all users" (Settings →
// Users, `OPENCLAW_SHARED_KEY`, off unless the owner turns it on) hands the
// first exception's OpenClaw half to every signed-in user: its desktop app,
// its Control UI pages and HTTP trees, and the gateway token those pages carry.
// The owner is told as much beside the switch. Each user's own ClawBox chat
// stays theirs either way — it goes on through the relay on its own socket
// path (`USER_CHAT_WS_PATH`) — and the Hermes dashboard and the owner's
// account are never shared.
//
// Pure (no `fs`, no Next) so middleware.test.ts and non-owner-scope.test.ts
// judge exactly the table middleware uses.

import { mayUseChatKey } from "./chat-scope";

/**
 * Desktop apps that are the owner's alone: the harnesses' own consoles, which
 * list (and open) every conversation on the box. Every other app is every
 * signed-in user's.
 */
export const OWNER_ONLY_APP_IDS: readonly string[] = ["openclaw", "hermes"];

/** The one owner-only app the owner can share (see the header). */
export const SHAREABLE_OPENCLAW_APP_ID = "openclaw";

/**
 * The owner's "Share OpenClaw with all users" switch in data/config.json.
 * Mirrored in production-server.js, which reads config.json itself because
 * socket upgrades never reach Next (a unit test pins the two together).
 */
export const OPENCLAW_SHARED_KEY = "openclaw_shared_with_users";

/**
 * The socket path of a ClawBox user's own chat: always relayed, so it reaches
 * only their own conversations whether or not the owner shares OpenClaw (the
 * root path is then the shared Control UI's). Mirrored in production-server.js.
 */
export const USER_CHAT_WS_PATH = "/user-chat-ws";

/** Only a literal `true` shares: anything else — absent, a string, a corrupt file — is the owner's. */
export function openclawSharedFrom(value: unknown): boolean {
  return value === true;
}

/** The owner-only apps a non-owner's desktop hides, given the owner's switch. */
export function ownerOnlyAppIds(openclawShared: boolean): readonly string[] {
  return openclawShared ? OWNER_ONLY_APP_IDS.filter((id) => id !== SHAREABLE_OPENCLAW_APP_ID) : OWNER_ONLY_APP_IDS;
}

/** The owner's account: its password, and the factory reset that wipes it. */
const OWNER_ACCOUNT_API: ReadonlySet<string> = new Set([
  "/setup-api/system/credentials",
  "/setup-api/system/credentials/verify",
  "/setup-api/setup/reset",
]);

/** Routes whose answer IS a secret only the owner holds: the Control UI page with the gateway token in it. */
const OWNER_SECRET_API: ReadonlySet<string> = new Set([
  "/setup-api/gateway",
]);

/**
 * The box's AI settings (the header's fourth exception): a WRITE to one of
 * these is the owner's; reading them is everybody's. Exact paths, so the local
 * engines' inference (`/setup-api/local-ai/<engine>/…`) and the speech a
 * user's chat plays (`/setup-api/tts/speak`, `/sample`, `/warm`) stay theirs.
 */
const BOX_AI_SETTINGS_API: ReadonlySet<string> = new Set([
  "/setup-api/chat/model",
  "/setup-api/harness/swap",
  "/setup-api/hermes/provider-key",
  "/setup-api/hermes/models",
  "/setup-api/hermes/clawai",
  "/setup-api/local-ai",
  "/setup-api/local-ai/exclusive",
  "/setup-api/local-models",
  "/setup-api/ollama/pull",
  "/setup-api/ollama/delete",
  "/setup-api/llamacpp/models",
  "/setup-api/llamacpp/install",
  "/setup-api/embed/install",
  "/setup-api/whisper",
  "/setup-api/ai-cloud-defaults",
  "/setup-api/tts",
  "/setup-api/tts/install",
  "/setup-api/stt",
]);

/** Trees where every write is one of the box's AI settings: model and provider config, sign-ins, account pools. */
const BOX_AI_SETTINGS_PREFIXES = [
  "/setup-api/ai-models",
  "/setup-api/providers",
  "/setup-api/anthropic",
  "/setup-api/hermes/oauth",
];

/** Standalone pages of the owner-only apps above. */
const OWNER_ONLY_PAGES: ReadonlySet<string> = new Set(OWNER_ONLY_APP_IDS.map((id) => `/app/${id}`));

/**
 * Where a non-owner's navigation to an owner page lands: the desktop, told why
 * (src/app/page.tsx reads the `notice` and shows `users.ownerOnlyPage`).
 */
export const OWNER_ONLY_NOTICE = "owner-only";
export const NON_OWNER_HOME = `/?notice=${OWNER_ONLY_NOTICE}`;

/** The gateway's own trees: the owner's however the file ends. */
const GATEWAY_PREFIXES = ["/api", "/assets", "/__openclaw__", "/avatar"];
const CHAT_MEDIA_OUTGOING_PREFIX = "/api/chat/media/outgoing/";

/**
 * ClawBox's own pages. Any other page address is the gateway's catch-all
 * (src/app/[...gateway]) — its Control UI — and is the owner's.
 */
const CLAWBOX_PAGE_PREFIXES = ["/login", "/setup", "/updating", "/portal", "/app", "/apps"];

/**
 * Files out of public/ the desktop draws or installs: media by extension,
 * and the web app's own manifest and service worker. Any other file at the
 * root falls through to the gateway's catch-all, which is the owner's.
 */
const STATIC_MEDIA_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp3|wav|ogg|webm|mp4)$/i;
const CLAWBOX_PUBLIC_FILES: ReadonlySet<string> = new Set(["/manifest.json", "/sw.js"]);

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
  /** Who is asking: the media of their own chat is theirs. */
  username: string;
  /** The owner shares OpenClaw (`OPENCLAW_SHARED_KEY`); absent is not shared. */
  openclawShared?: boolean;
}

const SHARED_OPENCLAW_PAGE = `/app/${SHAREABLE_OPENCLAW_APP_ID}`;

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** `/settings`, `/app/files` — a page address, as opposed to `/config.json` or `/x.js`. */
function looksLikePage(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".");
}

/** A picture the agent sent in one of THIS user's own conversations. */
function isOwnChatMedia(pathname: string, username: string): boolean {
  if (!pathname.startsWith(CHAT_MEDIA_OUTGOING_PREFIX)) return false;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(CHAT_MEDIA_OUTGOING_PREFIX.length).split("/")[0] ?? "");
  } catch {
    return false;
  }
  return mayUseChatKey({ username, isOwner: false }, key);
}

/** The answer for an owner-only page: the desktop for a person, a 403 for code. */
function ownerPage(req: NonOwnerRequest): NonOwnerVerdict {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return "deny";
  if (req.intent === "navigation") return "redirect-home";
  // A page address asked for without saying what is wanted is treated as the
  // navigation it almost always is: the redirect serves nothing either way, and
  // a raw JSON 403 in a browser tab is no answer for a person.
  return req.intent === "unknown" ? "redirect-home" : "deny";
}

/**
 * The path as a router may still resolve it: escapes decoded, case folded,
 * repeated and trailing slashes dropped. The exceptions are matched on THIS,
 * so none of them is dodged by spelling — middleware judges API paths as
 * typed and never strips their trailing slash (`/setup-api/gateway/` reaches
 * the same handler as `/setup-api/gateway`). Null for a path that does not
 * decode, which is refused.
 */
function canonicalPath(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  path = path.toLowerCase().replace(/\/{2,}/g, "/");
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

export function nonOwnerVerdict(req: NonOwnerRequest): NonOwnerVerdict {
  const { pathname } = req;
  const method = req.method.toUpperCase();
  const isRead = method === "GET" || method === "HEAD";
  const canon = canonicalPath(pathname);
  if (canon === null) return "deny";
  const shared = req.openclawShared === true;

  // The exceptions first, on the canonical path.
  if (OWNER_ACCOUNT_API.has(canon)) return "deny";
  if (!isRead && (BOX_AI_SETTINGS_API.has(canon) || BOX_AI_SETTINGS_PREFIXES.some((p) => underPrefix(canon, p)))) {
    return "deny";
  }
  // The Control UI page with the token in it: shared with the rest of OpenClaw.
  if (OWNER_SECRET_API.has(canon)) return shared ? "allow" : "deny";
  // API trees answer code, so they answer 403 JSON however they are asked.
  if (GATEWAY_PREFIXES.some((p) => underPrefix(canon, p))) {
    if (shared) return "allow";
    return isRead && isOwnChatMedia(pathname, req.username) ? "allow" : "deny";
  }
  if (OWNER_ONLY_PAGES.has(canon)) return shared && canon === SHARED_OPENCLAW_PAGE ? "allow" : ownerPage(req);

  if (underPrefix(pathname, "/setup-api")) return "allow";

  if (pathname === "/" || CLAWBOX_PAGE_PREFIXES.some((p) => underPrefix(pathname, p))) return "allow";

  // What is left is a file out of public/, or the gateway's catch-all — its
  // Control UI's pages and files, which are the owner's.
  if (STATIC_MEDIA_RE.test(pathname) || CLAWBOX_PUBLIC_FILES.has(pathname)) return isRead ? "allow" : "deny";
  // The catch-all IS the Control UI, so a shared one is the user's like the rest.
  if (shared) return "allow";
  if (!looksLikePage(pathname)) return "deny";
  return ownerPage(req);
}
