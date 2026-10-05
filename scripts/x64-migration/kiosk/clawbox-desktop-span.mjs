// Lay the ClawBox desktop's Chrome APP window over every monitor of the
// session, through the kiosk Chrome's loopback DevTools port.
//
//   node clawbox-desktop-span.mjs <cdp port> <desktop url>          once
//   node clawbox-desktop-span.mjs <cdp port> <desktop url> --watch  every 2 s, until killed
//
// The watcher reads `wlr-randr` every 2 s, but asks Chrome's pages only when
// something may have changed: a look whose row is the one the last full pass
// spread the window over asks the BROWSER one question on a DevTools socket it
// keeps open (is that window still normal, and the row's size?) and lists the
// targets over HTTP (are the desktop's pages the ones that pass saw?). Either
// answer being no — or no answer — and the full pass runs at once, so a monitor
// plugged in or a window Chrome put back maximized is fixed as soon as it was.
// The shortcut costs the desktop's own page nothing: no DevTools session is
// attached to it and no script is run in it every 2 s. The full pass still
// runs every 30 s regardless (`createWatcher`).
//
// Monitor mode spreads ONE desktop over a row of monitors: the window sits at
// the layout's origin (labwc's window rule moves it there when it maps and
// holds it there) and is exactly as big as the row of enabled monitors, which
// `wlr-randr` reports. labwc's full screen covers one output, so the window is
// a NORMAL one sized to the row — and Chrome asks for that size itself
// (`Browser.setWindowBounds`), which labwc honours for a floating window.
//
// The web server applies monitor layouts and resizes the window too; this is
// the half that keeps the desktop whole when the web server is down, after a
// monitor is plugged in, and whenever Chrome restores the window in another
// state. A no-op when the window already spans the row.
//
// The app window is told from every other window by its display mode: an
// --app window is `standalone`. In full screen it is `fullscreen` — and so is
// an ordinary window the owner put in full screen, which is left alone — so a
// full-screen page is the desktop only when this watcher saw it as the app
// window before. Only the desktop shell's own pages (the desktop, sign-in,
// setup, the update screen) are looked at. Every DevTools call has a ceiling:
// a page behind a JS dialog answers nothing until the dialog closes, and a
// call left waiting would stop the watcher for good.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 4000;
/** One pass's ceiling, every target included. */
const PASS_MS = 8000;
const KNOWN_TARGETS = 16;
/** The watcher's look. */
const WATCH_MS = 2000;
/** The longest the watcher goes without a full pass while the row stands still. */
const FULL_PASS_MS = 30_000;

function wlrRandr() {
  return new Promise((resolve) => {
    execFile("wlr-randr", [], { timeout: TIMEOUT_MS }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

// The size an output takes in the layout: wlroots divides the pixel count by
// the scale in single precision and TRUNCATES (wlr_output_effective_resolution),
// so a 2560 px mode at 1.5x is 1706 px wide, not 1707.
const logical = (px, scale) => Math.trunc(Math.fround(px / Math.fround(scale)));

// The row of enabled monitors, from wlr-randr's text: each output's current
// mode, position, scale and rotation.
export function layoutBox(text) {
  const outs = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      cur = { enabled: false, w: 0, h: 0, x: 0, y: 0, scale: 1, rotated: false };
      outs.push(cur);
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = /^\s+Enabled:\s*(\w+)/.exec(line))) cur.enabled = m[1] === "yes";
    else if ((m = /^\s+(\d+)x(\d+) px, [\d.]+ Hz \([^)]*current[^)]*\)/.exec(line))) { cur.w = +m[1]; cur.h = +m[2]; }
    else if ((m = /^\s+Position:\s*(-?\d+),(-?\d+)/.exec(line))) { cur.x = +m[1]; cur.y = +m[2]; }
    else if ((m = /^\s+Scale:\s*([\d.]+)/.exec(line))) cur.scale = +m[1] || 1;
    else if ((m = /^\s+Transform:\s*(\S+)/.exec(line))) cur.rotated = /(^|-)(90|270)$/.test(m[1]);
  }
  const on = outs.filter((o) => o.enabled && o.w > 0 && o.h > 0);
  if (on.length === 0) return null;
  const rects = on.map((o) => {
    const [w, h] = o.rotated ? [o.h, o.w] : [o.w, o.h];
    return { x: o.x, y: o.y, w: logical(w, o.scale), h: logical(h, o.scale) };
  });
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  return {
    width: Math.max(...rects.map((r) => r.x + r.w)) - left,
    height: Math.max(...rects.map((r) => r.y + r.h)) - top,
  };
}

// The desktop shell's own pages (src/lib/kiosk-tabs.ts, SHELL_PATH_RE): the
// app window lands on these and nothing else; a page the desktop opened is a
// window of its own.
const SHELL_PATH_RE = /^\/(?:(?:login|setup|updating|portal)(?:\/.*)?)?$/;

export function isShellPage(url, desktopUrl) {
  try {
    const u = new URL(url);
    return u.origin === new URL(desktopUrl).origin && SHELL_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

const targetKey = (t) => (typeof t.id === "string" && t.id ? t.id : t.webSocketDebuggerUrl);
const isShellTarget = (t, desktopUrl) =>
  !!t && t.type === "page" && typeof t.webSocketDebuggerUrl === "string" && isShellPage(t.url, desktopUrl);

/**
 * The desktop shell's pages in a target list, in the list's order: each one's
 * key and address. Two lists with the same signature are the same pages for a
 * full pass — it asks only these, in this order — so while the signature holds
 * a full pass would ask the same pages the same questions. Null for a list
 * that is not one.
 */
export function shellSignature(targets, desktopUrl) {
  if (!Array.isArray(targets)) return null;
  return JSON.stringify(targets.filter((t) => isShellTarget(t, desktopUrl)).map((t) => [targetKey(t), t.url]));
}

const wait = (deadline) => Math.max(0, Math.min(TIMEOUT_MS, deadline - Date.now()));

// A DevTools session in which nothing waits for ever: a call unanswered past
// its ceiling ends the session, and so do the socket closing or failing; every
// call still waiting fails with it.
function session(wsUrl, deadline) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let next = 1;
    let over = false;
    const end = (why) => {
      if (over) return;
      over = true;
      clearTimeout(opening);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(why);
      }
      pending.clear();
      reject(why);
      try { ws.close(); } catch {}
    };
    const opening = setTimeout(() => end(new Error("timeout")), wait(deadline));
    ws.onerror = () => end(new Error("socket error"));
    ws.onclose = () => end(new Error("socket closed"));
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
    };
    ws.onopen = () => {
      if (over) return;
      clearTimeout(opening);
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            if (over) { rej(new Error("socket closed")); return; }
            const id = next++;
            const timer = setTimeout(() => end(new Error(`${method}: no answer`)), wait(deadline));
            pending.set(id, { resolve: res, reject: rej, timer });
            try { ws.send(JSON.stringify({ id, method, params })); } catch (err) { end(err); }
          }),
        close: () => end(new Error("closed")),
      });
    };
  });
}

const DISPLAY_MODE =
  "['fullscreen', 'standalone', 'minimal-ui', 'browser'].find((m) => matchMedia('(display-mode: ' + m + ')').matches) || ''";

/**
 * Spread the desktop's app window over `box`. `known` is the targets seen as
 * the app window so far (kept across a watcher's passes). Answers true when an
 * app window was found (and now spans the row); never throws, never takes
 * longer than one pass's ceiling. Given `found`, a pass that answers true
 * leaves on it the window's id and the `shellSignature` of the list it asked.
 *
 * @param {{ windowId?: number, shells?: string | null } | null} [found]
 */
export async function spanWindow(port, desktopUrl, box, known = [], found = null) {
  const deadline = Date.now() + PASS_MS;
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(TIMEOUT_MS) })).json();
  } catch {
    return false;
  }
  if (!Array.isArray(targets)) return false;
  for (const t of targets) {
    if (Date.now() >= deadline) break;
    if (!isShellTarget(t, desktopUrl)) continue;
    const key = targetKey(t);
    let s;
    try {
      s = await session(t.webSocketDebuggerUrl, deadline);
      const mode = (await s.send("Runtime.evaluate", { expression: DISPLAY_MODE, returnByValue: true }))?.result?.value;
      if (mode === "standalone") {
        if (!known.includes(key)) {
          known.push(key);
          if (known.length > KNOWN_TARGETS) known.shift();
        }
      } else if (mode !== "fullscreen" || !known.includes(key)) {
        continue;
      }
      const { windowId, bounds } = await s.send("Browser.getWindowForTarget");
      if (bounds.windowState !== "normal") {
        // Chrome refuses fullscreen/maximized → sized in one step.
        await s.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      }
      if (bounds.windowState !== "normal" || bounds.width !== box.width || bounds.height !== box.height) {
        await s.send("Browser.setWindowBounds", { windowId, bounds: { left: 0, top: 0, width: box.width, height: box.height } });
      }
      if (found) {
        found.windowId = windowId;
        found.shells = shellSignature(targets, desktopUrl);
      }
      return true;
    } catch {
      // A target that went away under us, or a page that does not answer.
    } finally {
      s?.close();
    }
  }
  return false;
}

/** Answers true when an app window was found (and now spans the row). */
async function span(port, desktopUrl, known) {
  const box = layoutBox(await wlrRandr());
  if (!box) return false;
  return spanWindow(port, desktopUrl, box, known);
}

async function getJson(url) {
  return (await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })).json();
}

/**
 * The `--watch` loop's look, as an object the suites can drive: `tick()` is one
 * look (answers what a full pass would: true when the app window spans the
 * row), `readBox` is the row (`wlr-randr`'s, by default) and `now` the clock.
 *
 * A full pass attaches to every desktop page Chrome lists and runs a script in
 * each — every 2 s, for ever, on a page the size of every monitor together. Most
 * looks change nothing, and the shortcut proves that without touching a page:
 *
 *   - the row is the one the last full pass spread the window over (a monitor
 *     plugged in, unplugged or re-set changes it);
 *   - the target list's desktop pages are the ones that pass asked, in the same
 *     order and at the same addresses (`shellSignature`) — so a full pass now
 *     would ask the same pages and find the same window;
 *   - and the browser itself says that window is `normal` and exactly the row's
 *     size (`Browser.getWindowBounds`, on a socket to the browser target kept
 *     open between looks — a question the browser process answers alone).
 *
 * All three hold: nothing to do, which is what the full pass would have found.
 * Any one fails, cannot be asked, or 30 s have passed since the last full pass:
 * the full pass, at once, in the same look.
 *
 * Those 30 s are counted on the monotonic clock (`performance.now()`), never
 * the wall clock: NTP steps that, and a step back held off the full pass —
 * the shortcut's safety net — for as long as the step.
 */
export function createWatcher(port, desktopUrl, { readBox = async () => layoutBox(await wlrRandr()), now = () => performance.now() } = {}) {
  const known = [];
  /** What the last full pass that found the window left: { box, windowId, shells, at }. */
  let steady = null;
  /** A DevTools session on the browser target, kept between looks; null when there is none. */
  let browser = null;

  const dropBrowser = () => {
    browser?.close();
    browser = null;
  };

  async function browserSession() {
    if (browser) return browser;
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    const url = version?.webSocketDebuggerUrl;
    if (typeof url !== "string" || !url) throw new Error("no browser endpoint");
    // No pass deadline: each call still has its own ceiling, and a call that
    // misses it ends the session (and the next look opens another).
    browser = await session(url, Infinity);
    return browser;
  }

  async function stillSpans(box) {
    const shells = shellSignature(await getJson(`http://127.0.0.1:${port}/json/list`), desktopUrl);
    if (shells === null || shells !== steady.shells) return false;
    const s = await browserSession();
    try {
      const bounds = (await s.send("Browser.getWindowBounds", { windowId: steady.windowId }))?.bounds;
      return !!bounds && bounds.windowState === "normal" && bounds.width === box.width && bounds.height === box.height;
    } catch (err) {
      // A window that is gone, a call past its ceiling, a socket that closed
      // (Chrome restarted): the full pass decides, and the next shortcut opens
      // a fresh session rather than telling these apart.
      dropBrowser();
      throw err;
    }
  }

  return {
    async tick() {
      const box = await readBox();
      if (!box) {
        steady = null;
        return false;
      }
      if (steady && steady.box.width === box.width && steady.box.height === box.height && now() - steady.at < FULL_PASS_MS) {
        try {
          if (await stillSpans(box)) return true;
        } catch {
          // Could not be asked: the full pass decides.
        }
      }
      const found = {};
      const spans = await spanWindow(port, desktopUrl, box, known, found);
      steady = spans && found.windowId !== undefined && found.shells
        ? { box, windowId: found.windowId, shells: found.shells, at: now() }
        : null;
      return spans;
    },
  };
}

async function main() {
  const [port, desktopUrl, mode] = process.argv.slice(2);
  if (!port || !desktopUrl) {
    console.error("usage: clawbox-desktop-span.mjs <cdp port> <desktop url> [--watch]");
    process.exit(2);
  }
  new URL(desktopUrl);
  if (mode === "--watch") {
    const watcher = createWatcher(port, desktopUrl);
    for (;;) {
      try { await watcher.tick(); } catch {}
      await new Promise((r) => setTimeout(r, WATCH_MS));
    }
  }
  process.exit((await span(port, desktopUrl, [])) ? 0 : 1);
}

// Run as a program; imported (by the suites, for `layoutBox`), it does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
