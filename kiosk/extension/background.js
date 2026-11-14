// ClawBox Kiosk Tabs — service worker.
//
// The kiosk Chrome runs --kiosk: no tab strip. The content scripts draw one
// instead — the bar on every page the desktop OPENED, and on the desktop
// itself, always (desktop.js) — and ask this worker, which holds the `tabs`
// permission, to do the switching. Messages:
//   { type: "list" } → { tabs, currentId } (every tab but the desktop's);
//   { type: "activate", id }; { type: "close", id }; { type: "home" };
//   { type: "closeSelf" } — back to the desktop, then close the asking tab;
//   { type: "create" } — a new active tab on the extension's own start page
//     (newtab.html, also chrome_url_overrides.newtab), the bar's "+";
//   { type: "devtools" } — Chrome's DevTools on the asking tab (see
//     openDevTools below);
//   { type: "switchBox", slot } — Ctrl+Shift+<slot> from workspaces.js: show
//     linked ClawBox <slot>, each in a tab of its own (see switchBox below);
//   { type: "boxes", selfName, boxes } — the desktop's copy of the list;
//   { type: "pendingIndicator" } — the indicator a switch left for this tab.
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
// it cannot open them. `debugger` is only for getTargets(),
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
      reject(new Error("the kiosk's DevTools port refused the extension"));
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

// Every tab of the kiosk window (the --kiosk Chrome has the one).
function normalTabs() {
  return chrome.tabs.query({ windowType: "normal" });
}

async function listTabs(sender) {
  const all = await normalTabs();
  return {
    currentId: sender.tab ? sender.tab.id : null,
    tabs: all
      .filter((t) => !isDesktop(t.url))
      .map((t) => ({ id: t.id, title: t.title || "", url: t.url || "", favicon: t.favIconUrl || "" })),
  };
}

async function goHome() {
  const all = await normalTabs();
  const home = all.find((t) => isDesktop(t.url));
  if (home) {
    await chrome.tabs.update(home.id, { active: true });
    return home;
  }
  // The desktop tab is gone (closed by hand): bring it back rather than
  // leave the owner on a page with no way out.
  return chrome.tabs.create({ url: DESKTOP_ORIGINS[0], active: true });
}

// ─── Linked ClawBoxes (TASK-2519) ───
//
// Ctrl+Shift+1 … Ctrl+Shift+9 (workspaces.js, on every page) lands here as
// { type: "switchBox", slot }. Slot 1 is this box — the desktop tab, goHome —
// and 2–9 Settings → Linked ClawBoxes in order (src/lib/linked-boxes-shape.ts
// holds the same rules for the box's side). Each box is a tab of its own: the
// one this worker opened for it while that tab still shows the box, else any
// tab on the box's origin (the box's desktop first), else a new one. Activated,
// never navigated, so a box's desktop stays loaded and switching back is
// instant. The list is the desktop's: workspaces.js reads it there (the
// owner's session, same origin) and sends it in; the worker keeps the last
// copy in chrome.storage.local so a switch never waits for the desktop, and
// asks the desktop tab for it while it has none.
const MAX_BOXES = 8;
const MAX_BOX_NAME = 40;
const BOXES_KEY = "linkedBoxes";
const BOX_TABS_KEY = "linkedBoxTabs";
const PENDING_KEY = "linkedBoxIndicators";
const PENDING_TTL_MS = 15000;
const MAX_LABEL = 300;

function boxName(raw) {
  if (typeof raw !== "string") return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(raw)) return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return name && [...name].length <= MAX_BOX_NAME ? name : null;
}

function webOrigin(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** A box's desktop, `<origin>/`: http(s) only, no user name or password. */
function boxUrl(raw) {
  if (typeof raw !== "string" || raw.length > 300) return null;
  try {
    const u = new URL(raw);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !u.hostname) return null;
    return `${u.origin}/`;
  } catch {
    return null;
  }
}

function cleanBoxes(raw) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_BOXES) break;
    const name = boxName(entry && entry.name);
    const url = boxUrl(entry && entry.url);
    // The kiosk's own desktop is slot 1, never a box of its own.
    if (!name || !url || seen.has(url) || DESKTOP_ORIGINS.includes(url)) continue;
    seen.add(url);
    out.push({ name, url });
  }
  return out;
}

function tabUrl(t) {
  return t.url || t.pendingUrl || "";
}

async function storedBoxes() {
  const got = await chrome.storage.local.get(BOXES_KEY);
  return got[BOXES_KEY] || null;
}

/** The box's words for an empty slot (`{n}` for the number), or "". */
function cleanLabel(raw) {
  if (typeof raw !== "string" || raw.length > MAX_LABEL || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) return "";
  return raw.trim();
}

async function saveBoxes(list) {
  const clean = {
    selfName: boxName(list && list.selfName) || "",
    boxes: cleanBoxes(list && list.boxes),
    emptyText: cleanLabel(list && list.emptyText),
  };
  await chrome.storage.local.set({ [BOXES_KEY]: clean });
  return clean;
}

async function askDesktopForBoxes() {
  const all = await normalTabs();
  const desk = all.find((t) => t.id != null && isDesktop(t.url) && webOrigin(t.url) && new URL(t.url).pathname === "/");
  if (!desk) return null;
  try {
    const list = await chrome.tabs.sendMessage(desk.id, { type: "readBoxes" });
    return list ? saveBoxes(list) : null;
  } catch {
    return null;
  }
}

async function sessionGet(key) {
  return (await chrome.storage.session.get(key))[key] || {};
}

// Every read-change-write of the session maps runs one after the other, so
// two quick key presses cannot each read the map and lose the other's entry.
let sessionQueue = Promise.resolve();
function sessionUpdate(key, change) {
  const run = sessionQueue.then(async () => {
    const next = change(await sessionGet(key));
    await chrome.storage.session.set({ [key]: next });
    return next;
  });
  sessionQueue = run.catch(() => undefined);
  return run;
}

async function tabForBox(box) {
  const origin = webOrigin(box.url);
  const all = await normalTabs();
  const remembered = (await sessionGet(BOX_TABS_KEY))[origin];
  // Never the desktop's own tab, whatever the list says.
  const boxTabs = all.filter((t) => t.id != null && !isDesktop(tabUrl(t)) && webOrigin(tabUrl(t)) === origin);
  const mine = boxTabs.find((t) => t.id === remembered);
  if (mine) return mine;
  // Else one already on the box, its desktop before its other pages.
  return boxTabs.find((t) => new URL(tabUrl(t)).pathname === "/") || boxTabs[0] || null;
}

function rememberBoxTab(origin, tabId) {
  return sessionUpdate(BOX_TABS_KEY, (tabs) => ({ ...tabs, [origin]: tabId }));
}

// The indicator goes to the tab now on screen; one that is still loading has
// nobody listening yet, so it is kept for that tab to ask for.
async function indicate(tabId, indicator) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, indicator);
  } catch {
    const now = Date.now();
    await sessionUpdate(PENDING_KEY, (pending) => {
      // Only what is still fresh: a tab that never loaded leaves nothing behind.
      const kept = Object.fromEntries(Object.entries(pending).filter(([, ind]) => ind && now - (ind.at || 0) <= PENDING_TTL_MS));
      kept[String(tabId)] = { ...indicator, at: now };
      return kept;
    });
  }
}

async function takePendingIndicator(tabId) {
  if (tabId == null) return null;
  let ind = null;
  await sessionUpdate(PENDING_KEY, (pending) => {
    ind = pending[String(tabId)] || null;
    return Object.fromEntries(Object.entries(pending).filter(([id]) => id !== String(tabId)));
  });
  return ind && Date.now() - (ind.at || 0) <= PENDING_TTL_MS ? ind : null;
}

async function switchBox(slot, sender) {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_BOXES + 1) return { ok: false, error: "no such slot" };
  const list = (await storedBoxes()) || (await askDesktopForBoxes()) || { selfName: "", boxes: [] };
  const boxes = cleanBoxes(list.boxes);
  const selfName = boxName(list.selfName) || "ClawBox";
  const names = [selfName, ...boxes.map((b) => b.name)];
  if (slot === 1) {
    const home = await goHome();
    await indicate(home && home.id, { type: "boxIndicator", slot, kind: "stay", name: selfName, names });
    return { ok: true };
  }
  const box = boxes[slot - 2];
  if (!box) {
    const text = cleanLabel(list.emptyText).replace("{n}", String(slot));
    await indicate(sender.tab && sender.tab.id, { type: "boxIndicator", slot, kind: "empty", name: null, names, ...(text ? { text } : {}) });
    return { ok: true };
  }
  let tab = await tabForBox(box);
  if (tab) await chrome.tabs.update(tab.id, { active: true });
  else tab = await chrome.tabs.create({ url: box.url, active: true });
  await rememberBoxTab(webOrigin(box.url), tab.id);
  await indicate(tab.id, { type: "boxIndicator", slot, kind: "stay", name: box.name, names });
  return { ok: true };
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
      case "closeSelf":
        // Land on the desktop first: closing the only foreground page
        // otherwise leaves Chrome showing whichever tab it picks.
        await goHome();
        if (sender.tab && sender.tab.id != null) await chrome.tabs.remove(sender.tab.id);
        return { ok: true };
      case "devtools":
        if (!sender.tab || sender.tab.id == null) return { ok: false, error: "not from a tab" };
        await openDevTools(sender.tab.id);
        return { ok: true };
      case "create":
        await chrome.tabs.create({ url: START_PAGE, active: true });
        return { ok: true };
      case "switchBox":
        return switchBox(msg.slot, sender);
      case "boxes":
        // The kiosk's own desktop only: no other page speaks for the list.
        if (!sender.tab || !isDesktop(sender.tab.url) || new URL(sender.tab.url).pathname !== "/") return { ok: false, error: "not from the desktop" };
        await saveBoxes(msg);
        return { ok: true };
      case "pendingIndicator":
        return takePendingIndicator(sender.tab && sender.tab.id);
      default:
        return { ok: false, error: "unknown message" };
    }
  };
  run().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async sendResponse
});

// Tell every bar to refresh when the tab set changes — the desktop's too —
// without waiting for their own poll.
function broadcast() {
  normalTabs().then((tabs) => {
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: "changed" }).catch(() => {});
    }
  });
}
// Tab events come in bursts: one page load is a url, a title, a favicon and
// a "complete" (onUpdated fires for each), a new tab is onCreated then
// onActivated, a close onRemoved then onActivated. Each used to be its own
// broadcast, and each broadcast has every tab ask for the list again. The
// first event of a burst schedules ONE broadcast BROADCAST_DELAY_MS later and
// the rest of the burst joins it; it is sent after all of them, so every bar
// still reads the tabs as they ended up, and a stream that never pauses (a
// title that ticks) still gets one broadcast per window rather than none.
const BROADCAST_DELAY_MS = 150;
let broadcastTimer = 0;
function broadcastSoon() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = 0;
    broadcast();
  }, BROADCAST_DELAY_MS);
}
chrome.tabs.onCreated.addListener(broadcastSoon);
chrome.tabs.onRemoved.addListener(broadcastSoon);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.title || info.url || info.favIconUrl || info.status === "complete") broadcastSoon();
});
chrome.tabs.onActivated.addListener(broadcastSoon);

// One desktop tab, not two. Every relaunch of the kiosk Chrome restores the
// previous session's tabs AND opens the command-line URL, so the profile
// accumulates a hidden desktop tab per restart (a reboot leaves the profile
// marked Crashed, which is what triggers the restore). Keep the desktop tab
// the user is looking at (the active one, else the first) and close the rest.
async function dedupeDesktopTabs() {
  try {
    const all = await normalTabs();
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
