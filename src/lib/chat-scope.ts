/**
 * Whose conversation a chat session key is — one chat per ClawBox user.
 *
 * Every signed-in ClawBox user gets the same desktop as the owner except the
 * main chat: each person has their own main conversation, their own side tabs
 * and their own history, and never sees anyone else's. The harness already
 * isolates conversations by SESSION KEY — OpenClaw files one per
 * `agent:<agentId>:<key>` (routing + isolation, docs/concepts/session.md in the
 * pinned core), the Hermes transcript store one file per key — so a user's
 * chat is simply a set of keys only they may use:
 *
 *   OpenClaw  main  agent:<agentId>:clawbox-user-<name>
 *             tab   agent:<agentId>:clawbox-utab-<12 hex>-<name>
 *   Hermes    main  desktop-user-<name>
 *             tab   desktop-utab-<12 hex>-<name>
 *
 * The owner keeps the keys they always had (the gateway's own main, the
 * `desktop` transcript, `clawbox-<id>` / `desktop-<id>` tabs). Neither of the
 * owner's tab shapes can contain a `-` after its prefix (chat-tabs.ts), and
 * every user shape does, so no owner key ever reads as a user's.
 *
 * WHY THE TAB ID COMES FIRST. A username may contain `-`, so
 * `clawbox-user-bob-<hex>` would be both bob's tab and the main key of a user
 * called `bob-<hex>`. With the fixed-length id at a fixed offset and the name
 * last, every key names exactly one user.
 *
 * Client-safe (no imports beyond the username rule): the chat surfaces mint
 * these keys, the routes and the gateway relay check them. The relay is plain
 * CommonJS, so scripts/chat-scope.js carries its own copy of the OpenClaw half;
 * src/tests/unit/chat-scope.test.ts holds the two to the same table.
 */

import { DESKTOP_TRANSCRIPT_KEY } from "@/lib/harness/transcript-key";

/** Who is chatting: the owner, or another signed-in ClawBox user. */
export interface ChatPrincipal {
  username: string;
  isOwner: boolean;
}

const OPENCLAW_USER_MAIN = "clawbox-user-";
const OPENCLAW_USER_TAB = "clawbox-utab-";
const HERMES_USER_MAIN = `${DESKTOP_TRANSCRIPT_KEY}-user-`;
const HERMES_USER_TAB = `${DESKTOP_TRANSCRIPT_KEY}-utab-`;

/** The username rule (src/lib/username-rules.ts), as a key fragment: 1-32 characters. */
const NAME = "[a-z_][a-z0-9_-]{0,31}";
const TAB_ID = "[0-9a-f]{12}";
const AGENT = "[a-z0-9][a-z0-9_-]{0,63}";

const OPENCLAW_USER_MAIN_RE = new RegExp(`^agent:(${AGENT}):${OPENCLAW_USER_MAIN}(${NAME})$`);
const OPENCLAW_USER_TAB_RE = new RegExp(`^agent:(${AGENT}):${OPENCLAW_USER_TAB}${TAB_ID}-(${NAME})$`);
const HERMES_USER_MAIN_RE = new RegExp(`^${HERMES_USER_MAIN}(${NAME})$`);
const HERMES_USER_TAB_RE = new RegExp(`^${HERMES_USER_TAB}${TAB_ID}-(${NAME})$`);
const NAME_RE = new RegExp(`^${NAME}$`);
const TAB_ID_RE = new RegExp(`^${TAB_ID}$`);

function nameOk(username: unknown): username is string {
  return typeof username === "string" && NAME_RE.test(username);
}

/** The agent a gateway key belongs to (`agent:<id>:…`), `main` for a bare key. */
export function agentIdOfKey(key: string): string {
  const m = /^agent:([^:]+):/.exec(key);
  return (m ? m[1] : "main").toLowerCase();
}

/** A user's main OpenClaw conversation, under the agent the gateway's own main key names. */
export function openclawUserMainKey(gatewayMainKey: string, username: string): string {
  if (!nameOk(username)) throw new Error(`Not a ClawBox username: ${JSON.stringify(username)}`);
  return `agent:${agentIdOfKey(gatewayMainKey)}:${OPENCLAW_USER_MAIN}${username}`;
}

/** A user's main Hermes conversation (their transcript beside the owner's `desktop`). */
export function hermesUserMainKey(username: string): string {
  if (!nameOk(username)) throw new Error(`Not a ClawBox username: ${JSON.stringify(username)}`);
  return `${HERMES_USER_MAIN}${username}`;
}

/**
 * The user a key belongs to, or `null` for a key in the owner's space (the
 * gateway's main, `desktop`, the owner's tabs, and every other session the
 * box has — Telegram, cron, coding runs).
 */
export function chatKeyUser(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const k = key.trim().toLowerCase();
  const m = OPENCLAW_USER_MAIN_RE.exec(k)
    ?? OPENCLAW_USER_TAB_RE.exec(k);
  if (m) return m[2];
  const h = HERMES_USER_MAIN_RE.exec(k) ?? HERMES_USER_TAB_RE.exec(k);
  return h ? h[1] : null;
}

/** True for a key in some ClawBox user's chat space (never the owner's). */
export function isUserChatKey(key: unknown): boolean {
  return chatKeyUser(key) !== null;
}

/**
 * May this person read or write the conversation behind `key`?
 *
 * A user: only their own keys. The owner: every key that is not another
 * user's — their own chat, and the box's other sessions as before.
 */
export function mayUseChatKey(principal: ChatPrincipal, key: unknown): boolean {
  if (typeof key !== "string" || !key.trim()) return false;
  const owner = chatKeyUser(key);
  return principal.isOwner ? owner === null : owner === principal.username;
}

/**
 * The main conversation this person's chat opens on.
 *
 * @param harnessMain the harness's own main key: the gateway hello's
 *   `mainSessionKey` on OpenClaw, `desktop` on Hermes.
 */
export function mainChatKeyFor(principal: ChatPrincipal, harnessMain: string): string {
  if (principal.isOwner) return harnessMain;
  return harnessMain.startsWith("agent:") || harnessMain === "main"
    ? openclawUserMainKey(harnessMain, principal.username)
    : hermesUserMainKey(principal.username);
}

/**
 * The Hermes main conversation for this person: `desktop` for the owner,
 * `desktop-user-<name>` for anyone else. A route that is handed no key falls
 * back to this, never to the owner's transcript.
 */
export function defaultTranscriptKeyFor(principal: ChatPrincipal | null): string {
  return principal && !principal.isOwner ? hermesUserMainKey(principal.username) : DESKTOP_TRANSCRIPT_KEY;
}

/**
 * A new side conversation beside `mainKey` when `mainKey` is a user's main,
 * or `null` when it is not (the adapters then mint the owner's shapes as
 * before). `tabId` is 12 lower-case hex characters.
 */
export function userTabKeyFor(mainKey: string, tabId: string): string | null {
  if (!TAB_ID_RE.test(tabId)) return null;
  const k = mainKey.trim().toLowerCase();
  const o = OPENCLAW_USER_MAIN_RE.exec(k);
  if (o) return `agent:${o[1]}:${OPENCLAW_USER_TAB}${tabId}-${o[2]}`;
  const h = HERMES_USER_MAIN_RE.exec(k);
  if (h) return `${HERMES_USER_TAB}${tabId}-${h[1]}`;
  return null;
}

/** True for a side-conversation key of a user (either harness) — the tab strip's shape for them. */
export function isUserTabKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  return OPENCLAW_USER_TAB_RE.test(key) || HERMES_USER_TAB_RE.test(key);
}
