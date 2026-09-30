// ClawBox Kiosk Tabs — service worker.
//
// The kiosk Chrome on the x64 laptop runs --kiosk: no tab strip. The content
// scripts draw one instead — the bar on every page the desktop OPENED, and on
// the desktop itself while such a page is open (desktop.js) — and ask this
// worker, which holds the `tabs` permission, to do the switching. Messages: { type: "list" } → { tabs, currentId, homeId };
// { type: "activate", id }; { type: "close", id }; { type: "home" };
// { type: "create", url? } opens a new active tab: on the extension's own
// start page (newtab.html, also chrome_url_overrides.newtab) when no URL is
// given — which is what the bar's "+" sends — else on the http(s) URL given;
// { type: "devtools" } opens Chrome's DevTools on the asking tab (see
// openDevTools below).
//
// The desktop is found by URL prefix: the origin of DESKTOP_ORIGINS, which is
// what the launcher's CLAWBOX_KIOSK_URL is on a laptop (a different URL means
// editing this list and manifest.json's exclude_matches together).

const DESKTOP_ORIGINS = [
  "http://localhost:3005/",
  "http://127.0.0.1:3005/",
  "http://localhost/",
  "http://127.0.0.1/",
];
// The pages the shell itself lands on. /app/<id> and /apps/<id>/ on the same
// origin are pages the desktop opened, and get a bar like any other.
const SHELL_PATH = /^\/(?:(?:login|setup|updating|portal)(?:\/.*)?)?$/;
// The extension's own start page. Opened by its full URL rather than
// chrome://newtab so the tab lands on it whether or not Chrome honours the
// override in --kiosk.
const START_PAGE = chrome.runtime.getURL("newtab.html");

// DevTools for a tab. --kiosk leaves no menu to open them from, so the bar
// asks here (its </> button, F12, Ctrl+Shift+I) and this asks Chrome itself
// over the loopback DevTools port the launcher opens — CLAWBOX_KIOSK_CDP_PORT
// in install-kiosk-tabs.sh, 18801 by default, the port src/lib/kiosk-tabs.ts
// lists the tabs on. `Target.openDevTools` opens the same DevTools F12 does,
// docked in the kiosk window. The port refuses a WebSocket from a page's
// origin, so the launcher lists this extension's own
// (--remote-allow-origins=chrome-extension://<id>); without it the bar says
// the kiosk needs the script run again. `debugger` is only for getTargets(),
// the one map from a tab to its DevTools target — nothing here attaches.
const CDP_PORT = 18801;
const CDP_TIMEOUT_MS = 5000;

function cdpCall(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (err) { reject(err); return; }
    const timer = setTimeout(() => { ws.close(); reject(new Error("the kiosk's DevTools port did not answer")); }, CDP_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("the kiosk's DevTools port refused the extension; run install-kiosk-tabs.sh again"));
    };
  });
}

async function openDevTools(tabId) {
  const targets = await chrome.debugger.getTargets();
  const target = targets.find((t) => t.tabId === tabId && t.type === "page");
  if (!target) throw new Error("this tab has no DevTools target");
  let version;
  try {
    version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  } catch {
    throw new Error(`nothing answers on the kiosk's DevTools port ${CDP_PORT}`);
  }
  await cdpCall(version.webSocketDebuggerUrl, "Target.openDevTools", { targetId: target.id });
}

function isDesktop(url) {
  if (!url) return false;
  for (const origin of DESKTOP_ORIGINS) {
    if (!url.startsWith(origin)) continue;
    const path = url.slice(origin.length - 1).split(/[?#]/)[0];
    if (SHELL_PATH.test(path)) return true;
  }
  return false;
}

async function listTabs(sender) {
  const all = await chrome.tabs.query({ windowType: "normal" });
  const home = all.find((t) => isDesktop(t.url));
  return {
    homeId: home ? home.id : null,
    currentId: sender.tab ? sender.tab.id : null,
    tabs: all
      .filter((t) => !isDesktop(t.url))
      .map((t) => ({ id: t.id, title: t.title || "", url: t.url || "", favicon: t.favIconUrl || "", active: !!t.active })),
  };
}

async function goHome() {
  const all = await chrome.tabs.query({ windowType: "normal" });
  const home = all.find((t) => isDesktop(t.url));
  if (home) {
    await chrome.tabs.update(home.id, { active: true });
  } else {
    // The desktop tab is gone (closed by hand): bring it back rather than
    // leave the owner on a page with no way out.
    await chrome.tabs.create({ url: DESKTOP_ORIGINS[0], active: true });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    switch (msg && msg.type) {
      case "list":
        return listTabs(sender);
      case "activate":
        await chrome.tabs.update(msg.id, { active: true });
        return { ok: true };
      case "close":
        await chrome.tabs.remove(msg.id);
        return { ok: true };
      case "home":
        await goHome();
        return { ok: true };
      case "devtools":
        if (!sender.tab || sender.tab.id == null) return { ok: false, error: "not from a tab" };
        await openDevTools(sender.tab.id);
        return { ok: true };
      case "create": {
        if (msg.url == null) {
          await chrome.tabs.create({ url: START_PAGE, active: true });
          return { ok: true };
        }
        // Otherwise only a web page: a tab opened from the bar must not land
        // on a chrome:// or file:// URL the kiosk otherwise never shows.
        if (typeof msg.url !== "string" || !/^https?:\/\//i.test(msg.url)) return { ok: false, error: "not a web url" };
        await chrome.tabs.create({ url: msg.url, active: true });
        return { ok: true };
      }
      default:
        return { ok: false, error: "unknown message" };
    }
  };
  run().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async sendResponse
});

// Tell every bar to refresh when the tab set changes — the desktop's too,
// which shows its bar when the first page opens and hides it when the last
// one closes — without waiting for their own poll.
function broadcast() {
  chrome.tabs.query({ windowType: "normal" }).then((tabs) => {
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: "changed" }).catch(() => {});
    }
  });
}
chrome.tabs.onCreated.addListener(broadcast);
chrome.tabs.onRemoved.addListener(broadcast);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.title || info.url || info.favIconUrl || info.status === "complete") broadcast();
});
chrome.tabs.onActivated.addListener(broadcast);

// One desktop tab, not two. Every relaunch of the kiosk Chrome restores the
// previous session's tabs AND opens the command-line URL, so the profile
// accumulates a hidden desktop tab per restart (a reboot leaves the profile
// marked Crashed, which is what triggers the restore). Keep the desktop tab
// the user is looking at (the active one, else the first) and close the rest.
async function dedupeDesktopTabs() {
  try {
    const all = await chrome.tabs.query({ windowType: "normal" });
    const desktops = all.filter((t) => t.id != null && isDesktop(t.url));
    if (desktops.length < 2) return;
    const keep = desktops.find((t) => t.active) || desktops[0];
    await chrome.tabs.remove(desktops.filter((t) => t.id !== keep.id).map((t) => t.id));
  } catch {
    // A tab that closed under us; nothing to do.
  }
}
chrome.runtime.onStartup.addListener(dedupeDesktopTabs);
chrome.runtime.onInstalled.addListener(dedupeDesktopTabs);
// The worker also starts fresh after a relaunch without either event firing
// reliably; session restore takes a moment, so ask again shortly after.
setTimeout(dedupeDesktopTabs, 2500);
