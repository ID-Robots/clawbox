export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const CDP_PORT = 18800;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

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

// In-memory session store (single user device). Sessions only hold page
// refs now — the Playwright Browser + context are cached once per process
// and reused across sessions. The previous design called connectOverCDP on
// every launch, which piled up concurrent CDP clients and could stall the
// second connect for 5+ s under load; agents surfaced that as
// "Browser control is currently blocked by a CDP connection timeout
// (ws://127.0.0.1:18800)".
interface BrowserSession {
  page: import("playwright").Page;
  lastActivity: number;
}

const sessions: Map<string, BrowserSession> = new Map();
let sessionCounter = 0;

// Close the page (not the shared Browser) after 10 min of inactivity so a
// stale cleanup doesn't tear the CDP connection out from under the next
// tool call.
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      session.page.close().catch(() => {});
      sessions.delete(id);
      console.log(`[Browser] Cleaned up stale session: ${id}`);
    }
  }
}, 60_000);

// Shared Playwright Browser handle, reused across sessions. Recreated on
// next access if the underlying Chromium disconnects (e.g. service restart).
let cachedBrowser: import("playwright").Browser | null = null;
let cachedBrowserPromise: Promise<import("playwright").Browser> | null = null;

async function isDesktopBrowserReady(): Promise<boolean> {
  try {
    // 3 s rides out a Jetson load spike without dragging out a legit failure.
    const res = await fetch(`${CDP_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDesktopBrowserRunning(): Promise<void> {
  if (await isDesktopBrowserReady()) return;

  try {
    await exec("/usr/bin/sudo", ["/usr/bin/systemctl", "start", "clawbox-browser.service"], { timeout: 5000 });
  } catch (err) {
    console.warn("[Browser] systemctl start clawbox-browser.service failed:", err instanceof Error ? err.message : err);
  }

  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await isDesktopBrowserReady()) return;
  }

  throw new Error(`Desktop Chromium is not available on CDP port ${CDP_PORT}`);
}

async function getPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright not installed. Run: bunx playwright install chromium");
  }
}

async function getSharedBrowser(): Promise<import("playwright").Browser> {
  if (cachedBrowser?.isConnected()) return cachedBrowser;
  if (cachedBrowserPromise) return cachedBrowserPromise;

  cachedBrowserPromise = (async () => {
    const pw = await getPlaywright();
    await ensureDesktopBrowserRunning();
    try {
      const browser = await pw.chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 10_000 });
      browser.on("disconnected", () => {
        if (cachedBrowser === browser) cachedBrowser = null;
        console.log("[Browser] Shared CDP connection disconnected; will reconnect on next launch");
      });
      cachedBrowser = browser;
      return browser;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Browser] connectOverCDP(${CDP_ENDPOINT}) failed:`, msg);
      throw new Error(`Failed to attach to desktop Chromium via CDP at ${CDP_ENDPOINT}: ${msg}`);
    } finally {
      cachedBrowserPromise = null;
    }
  })();

  return cachedBrowserPromise;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action, sessionId } = body;

    if (action === "launch") {
      const browser = await getSharedBrowser();
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("Desktop Chromium did not expose a browser context");
      }

      const page = context.pages().at(-1) ?? await context.newPage();
      await page.bringToFront().catch(() => {});

      const { url } = body;
      if (url) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      }

      const id = `browser-${++sessionCounter}`;
      sessions.set(id, { page, lastActivity: Date.now() });

      const screenshot = await page.screenshot({ type: "png" }).catch(() => null);

      return NextResponse.json({
        sessionId: id,
        url: page.url(),
        title: await page.title().catch(() => ""),
        screenshot: screenshot ? screenshot.toString("base64") : null,
      });
    }

    // All other actions require a session
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) {
      return NextResponse.json({ error: "No active browser session" }, { status: 400 });
    }

    session.lastActivity = Date.now();
    const { page } = session;

    const respond = async (skipScreenshot = false) => {
      const screenshot = skipScreenshot ? null : await page.screenshot({ type: "png" }).catch(() => null);
      return {
        url: page.url(),
        title: await page.title().catch(() => ""),
        screenshot: screenshot ? screenshot.toString("base64") : null,
        canGoBack: await page.evaluate(() => window.history.length > 1).catch(() => false),
        canGoForward: false,
      };
    };

    const validCoord = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

    switch (action) {
      case "navigate": {
        const { url } = body;
        if (!url) return NextResponse.json({ error: "URL required" }, { status: 400 });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        return NextResponse.json(await respond());
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
        return NextResponse.json({ ok: true });
      }

      case "keydown": {
        const { key } = body;
        const pwKey = KEY_MAP[key] || key;
        // Single printable character → type it; special key → press it
        if (pwKey.length === 1 && !KEY_MAP[key]) {
          await page.keyboard.type(pwKey);
        } else {
          await page.keyboard.press(pwKey);
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
        return NextResponse.json(await respond());

      case "close":
        // Close the session's page, not the shared Browser — leaving CDP
        // attached means the next tool call skips the 5-10 s reconnect.
        await session.page.close().catch(() => {});
        sessions.delete(sessionId);
        return NextResponse.json({ ok: true });

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
