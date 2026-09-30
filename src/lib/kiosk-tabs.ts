/**
 * The tabs of the KIOSK Chrome — the one on the laptop's physical display.
 *
 * On the x64 laptop the display runs GDM autologin → cage → Chrome for Testing
 * on the ClawBox desktop (`/usr/local/bin/clawbox-kiosk-browser`). The desktop
 * opens a few pages TOP-LEVEL — the Anthropic sign-in, the app store, VNC —
 * with `window.open(url, "_blank")`, which in that Chrome is a new tab in the
 * same window. In `--kiosk` there is no tab strip, so once such a page was up
 * there was no way back to the desktop; the kiosk therefore ran as a plain
 * window with a tab strip, which is not a kiosk. This module is the other half
 * of the fix: the desktop's own taskbar lists the kiosk's tabs and switches
 * between them, so Chrome can hide its own.
 *
 * It speaks Chrome's DevTools HTTP endpoints — `/json/list`, `PUT /json/new`,
 * `/json/activate/<id>`, `/json/close/<id>` — on the loopback port
 * `scripts/x64-migration/kiosk/enable-kiosk-remote-debugging.sh` gives the
 * launcher (`CLAWBOX_KIOSK_CDP_PORT`, default 18801; the VNC browser's is
 * 18800 and is `src/lib/cdp-probe.ts`'s business). No WebSocket, no
 * Playwright: the four HTTP calls are all this needs.
 *
 * A box with no kiosk — every Jetson, a dev machine, the laptop before its
 * reboot picked the flags up — has nothing on the port. That is `available:
 * false`, never an error: the taskbar reads it as "draw nothing", and a route
 * that answered 500 for the normal state of most boxes would fill the log.
 */
import fs from "fs";

export interface KioskTab {
  id: string;
  title: string;
  url: string;
  favicon: string;
  /** Not reported by `/json/list`; reserved for a future CDP session. */
  active?: boolean;
  /** The ClawBox desktop itself (or a page of it), as opposed to a page it opened. */
  isDesktop: boolean;
}

export interface KioskTabs {
  available: boolean;
  tabs: KioskTab[];
}

export const DEFAULT_KIOSK_URL = "http://localhost:3005/";
export const DEFAULT_KIOSK_CDP_PORT = 18801;
/** Where the launcher reads its URL from (`CLAWBOX_KIOSK_URL`). Root-owned; may be absent. */
export const KIOSK_ENV_FILE = "/etc/clawbox/kiosk.env";
/**
 * Each HTTP call's ceiling. A live Chrome answers these in single-digit
 * milliseconds; a closed port refuses at once. The timeout is for the one case
 * in between — a Chrome mid-crash-restart holding the socket — and the taskbar
 * polls this every two seconds, so it must never wait long.
 */
export const CDP_TIMEOUT_MS = 1500;

/** CDP target ids are hex; anything else never reaches a URL path. */
const TAB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type EnvLike = Record<string, string | undefined>;

export function kioskCdpPort(env: EnvLike = process.env): number {
  const raw = Number(env.CLAWBOX_KIOSK_CDP_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_KIOSK_CDP_PORT;
}

function cdpEndpoint(): string {
  return `http://127.0.0.1:${kioskCdpPort()}`;
}

/**
 * Minimal EnvironmentFile parser (the shape `edition-source.ts` reads):
 * `KEY=value`, optional `export`, optional surrounding quotes.
 */
export function parseKioskEnv(raw: string, key = "CLAWBOX_KIOSK_URL"): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`).exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() || null;
  }
  return null;
}

/**
 * The URL the kiosk was launched on. `CLAWBOX_KIOSK_URL` from the env first
 * (tests, a box that exports it), then the launcher's own env file, then the
 * default. Anything that is not http(s) falls back to the default rather than
 * making every tab "not the desktop".
 */
export function readKioskUrl(env: EnvLike = process.env): string {
  const candidates: (string | null | undefined)[] = [env.CLAWBOX_KIOSK_URL];
  try {
    candidates.push(parseKioskEnv(fs.readFileSync(/* turbopackIgnore: true */ KIOSK_ENV_FILE, "utf-8")));
  } catch {
    // No kiosk.env: not a kiosk box, or one whose launcher takes the default.
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      const u = new URL(c);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch {
      // Not a URL; try the next source.
    }
  }
  return DEFAULT_KIOSK_URL;
}

/**
 * The desktop SHELL's own pages: the ones the kiosk tab itself lands on. The
 * desktop root, sign-in, the setup wizard, the update lock screen and the
 * subscription portal. Everything else on the origin — `/app/<id>` ("Open in
 * new tab", the Browser app's `/app/vnc` fallback), `/apps/<id>/` and
 * `/setup-api/webapps?app=` (a webapp with `launch: "window"`) — is a page the
 * desktop OPENED, top-level, and in `--kiosk` a tab the taskbar did not list
 * would be one with no way back.
 */
const SHELL_PATH_RE = /^\/(?:(?:login|setup|updating|portal)(?:\/.*)?)?$/;

/**
 * Is `url` the ClawBox desktop, as opposed to a page the desktop opened?
 *
 * Same origin as the kiosk URL AND one of the shell's own pages. `/login` and
 * the rest count as the desktop because the kiosk tab itself lands on them,
 * and listing the kiosk tab as something to switch to would be circular.
 */
export function isDesktopUrl(url: string, kioskUrl: string): boolean {
  let u: URL;
  let k: URL;
  try {
    u = new URL(url);
    k = new URL(kioskUrl);
  } catch {
    return false;
  }
  if (u.origin !== k.origin) return false;
  return SHELL_PATH_RE.test(u.pathname);
}

/** The tab `home` should land on: the desktop root first, then any desktop page. */
export function pickHomeTab(tabs: KioskTab[], kioskUrl: string): KioskTab | null {
  const desktop = tabs.filter((t) => t.isDesktop);
  const kioskPath = safePathname(kioskUrl);
  return desktop.find((t) => safePathname(t.url) === kioskPath) ?? desktop[0] ?? null;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

interface CdpTarget {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  faviconUrl?: unknown;
}

async function cdpFetch(path: string, method: "GET" | "PUT" = "GET"): Promise<Response | null> {
  try {
    return await fetch(`${cdpEndpoint()}${path}`, {
      method,
      signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return null;
  }
}

function tabFromTarget(t: CdpTarget, kioskUrl: string): KioskTab | null {
  // Extension pages, service workers and iframes are targets too; a tab is a
  // `page` on http(s). `about:blank` (a tab still loading its URL) is kept so
  // a page that was just opened shows up at once rather than a poll later.
  if (t.type !== "page" || typeof t.id !== "string" || typeof t.url !== "string") return null;
  if (!TAB_ID_RE.test(t.id)) return null;
  if (!/^(https?:|about:blank)/.test(t.url)) return null;
  return {
    id: t.id,
    title: typeof t.title === "string" ? t.title : "",
    url: t.url,
    favicon: typeof t.faviconUrl === "string" && /^https?:/.test(t.faviconUrl) ? t.faviconUrl : "",
    isDesktop: isDesktopUrl(t.url, kioskUrl),
  };
}

/** Every open PAGE of the kiosk Chrome, or `available: false` when nothing answers. */
export async function listKioskTabs(kioskUrl = readKioskUrl()): Promise<KioskTabs> {
  const res = await cdpFetch("/json/list");
  if (!res || !res.ok) return { available: false, tabs: [] };
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return { available: false, tabs: [] };
  }
  if (!Array.isArray(raw)) return { available: false, tabs: [] };
  const tabs: KioskTab[] = [];
  for (const t of raw as CdpTarget[]) {
    const tab = tabFromTarget(t, kioskUrl);
    if (tab) tabs.push(tab);
  }
  return { available: true, tabs };
}

export type KioskAction =
  | { ok: true; available: true; tab?: KioskTab }
  | { ok: false; available: false }
  | { ok: false; available: true; error: string; code: string };

const UNAVAILABLE: KioskAction = { ok: false, available: false };

/** Open `url` as a new tab of the kiosk (it becomes the active one). http(s) only. */
export async function openKioskTab(url: string, kioskUrl = readKioskUrl()): Promise<KioskAction> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, available: true, error: "Invalid URL", code: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, available: true, error: "Only http(s) pages can be opened", code: "invalid_url" };
  }
  // Chrome dropped GET for /json/new (it changes state); PUT is the verb now.
  const res = await cdpFetch(`/json/new?${encodeURIComponent(parsed.href)}`, "PUT");
  if (!res) return UNAVAILABLE;
  if (!res.ok) return { ok: false, available: true, error: `Chrome refused to open the page (${res.status})`, code: "cdp_error" };
  try {
    const tab = tabFromTarget(await res.json() as CdpTarget, kioskUrl);
    if (tab) return { ok: true, available: true, tab };
  } catch {
    // Opened, but the answer was not the target record; the next poll lists it.
  }
  return { ok: true, available: true };
}

async function tabVerb(verb: "activate" | "close", id: string): Promise<KioskAction> {
  if (!TAB_ID_RE.test(id)) return { ok: false, available: true, error: "Invalid tab id", code: "invalid_id" };
  const res = await cdpFetch(`/json/${verb}/${id}`);
  if (!res) return UNAVAILABLE;
  if (res.status === 404) return { ok: false, available: true, error: "No such tab", code: "not_found" };
  if (!res.ok) return { ok: false, available: true, error: `Chrome refused (${res.status})`, code: "cdp_error" };
  return { ok: true, available: true };
}

/** Bring tab `id` to the front. */
export function activateKioskTab(id: string): Promise<KioskAction> {
  return tabVerb("activate", id);
}

/** Close tab `id`. Closing the last tab ends Chrome; the launcher loop restarts it on the desktop. */
export function closeKioskTab(id: string): Promise<KioskAction> {
  return tabVerb("close", id);
}

/**
 * Back to the desktop: activate its tab, or — when the kiosk tab itself has
 * gone (closed by hand, the crash loop mid-restart) — open the kiosk URL anew.
 */
export async function goHome(kioskUrl = readKioskUrl()): Promise<KioskAction> {
  const list = await listKioskTabs(kioskUrl);
  if (!list.available) return UNAVAILABLE;
  const home = pickHomeTab(list.tabs, kioskUrl);
  if (home) return activateKioskTab(home.id);
  return openKioskTab(kioskUrl, kioskUrl);
}
