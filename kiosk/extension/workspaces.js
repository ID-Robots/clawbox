// ClawBox Kiosk Tabs — the linked-box switcher on every page (TASK-2519).
//
// Ctrl+Shift+1 … Ctrl+Shift+9 shows ClawBox 1 … 9, like workspaces: 1 is the
// box this kiosk runs on, 2–9 its Settings → Linked ClawBoxes, in order. The
// worker keeps every box in a tab of its own and activates it, opening it on
// first use, so a box's desktop stays loaded and switching back is instant.
// By `code`, never `key` (with Shift held, `key` depends on the layout), and
// only for a key the owner pressed (`isTrusted`): a page must not be able to
// switch the screen by dispatching a keydown of its own.
//
// The manifest runs this on EVERY http(s) page, an entry of its own at
// document_start, and newtab.html loads it with a script tag, so the keys work
// on another box's desktop and on any page a desktop opened. It marks the page
// with SWITCHER_ATTR before the page's own scripts run: the ClawBox desktop's
// own handler (src/lib/use-box-switcher.ts, which in any other browser
// navigates the tab) stands down wherever the mark is, so one key press is one
// switch — and at document_start its listener is also the first on `window`.
//
// On the kiosk's own desktop ("/" of a DESKTOP_ORIGINS origin, the list
// background.js and desktop.js share) it also reads the list from the box —
// GET /setup-api/linked-boxes, same origin, the owner's session — and hands it
// to the worker: at load, whenever Settings saves it (LINKED_BOXES_EVENT) and
// whenever the desktop is shown again. The worker asks for it here too
// ({ type: "readBoxes" }) when it has none stored yet.
//
// The worker answers a switch by sending the tab it activated a
// { type: "boxIndicator", slot, kind, name, names, text? }, drawn here in a
// shadow root: a row of numbered dots, the slot lit, and the box's name (or,
// for an empty slot, `text` — the box's own words for it, in the box's
// language, which the list's answer carries as `labels`). A tab it had to open
// is not listening yet, so it keeps the indicator, and this script asks for it
// once it runs ({ type: "pendingIndicator" }).

(() => {
  if (globalThis.clawboxKioskWorkspaces) return;

  const DESKTOP_ORIGINS = [
    "http://localhost:3005/",
    "http://127.0.0.1:3005/",
    "http://localhost/",
    "http://127.0.0.1/",
  ];
  const SWITCHER_ATTR = "data-clawbox-box-switcher";
  const LINKED_BOXES_EVENT = "clawbox:linked-boxes-changed";
  const LINKED_BOXES_PATH = "/setup-api/linked-boxes";
  const INDICATOR_MS = 1800;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  function slotOf(e) {
    if (!e || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.isComposing) return null;
    const m = /^Digit([1-9])$/.exec(e.code || "");
    return m ? Number(m[1]) : null;
  }

  const mark = () => {
    if (document.documentElement && !document.documentElement.hasAttribute(SWITCHER_ATTR)) {
      document.documentElement.setAttribute(SWITCHER_ATTR, "kiosk");
    }
  };
  mark();
  document.addEventListener("DOMContentLoaded", mark);

  window.addEventListener("keydown", (e) => {
    const slot = slotOf(e);
    if (slot === null || !e.isTrusted) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    send({ type: "switchBox", slot });
  }, true);

  // ─── The indicator ───
  const STYLE = `
    :host { all: initial; position: fixed; top: 64px; left: 50%; transform: translateX(-50%); z-index: 2147483647; pointer-events: none; }
    .box { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px 20px; max-width: min(92vw, 520px);
      border-radius: 16px; background: rgba(17, 24, 39, 0.92); border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45); font: 500 14px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; }
    .dots { display: flex; gap: 8px; }
    .dot { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 600; background: rgba(255, 255, 255, 0.1); color: rgba(255, 255, 255, 0.7); }
    .dot.empty { background: transparent; border: 1px dashed rgba(255, 255, 255, 0.25); color: rgba(255, 255, 255, 0.4); }
    .dot.lit { background: #f97316; color: #fff; border: none; }
    .text { max-width: 100%; text-align: center; overflow-wrap: anywhere; }`;

  let host = null;
  let hideTimer = 0;

  function indicatorText(ind) {
    if (ind.kind === "empty") {
      if (typeof ind.text === "string" && ind.text) return ind.text;
      return `Nothing on Ctrl+Shift+${ind.slot} yet. Add a ClawBox in Settings → Linked ClawBoxes.`;
    }
    return `${ind.slot} · ${ind.name || ""}`;
  }

  function showIndicator(ind) {
    if (window.top !== window || !ind || !Number.isInteger(ind.slot)) return;
    const names = Array.isArray(ind.names) ? ind.names : [];
    const count = Math.min(9, Math.max(names.length, ind.slot));
    if (!host) {
      host = document.createElement("div");
      host.id = "clawbox-kiosk-workspaces";
      host.attachShadow({ mode: "open" });
    }
    const root = host.shadowRoot;
    root.textContent = "";
    const style = document.createElement("style");
    style.textContent = STYLE;
    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "status");
    box.dataset.slot = String(ind.slot);
    box.dataset.kind = String(ind.kind || "");
    const dots = document.createElement("div");
    dots.className = "dots";
    for (let slot = 1; slot <= count; slot++) {
      const dot = document.createElement("span");
      dot.className = "dot" + (slot === ind.slot ? " lit" : slot > names.length ? " empty" : "");
      dot.textContent = String(slot);
      dots.appendChild(dot);
    }
    const text = document.createElement("div");
    text.className = "text";
    // Text, never markup: a name is the owner's, but it came over a message.
    text.textContent = indicatorText(ind);
    box.append(dots, text);
    root.append(style, box);
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => host && host.remove(), INDICATOR_MS);
  }

  // ─── The list, from the kiosk's own desktop ───
  const isDesktop = DESKTOP_ORIGINS.includes(location.origin + "/") && location.pathname === "/";

  async function readBoxes() {
    try {
      const res = await fetch(LINKED_BOXES_PATH, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return null;
      const body = await res.json();
      return {
        selfName: body && body.self && typeof body.self.name === "string" ? body.self.name : "",
        boxes: body && Array.isArray(body.boxes) ? body.boxes : [],
        emptyText: body && body.labels && typeof body.labels.empty === "string" ? body.labels.empty : "",
      };
    } catch {
      return null;
    }
  }

  async function pushBoxes() {
    const list = await readBoxes();
    if (list) send({ type: "boxes", selfName: list.selfName, boxes: list.boxes, emptyText: list.emptyText });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return undefined;
    if (msg.type === "boxIndicator") {
      showIndicator(msg);
      // Answered, so the worker knows it was drawn and keeps no copy for later.
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg.type === "readBoxes" && isDesktop) {
      readBoxes().then(sendResponse);
      return true; // async sendResponse
    }
    return undefined;
  });

  if (isDesktop) {
    pushBoxes();
    window.addEventListener(LINKED_BOXES_EVENT, pushBoxes);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pushBoxes(); });
  }

  // A switch that opened this tab left its indicator with the worker.
  if (window.top === window) {
    send({ type: "pendingIndicator" }).then((ind) => { if (ind && ind.type === "boxIndicator") showIndicator(ind); });
  }

  globalThis.clawboxKioskWorkspaces = { slotOf, showIndicator, isDesktop };
})();
