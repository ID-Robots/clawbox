// Organisation mode: a ClawBox that serves a company's staff.
//
// The owner is the company's administrator; every other ClawBox user
// (src/lib/session-identity.ts, Settings → System → Users) is a member of
// staff. With `org_mode` on, a member of staff gets three apps — Chat, Files
// and Settings — and in Settings only what is theirs: their language, their
// password and their appearance. Everything else on the box (the terminal,
// the coding agent, the stores, ClawKeep, Prime Radiant, Memory Shard, the
// agent's browser, the box's AI providers and models, its system, network,
// updates and users) is the owner's, and the server refuses it to them as
// well as the desktop hiding it. The owner keeps everything. The ClawBox AI
// offer cards are hidden for everybody, the owner included: on a company's box
// they are noise.
//
// OFF unless the owner turns it on (Settings → System → Users, or
// `POST /setup-api/settings/org-mode`), so a home box behaves as it always has.
// Only a literal `true` counts, like OPENCLAW_SHARED_KEY: a corrupt or
// hand-edited value is a home box, which is the state that hides nothing from
// the owner.
//
// Unlike the general non-owner rule (src/lib/non-owner-scope.ts, a DENY-list:
// a user gets the owner's desktop but for a few exceptions), this is an
// ALLOW-list. A route added to the box later is the owner's on an organisation
// box until it is named here — a member of staff is handed the surfaces this
// file lists and nothing it forgot.
//
// Pure (no `fs`, no Next): middleware.ts, production-server.js's mirror
// (scripts/org-mode.js, pinned by a unit test) and the desktop all judge the
// same table.

/** The switch in data/config.json. Mirrored in scripts/org-mode.js. */
export const ORG_MODE_KEY = "org_mode";

/** Only a literal `true` is an organisation box: absent, a string or a corrupt file is a home box. */
export function orgModeFrom(value: unknown): boolean {
  return value === true;
}

/**
 * The desktop apps a member of staff sees on an organisation box — Chat,
 * Files, Settings — on the desktop, the shelf and in the launcher. Every
 * other built-in app and every installed app is the owner's.
 */
export const ORG_USER_APP_IDS: readonly string[] = ["clawbox", "files", "settings"];

/** The built-in apps an organisation box hides from a member of staff, out of the full list. */
export function orgHiddenAppIds(allAppIds: readonly string[]): string[] {
  return allAppIds.filter((id) => !ORG_USER_APP_IDS.includes(id));
}

/**
 * The Settings sections a member of staff sees: their language and look
 * (`appearance`) and their own password (`account`). The box's AI, local AI,
 * channels, voice, network, remote access, system, updates, users and the
 * rest stay the owner's.
 */
export const ORG_USER_SETTINGS_SECTIONS: readonly string[] = ["appearance", "account"];

/** Who is looking at a desktop surface. `null`: not known yet, which draws as the owner's. */
export interface DesktopViewer {
  isOwner: boolean;
  orgMode: boolean;
}

/** A member of staff on an organisation box: the one person the org rules narrow. */
export function isOrgMember(viewer: DesktopViewer | null | undefined): boolean {
  return !!viewer && viewer.orgMode && !viewer.isOwner;
}

/**
 * Which of the desktop's notice cards a viewer may be shown.
 *
 *   - `update` — "Update available", and every update action behind it: the
 *     owner's alone, on every box. A member of staff never sees it (and the
 *     update routes answer them 403, src/lib/non-owner-scope.ts).
 *   - `whatsNew` — the "What's new" dialog after an update, which the box
 *     records as read for everyone once dismissed: the owner's alone too.
 *   - `clawAiOffer` — "Free backup with ClawBox AI / Login with ClawBox AI",
 *     and the other ClawBox AI upsells: nobody's on an organisation box.
 *
 * Until /users/me answers (`viewer` null/undefined) the desktop draws as the
 * owner's, exactly as a single-user box always has; the cards that depend on
 * the answer are held until then by the desktop's own `noticesHeld`.
 */
export function desktopNoticePolicy(viewer: DesktopViewer | null | undefined): {
  update: boolean;
  whatsNew: boolean;
  clawAiOffer: boolean;
} {
  const owner = !viewer || viewer.isOwner;
  const orgMode = !!viewer && viewer.orgMode;
  return { update: owner, whatsNew: owner, clawAiOffer: !orgMode };
}

// ─── The server's allow-list for a member of staff ──────────────────────────

/** Desktop pages a member of staff may open: the desktop, the update lock screen, and their three apps' windows. */
const ORG_USER_PAGES: ReadonlySet<string> = new Set([
  "/",
  "/updating",
  ...ORG_USER_APP_IDS.map((id) => `/app/${id}`),
]);

/**
 * `/setup-api` trees a member of staff may use with any method, by surface.
 * Writes that are the owner's inside them (the box's chat model, the Hermes
 * model list) are refused before this table is asked — the BOX_AI_SETTINGS
 * rule in src/lib/non-owner-scope.ts.
 */
const ORG_USER_API_TREES: readonly string[] = [
  // Chat: their own conversations, tabs, uploads, voice and the agent's media.
  "/setup-api/chat",
  "/setup-api/hermes/chat",
  // Files.
  "/setup-api/files",
  // The desktop itself: their own windows (one state per user) and their own
  // preferences (per user on an organisation box, src/lib/user-preferences.ts).
  "/setup-api/desktop/state",
  "/setup-api/preferences",
];

/** Exact `/setup-api` paths a member of staff may use with any method. */
const ORG_USER_API_PATHS: ReadonlySet<string> = new Set([
  // Settings → Account: their own Linux password.
  "/setup-api/users/me/password",
  // The chat's spoken replies (the speech is theirs; the voice is the owner's setting).
  "/setup-api/tts/speak",
  "/setup-api/tts/warm",
  // The Hermes chat's own commands: compress this conversation, its size.
  "/setup-api/hermes/compress",
]);

/**
 * Exact `/setup-api` paths a member of staff may READ: who they are, the
 * box's state the desktop and the chat draw from, the progress of an update
 * the box is running (the lock screen every user is sent to polls it), and the
 * box's AI as the chat header shows it — read-only, since changing it is the
 * owner's.
 */
const ORG_USER_API_READS: ReadonlySet<string> = new Set([
  "/setup-api/users/me",
  "/setup-api/setup/status",
  "/setup-api/update/status",
  "/setup-api/gateway/ws-config",
  "/setup-api/gateway/health",
  "/setup-api/harness/active",
  "/setup-api/harness/status",
  "/setup-api/system/timezone",
  "/setup-api/system/battery",
  "/setup-api/network/internet",
  "/setup-api/monitors",
  "/setup-api/pets",
  "/setup-api/mascot-lines",
  "/setup-api/hermes/models",
  "/setup-api/hermes/commands",
  "/setup-api/hermes/session-size",
  "/setup-api/local-models",
  "/setup-api/local-ai",
  "/setup-api/llamacpp/status",
  "/setup-api/providers/status",
  "/setup-api/ai-models/status",
  "/setup-api/ai-models/catalog",
  "/setup-api/tts",
  "/setup-api/stt",
  "/setup-api/whisper",
]);

function underTree(path: string, tree: string): boolean {
  return path === tree || path.startsWith(tree + "/");
}

/**
 * What an organisation box answers a member of staff for one request, given
 * its CANONICAL path (decoded, case-folded, slashes collapsed — the form
 * src/lib/non-owner-scope.ts matches every exception on). Asked only after the
 * general non-owner exceptions have been applied, so the owner's account, the
 * box's AI settings writes and the gateway's own trees are already settled.
 *
 * `page` is a page address (no `/setup-api`, no gateway tree): the desktop and
 * the three apps' windows are theirs; any other page sends them home.
 */
export function orgMemberVerdict(canon: string, method: string): "allow" | "deny" | "redirect-home" {
  const isRead = method === "GET" || method === "HEAD";
  if (underTree(canon, "/setup-api")) {
    if (ORG_USER_API_TREES.some((tree) => underTree(canon, tree))) return "allow";
    if (ORG_USER_API_PATHS.has(canon)) return "allow";
    if (isRead && ORG_USER_API_READS.has(canon)) return "allow";
    return "deny";
  }
  if (ORG_USER_PAGES.has(canon)) return "allow";
  return "redirect-home";
}
