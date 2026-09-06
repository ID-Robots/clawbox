export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { describePortOwner, findPlaywrightChromium, probeCdp } from "@/lib/cdp-probe";
import net from "net";
import fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { lookup as dnsLookup } from "dns/promises";
import { activeRunDirectory, activeRunId, getRealBrowser } from "@/lib/coding-agent";
import type { BrowserKind } from "@/lib/browser-sessions";
import { closeSession, getSession, openSession, sessionCount, sweepIdle, touchSession } from "@/lib/browser-sessions";
import { getBrowserStartUrl, writeBrowserLaunchEnv } from "@/lib/browser-setup";
import { isInside } from "@/lib/file-guard";
import { ensureArtifactsDir } from "@/lib/coding-agent-artifacts";
import { describeImage } from "@/lib/vision-describe";

const exec = promisify(execFile);
const CDP_PORT = 18800;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
// Every screenshot is bounded: Playwright's default is 30 s, and a renderer
// wedged on a heavy page (a WebGL scene mid-compile) would otherwise hold the
// whole request — and the coding run waiting on it — for that long on each
// call. 15 s is well above a healthy capture and short enough that the caller
// gets its "could not capture the page" and moves on.
const SCREENSHOT_TIMEOUT_MS = 15_000;

// SEC-4: the automation browser must not be steerable to `file://` (local-file
// exfil — the JSON response hands back a screenshot of whatever it renders) or
// to the device's own internal services (SSRF). Restrict to http(s) and reject
// hosts that are, or resolve to, loopback/private/link-local addresses.
// One scoped exception: file:// inside the ACTIVE coding run's own folder —
// see validateFileNavUrl.
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // 100.64/10 CGNAT
    if (p[0] >= 224) return true;
    return false;
  }
  const lc = ip.toLowerCase();
  if (lc === "::1" || lc === "::") return true;
  // fe80::/10 link-local spans fe80–febf, not just the fe80 prefix; fc00::/7
  // unique-local is fc/fd. ff00::/8 is multicast.
  if (/^fe[89ab]/.test(lc) || lc.startsWith("fc") || lc.startsWith("fd") || lc.startsWith("ff")) return true;
  if (lc.startsWith("::ffff:")) {
    // IPv4-mapped IPv6. WHATWG URL normalizes these to the HEX form
    // (::ffff:7f00:1), so a plain recurse on the suffix (expecting dotted
    // ::ffff:127.0.0.1) misses loopback/private targets. Canonicalize both
    // forms to dotted IPv4; fail closed on any unrecognized ::ffff: shape.
    const mapped = lc.slice(7);
    if (net.isIPv4(mapped)) return isPrivateIp(mapped);
    const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hx) {
      const hi = parseInt(hx[1], 16), lo = parseInt(hx[2], 16);
      return isPrivateIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return true;
  }
  return false;
}

// getaddrinfo runs on the libuv threadpool (size 4 by default). A hostile or
// dead resolver can hang each lookup for the OS timeout, and enough concurrent
// nav requests would exhaust the pool and stall unrelated fs/crypto work. Cap
// the wait so validateNavUrl fails closed instead of blocking indefinitely.
const DNS_TIMEOUT_MS = 3000;
async function lookupWithTimeout(host: string): Promise<{ address: string }[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([dnsLookup(host, { all: true }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The one file:// exception to SEC-4: the coding agent viewing the page IT is
 * building. Only the ACTIVE run's working folder is reachable — anything else
 * (config stores, token files, another run's folder) would end up rendered
 * into a screenshot the vision model happily transcribes, which is exactly
 * the exfil SEC-4 blocks. Realpath on both sides so a symlink a run planted
 * inside its folder cannot point the browser outside it.
 *
 * The grant is deliberately TEMPORAL, not per-caller: while a run is live,
 * any holder of the cookie-or-bearer gate may open file:// into that run's
 * folder. On a single-owner appliance with one-run-at-a-time that is the
 * run's own working set either way; a per-run capability token would be real
 * machinery for marginal gain here.
 *
 * What is CHECKED is what is OPENED: the browser is sent to the resolved
 * path, not the address the caller wrote. A symlink in the run's folder that
 * pointed inside it when it was checked and is swapped to point outside a
 * moment later would otherwise be followed by Chromium, not by this check.
 */
type NavDecision = { ok: true; url: string } | { ok: false; error: string };

function resolveFileNavUrl(parsed: URL): NavDecision {
  const activeDir = activeRunDirectory();
  if (!activeDir) return { ok: false, error: "Blocked URL scheme: file: (no coding run is active)" };
  let real: string;
  let realDir: string;
  try {
    real = fs.realpathSync(fileURLToPath(parsed));
    realDir = fs.realpathSync(activeDir);
  } catch {
    return { ok: false, error: "Blocked file address (file not found)" };
  }
  if (!isInside(real, realDir)) {
    return { ok: false, error: "Blocked file address (outside the active coding run's folder)" };
  }
  // The page may read its own query and fragment; both ride along unchanged.
  const resolved = pathToFileURL(real);
  resolved.search = parsed.search;
  resolved.hash = parsed.hash;
  return { ok: true, url: resolved.href };
}

/** The address the browser may be sent to for `url`, or why it may not. */
async function resolveNavUrl(url: string): Promise<NavDecision> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  if (parsed.protocol === "file:") {
    return resolveFileNavUrl(parsed);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Blocked URL scheme: ${parsed.protocol} (only http/https allowed)` };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return { ok: false, error: "Blocked internal host" };
  if (net.isIP(host)) {
    return isPrivateIp(host) ? { ok: false, error: "Blocked internal address" } : { ok: true, url };
  }
  try {
    const results = await lookupWithTimeout(host);
    if (results.some((r) => isPrivateIp(r.address))) return { ok: false, error: "Blocked internal address" };
  } catch {
    return { ok: false, error: "Host did not resolve" };
  }
  return { ok: true, url };
}

/** Returns an error message if the URL is not safe to navigate to, else null. */
async function validateNavUrl(url: string): Promise<string | null> {
  const nav = await resolveNavUrl(url);
  return nav.ok ? null : nav.error;
}

// validateNavUrl only vets the URL the caller passes; page.goto then follows
// HTTP 3xx redirects and re-resolves DNS itself, so a public URL that 302s to
// (or DNS-rebinds onto) an internal host would still be reached and screenshot.
// Install a request-level guard on the page that re-validates every top-level
// navigation — including each redirect hop — against the same private-address
// rules, aborting before the browser connects. Idempotent per page.
type GuardablePage = {
  route: (glob: string, handler: (route: {
    request: () => { url: () => string; isNavigationRequest: () => boolean };
    abort: (reason?: string) => Promise<void>;
    continue: () => Promise<void>;
  }) => void | Promise<void>) => Promise<void>;
  __navGuardInstalled?: boolean;
};
async function installNavGuard(page: GuardablePage): Promise<void> {
  if (page.__navGuardInstalled) return;
  page.__navGuardInstalled = true;
  await page.route("**/*", async (route) => {
    const req = route.request();
    // Only pay the DNS-resolution cost on top-level navigations — the requests
    // whose rendered result gets screenshot and where redirect/rebind SSRF
    // lands. Subresources continue unblocked.
    if (!req.isNavigationRequest()) {
      await route.continue();
      return;
    }
    const err = await validateNavUrl(req.url());
    if (err) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

// Playwright key name mapping (browser KeyboardEvent.key → Playwright key names)
const KEY_MAP: Record<string, string> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  " ": "Space",
  Control: "Control",
  Shift: "Shift",
  Alt: "Alt",
  Meta: "Meta",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
};

// The session store itself lives in src/lib/browser-sessions.ts: a coding run
// has to be able to close ITS pages when it settles, and the runner cannot
// reach into a route module to do it. Sessions only hold page refs — the
// Playwright Browser + context are cached once per process and reused across
// them. The previous design called connectOverCDP on every launch, which piled
// up concurrent CDP clients and could stall the second connect for 5+ s under
// load; agents surfaced that as "Browser control is currently blocked by a CDP
// connection timeout (ws://127.0.0.1:18800)".
setInterval(() => {
  for (const id of sweepIdle()) console.log(`[Browser] Cleaned up stale session: ${id}`);
  closeOwnedBrowserIfIdle();
}, 60_000);

// Shared Playwright Browser handles, reused across sessions. Recreated on
// next access if the underlying Chromium disconnects (e.g. service restart).
//
// One slot per KIND, because the owner's switch can move between two sessions
// and a page already open on the other browser has to keep working: closing
// the handle a live session is driving to honour a preference change would
// take that session's page down with it.
let desktopBrowser: import("playwright").Browser | null = null;
let desktopBrowserPromise: Promise<import("playwright").Browser> | null = null;
// The Chromium WE launched — for a foreign CDP port, a desktop launch that
// failed, or an owner who switched the screen off. The desktop's is only
// attached to and must never be closed from here. Ours is headless and
// invisible, so with only pages ever closed it stayed resident for the life of
// the web server; it is closed once the last session is gone instead, and the
// next launch starts a fresh one.
let ownBrowser: import("playwright").Browser | null = null;
let ownBrowserPromise: Promise<import("playwright").Browser> | null = null;

/** Close the Chromium of our own once no session refers to it. Never the desktop's. */
function closeOwnedBrowserIfIdle(): void {
  if (sessionCount("headless") > 0 || !ownBrowser) return;
  const browser = ownBrowser;
  ownBrowser = null;
  browser.close().catch(() => {});
  console.log("[Browser] Closed the headless Chromium of our own: no session left");
}

/**
 * Ready means OURS: /json/version answering is not enough, because another
 * program's Chromium on this port answers it too and then rejects our
 * Origin on the upgrade (seen live: the OpenClaw gateway's own browser sat
 * on 18800 for hours while this said "ready"). See src/lib/cdp-probe.ts.
 */
async function isDesktopBrowserReady(): Promise<boolean> {
  return (await probeCdp(CDP_ENDPOINT, CDP_ENDPOINT)) === "ours";
}

/**
 * Bring ClawBox's own Chromium up unless it already is.
 *
 * "desktop" — it is up (or came up); "foreign" — the port is held by somebody
 * else's Chromium, so our service could not bind it and starting it would only
 * fail; "unavailable" — the launch produced nothing. The last two are not
 * errors here: the caller answers them with the headless browser and says so.
 */
async function ensureDesktopBrowserRunning(): Promise<"desktop" | "foreign" | "unavailable"> {
  const state = await probeCdp(CDP_ENDPOINT, CDP_ENDPOINT);
  if (state === "ours") return "desktop";
  if (state === "foreign") {
    // Naming the squatter is ss plus two ps calls — a note for the log, not a
    // step the launch waits on. It never rejects, so nothing is left dangling.
    void describePortOwner(CDP_PORT).then((owner) => {
      console.warn(`[Browser] CDP port ${CDP_PORT} is held by another program's Chromium${owner}; using a headless Chromium of our own instead`);
    });
    return "foreign";
  }

  // systemd starts Chromium, not this server, so the start page has to be on
  // disk before the unit runs — the same write the manage route's "open" makes,
  // for the same reason (scripts/launch-browser.sh sources browser.env). Best
  // effort: a window on the wrong page still beats no window at all.
  try {
    await writeBrowserLaunchEnv(await getBrowserStartUrl());
  } catch (err) {
    console.warn("[Browser] could not write the browser launch environment:", err instanceof Error ? err.message : err);
  }

  try {
    await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "start", "clawbox-browser.service"], { timeout: 5000 });
  } catch (err) {
    console.warn("[Browser] systemctl start clawbox-browser.service failed:", err instanceof Error ? err.message : err);
  }

  // 6 × 1 s = 6 s max — agent UX matters more than slack for a slow cold
  // start. systemctl already returned, so Chromium is launching now; if
  // it's not up in 6 s it's wedged.
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await isDesktopBrowserReady()) return "desktop";
  }

  console.warn(`[Browser] Desktop Chromium did not come up on CDP port ${CDP_PORT}; using a headless Chromium of our own instead`);
  return "unavailable";
}

async function getPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright not installed. Run: bunx playwright install chromium");
  }
}

/** Attach to the desktop Chromium over CDP, once, and keep the handle. */
async function getDesktopBrowser(): Promise<import("playwright").Browser> {
  if (desktopBrowser?.isConnected()) return desktopBrowser;
  if (desktopBrowserPromise) return desktopBrowserPromise;

  desktopBrowserPromise = (async () => {
    const pw = await getPlaywright();
    try {
      // 30 s matches Playwright's own default — previously 10 s to fail fast
      // against the Bun-WS hang, which is no longer relevant now that we
      // run under Node.
      const browser = await pw.chromium.connectOverCDP(CDP_ENDPOINT, {
        timeout: 30_000,
        // Chromium gates the CDP WebSocket upgrade on Origin against
        // --remote-allow-origins (pinned to this exact value in
        // scripts/launch-browser.sh). Send a matching Origin so our automation
        // connects while a rebound web page's own origin is rejected — closing
        // the CDP DNS-rebinding takeover. Keep this byte-identical to the flag.
        headers: { Origin: CDP_ENDPOINT },
      });
      browser.on("disconnected", () => {
        if (desktopBrowser === browser) desktopBrowser = null;
        // Also drop a stale in-flight promise so a disconnect that races
        // with another caller doesn't hand out a promise for a dead browser.
        desktopBrowserPromise = null;
        console.log("[Browser] Shared CDP connection disconnected; will reconnect on next launch");
      });
      desktopBrowser = browser;
      return browser;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Browser] connectOverCDP(${CDP_ENDPOINT}) failed:`, msg);
      throw new Error(`Failed to attach to desktop Chromium via CDP at ${CDP_ENDPOINT}: ${msg}`);
    } finally {
      desktopBrowserPromise = null;
    }
  })();

  return desktopBrowserPromise;
}

/** Launch a headless Chromium of our own, once, and keep the handle. */
async function getOwnBrowser(): Promise<import("playwright").Browser> {
  if (ownBrowser?.isConnected()) return ownBrowser;
  if (ownBrowserPromise) return ownBrowserPromise;

  ownBrowserPromise = (async () => {
    const pw = await getPlaywright();
    try {
      // Explicit executable: Playwright's own lookup has answered "" inside
      // the standalone server, while the runtime sits in ~/.cache/ms-playwright.
      const executablePath = findPlaywrightChromium() ?? undefined;
      const browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox"], ...(executablePath ? { executablePath } : {}) });
      browser.on("disconnected", () => {
        if (ownBrowser === browser) ownBrowser = null;
        ownBrowserPromise = null;
      });
      ownBrowser = browser;
      return browser;
    } finally {
      ownBrowserPromise = null;
    }
  })();

  return ownBrowserPromise;
}

/**
 * The browser a session is opened on, and which one that turned out to be.
 *
 * The owner's switch is read HERE, for every session: it is the Coding Agent's
 * "verify your work on my screen" preference (ON when the key is absent), and
 * a run that started before the owner flipped it must not go on driving a
 * window they just asked to be left alone.
 *
 * Wanting the screen is not the same as getting it. Somebody else's Chromium
 * on the CDP port, or a desktop launch that never comes up, both leave the
 * headless browser as the only way to verify anything — and failing the whole
 * call instead would cost the run its verification for a window it does not
 * need. So we fall back, and the answer names the browser that served it.
 */
async function acquireBrowser(): Promise<{ browser: import("playwright").Browser; kind: BrowserKind }> {
  if (await getRealBrowser()) {
    // A handle we already hold is proof the window is up: skip the probe (two
    // round trips, one of them a WebSocket upgrade) on every session but the
    // first.
    const where = desktopBrowser?.isConnected() || desktopBrowserPromise
      ? "desktop"
      : await ensureDesktopBrowserRunning();
    if (where === "desktop") {
      try {
        return { browser: await getDesktopBrowser(), kind: "desktop" };
      } catch (err) {
        console.warn("[Browser] the desktop Chromium could not be driven; using a headless Chromium of our own instead:", err instanceof Error ? err.message : err);
      }
    }
  }
  return { browser: await getOwnBrowser(), kind: "headless" };
}

interface DownloadablePage {
  on?: (event: "download", handler: (d: { suggestedFilename(): string; saveAs(path: string): Promise<void> }) => void) => void;
}
const downloadHooked = new WeakSet<object>();
let downloadCounter = 0;

/**
 * A file the page downloads lands in the ACTIVE run's evidence folder.
 *
 * Seen on run-q76516xd: the app's "Download CSV" worked, but the file never
 * reached disk — the verification browser has nowhere to put a download and
 * no prompt a page-driving tool can answer, so the run could only assert the
 * CSV's content from unit tests. Saving it beside the screenshots makes the
 * export something the run (and the owner) can open. No run active: the
 * download is left to the browser as before.
 */
function installDownloadCapture(page: DownloadablePage): void {
  if (typeof page.on !== "function" || downloadHooked.has(page)) return;
  downloadHooked.add(page);
  page.on("download", (download) => {
    const runId = activeRunId();
    if (!runId) return;
    const safe = download.suggestedFilename().replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "download";
    downloadCounter += 1;
    const target = path.join(ensureArtifactsDir(runId), `download-${String(downloadCounter).padStart(3, "0")}-${safe}`);
    download.saveAs(target)
      .then(() => console.log(`[Browser] download saved for ${runId}: ${target}`))
      .catch((err: unknown) => console.warn("[Browser] download not saved:", err instanceof Error ? err.message : err));
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action, sessionId } = body;

    if (action === "launch") {
      const { browser, kind } = await acquireBrowser();
      const context = browser.contexts()[0] ?? await browser.newContext();
      if (!context) {
        throw new Error("Desktop Chromium did not expose a browser context");
      }

      // A run gets a page of its OWN. Borrowing `pages().at(-1)` meant a
      // delegated run drove whatever the owner was reading and the idle sweep
      // then closed that tab; with a page per run, closeSessionsForRun ends
      // exactly what the run opened and never the owner's.
      const runId = activeRunId();
      const page = runId ? await context.newPage() : (context.pages().at(-1) ?? await context.newPage());
      await installNavGuard(page as unknown as GuardablePage);
      installDownloadCapture(page as unknown as DownloadablePage);
      await page.bringToFront().catch(() => {});

      const { url } = body;
      if (url) {
        const nav = await resolveNavUrl(url);
        if (!nav.ok) {
          // A page opened for this run and never registered is a tab nothing
          // would ever close — the sweep only knows sessions.
          if (runId) await page.close().catch(() => {});
          return NextResponse.json({ error: nav.error }, { status: 400 });
        }
        await page.goto(nav.url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      }

      const id = openSession(page, runId, kind);

      const screenshot = await page.screenshot({ type: "png", timeout: SCREENSHOT_TIMEOUT_MS }).catch(() => null);

      return NextResponse.json({
        sessionId: id,
        url: page.url(),
        title: await page.title().catch(() => ""),
        screenshot: screenshot ? screenshot.toString("base64") : null,
        // Which Chromium answered. On by default is the desktop one, so a
        // "headless" here is the caller's only sign that the screen it was
        // told to verify on was not available — see acquireBrowser.
        browser: kind,
      });
    }

    // All other actions require a session
    const session = typeof sessionId === "string" ? getSession<import("playwright").Page>(sessionId) : null;
    if (!session) {
      return NextResponse.json({ error: "No active browser session" }, { status: 400 });
    }

    touchSession(sessionId as string);
    const { page } = session;

    const respond = async (skipScreenshot = false) => {
      const screenshot = skipScreenshot ? null : await page.screenshot({ type: "png", timeout: SCREENSHOT_TIMEOUT_MS }).catch(() => null);
      return {
        url: page.url(),
        title: await page.title().catch(() => ""),
        screenshot: screenshot ? screenshot.toString("base64") : null,
        canGoBack: await page.evaluate(() => window.history.length > 1).catch(() => false),
        // Every answer, not only the launch: a caller that reconnects to a
        // session it did not open — or one whose model kept nothing from the
        // launch reply — can still tell whether the owner is watching this.
        browser: session.browser,
      };
    };

    // The screenshot's written description, for callers whose model cannot
    // see images (coding-agent runs pass describe:true). The description is
    // produced from its own JPEG capture a moment after the PNG, so on an
    // animating page the two frames can differ slightly; a failed description
    // is an answer, not an error, and the caller degrades to the title.
    const describeReply = async (reply: Awaited<ReturnType<typeof respond>>) => {
      if (!reply.screenshot) {
        return { ...reply, description: null, descriptionError: "could not capture the page" };
      }
      // Described from a q60 JPEG re-capture, not the PNG: the vision round
      // trip scales with upload size (measured on this box: a full PNG frame
      // ~10-30 s, the same frame as a small JPEG ~3 s), while the PNG in
      // `reply` stays what the caller archives into the evidence folder.
      const jpeg = await page.screenshot({ type: "jpeg", quality: 60, timeout: SCREENSHOT_TIMEOUT_MS }).catch(() => null);
      const described = jpeg
        ? await describeImage(jpeg.toString("base64"), undefined, "image/jpeg")
        : await describeImage(reply.screenshot);
      return { ...reply, description: described.text, descriptionError: described.error };
    };
    const finish = async () => {
      const reply = await respond();
      return body.describe === true ? describeReply(reply) : reply;
    };

    const validCoord = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

    switch (action) {
      case "navigate": {
        const { url } = body;
        if (!url) return NextResponse.json({ error: "URL required" }, { status: 400 });
        await installNavGuard(page as unknown as GuardablePage);
        const nav = await resolveNavUrl(url);
        if (!nav.ok) return NextResponse.json({ error: nav.error }, { status: 400 });
        await page.goto(nav.url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        return NextResponse.json(await finish());
      }

      case "click": {
        const { x, y } = body;
        if (!validCoord(x) || !validCoord(y)) return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
        await page.mouse.click(x, y);
        await page.waitForTimeout(300);
        return NextResponse.json(await respond());
      }

      case "dblclick": {
        const { x, y } = body;
        if (!validCoord(x) || !validCoord(y)) return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
        await page.mouse.dblclick(x, y);
        await page.waitForTimeout(300);
        return NextResponse.json(await respond());
      }

      case "scroll": {
        const { x, y, deltaX, deltaY } = body;
        if (!validCoord(x) || !validCoord(y)) return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
        await page.mouse.move(x, y);
        await page.mouse.wheel(validCoord(deltaX) ? deltaX : 0, validCoord(deltaY) ? deltaY : 0);
        await page.waitForTimeout(200);
        return NextResponse.json(await respond());
      }

      case "hover": {
        const { x, y } = body;
        if (!validCoord(x) || !validCoord(y)) return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
        await page.mouse.move(x, y);
        // No screenshot for hover — too frequent
        return NextResponse.json({ ok: true, browser: session.browser });
      }

      case "keydown": {
        const { key } = body;
        if (typeof key !== "string" || key.length === 0) {
          return NextResponse.json({ error: "key required" }, { status: 400 });
        }
        const pwKey = KEY_MAP[key] || key;
        // Single printable character → type it; special key → press it. A
        // key name Playwright doesn't recognise makes press() throw — treat
        // that as a client error rather than letting it become a raw 500.
        try {
          if (pwKey.length === 1 && !KEY_MAP[key]) {
            await page.keyboard.type(pwKey);
          } else {
            await page.keyboard.press(pwKey);
          }
        } catch {
          return NextResponse.json({ error: `Unknown key: ${key}` }, { status: 400 });
        }
        await page.waitForTimeout(100);
        return NextResponse.json(await respond());
      }

      case "type": {
        const { text } = body;
        if (!text) return NextResponse.json({ error: "Text required" }, { status: 400 });
        await page.keyboard.type(text, { delay: 30 });
        return NextResponse.json(await respond());
      }

      case "fill": {
        // One call per field: focus, clear, set — instead of a click, a
        // select-all and a keystroke-by-keystroke type. A coding run spent
        // its whole step budget on Tab/keypress navigation (run-9xy2j8qk).
        const { selector, text } = body;
        if (typeof selector !== "string" || !selector.trim()) {
          return NextResponse.json({ error: "Selector required" }, { status: 400 });
        }
        if (typeof text !== "string") return NextResponse.json({ error: "Text required" }, { status: 400 });
        try {
          await page.fill(selector, text, { timeout: 5000 });
        } catch (err) {
          return NextResponse.json(
            { error: `Could not fill "${selector.slice(0, 80)}": ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` },
            { status: 404 },
          );
        }
        return NextResponse.json(await respond());
      }

      case "back":
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        return NextResponse.json(await respond());

      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        return NextResponse.json(await respond());

      case "refresh":
        await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
        return NextResponse.json(await respond());

      case "screenshot":
        return NextResponse.json(await finish());

      case "describe":
        // screenshot with the description forced — kept as its own action so
        // a caller can ask for a described look without knowing the flag.
        return NextResponse.json(await describeReply(await respond()));

      case "close":
        // Close the session's page, not the shared Browser — leaving CDP
        // attached means the next tool call skips the 5-10 s reconnect.
        // A Chromium of our OWN is the exception: nobody else sees it.
        await closeSession(sessionId as string);
        closeOwnedBrowserIfIdle();
        return NextResponse.json({ ok: true, browser: session.browser });

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
