// ClawBox Kiosk Tabs — the bar on every page the desktop opened.
//
// Fixed 36 px strip at the top, in a shadow root so the page's CSS cannot
// restyle it and ours cannot leak into the page. The page is pushed down by
// the same 36 px (content.css) so nothing sits under the bar. Everything the
// bar does that needs the `tabs` permission goes through background.js; the
// address bar navigates THIS page and needs nothing — location is the page's
// own, and a content script may set it.
//
// Left to right: ClawBox home, the tab chips, the address bar, "+" (a new
// tab on the start page), Close.

(() => {
  if (window.top !== window || document.getElementById("clawbox-kiosk-bar")) return;

  const BAR_H = 36;
  // Where "+" lands and what the desktop's own Web icon opens
  // (src/lib/desktop-apps.ts, id "web"); the extension test holds them equal.
  const START_URL = "https://duckduckgo.com/";
  const SEARCH_URL = "https://duckduckgo.com/?q=";
  // Typed text that is an address rather than a search: http(s)://…, or a
  // host — something with a dot and no whitespace ("example.com",
  // "example.com/path?x=1"). Everything else is searched. No flag on the
  // literal, so the test can lift it out of this file; the input is lowered
  // before the test.
  const URL_LIKE = /^(?:https?:\/\/\S+|\S+\.\S+)$/;

  const host = document.createElement("div");
  host.id = "clawbox-kiosk-bar";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; top: 0; left: 0; right: 0; height: ${BAR_H}px; z-index: 2147483647; }
      .bar { box-sizing: border-box; height: ${BAR_H}px; display: flex; align-items: center; gap: 6px; padding: 0 8px;
        background: rgba(17, 24, 39, 0.96); border-bottom: 1px solid rgba(255,255,255,0.12);
        font: 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: rgba(255,255,255,0.85);
        box-shadow: 0 1px 6px rgba(0,0,0,0.35); }
      button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 28px;
        padding: 0 10px; border-radius: 8px; color: inherit; white-space: nowrap; }
      button:hover { background: rgba(255,255,255,0.10); }
      button:active { background: rgba(255,255,255,0.16); }
      .home { color: #fe6e00; font-weight: 600; }
      .home img { width: 18px; height: 18px; }
      .sep { width: 1px; height: 22px; background: rgba(255,255,255,0.12); margin: 0 2px; flex: none; }
      .tabs { display: flex; align-items: center; gap: 2px; flex: 1 1 0; min-width: 0; overflow: hidden; }
      .tab { max-width: 220px; padding-right: 4px; }
      .tab.current { background: rgba(255,255,255,0.14); }
      .tab img { width: 14px; height: 14px; border-radius: 2px; flex: none; }
      .tab .t { overflow: hidden; text-overflow: ellipsis; }
      .x { height: 22px; width: 22px; padding: 0; justify-content: center; border-radius: 11px; color: rgba(255,255,255,0.5); }
      .x:hover { color: #fff; background: rgba(255,255,255,0.18); }
      .address { all: unset; box-sizing: border-box; flex: 1 1 0; min-width: 140px; max-width: 520px; height: 28px;
        padding: 0 10px; border-radius: 8px; background: rgba(255,255,255,0.08); color: inherit;
        font: inherit; line-height: 28px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .address::placeholder { color: rgba(255,255,255,0.4); }
      .address:hover { background: rgba(255,255,255,0.12); }
      .address:focus { background: rgba(255,255,255,0.14); color: #fff; outline: 1px solid rgba(254,110,0,0.7); }
      .add { flex: none; width: 28px; padding: 0; justify-content: center; font-size: 18px; line-height: 1; color: rgba(255,255,255,0.7); }
      .close { flex: none; color: rgba(255,255,255,0.7); }
    </style>
    <div class="bar" role="toolbar" aria-label="ClawBox">
      <button class="home" title="Back to ClawBox"><img alt="" src="${chrome.runtime.getURL("icon.svg")}"><span>ClawBox</span></button>
      <span class="sep"></span>
      <div class="tabs"></div>
      <span class="sep"></span>
      <input class="address" type="text" spellcheck="false" autocomplete="off" autocapitalize="off"
        placeholder="Search or enter address" title="Search or enter address" aria-label="Address">
      <button class="add" title="New tab">+</button>
      <button class="close" title="Close this page">✕ Close</button>
    </div>`;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const tabsEl = root.querySelector(".tabs");
  const addressEl = root.querySelector(".address");
  root.querySelector(".home").addEventListener("click", () => send({ type: "home" }));
  root.querySelector(".add").addEventListener("click", () => send({ type: "create", url: START_URL }));
  root.querySelector(".close").addEventListener("click", async () => {
    // Land on the desktop, then close: closing the only foreground page
    // otherwise leaves Chrome showing whichever tab it picks.
    const me = await send({ type: "list" });
    await send({ type: "home" });
    if (me && me.currentId != null) send({ type: "close", id: me.currentId });
  });

  function hostOf(url) {
    try { return new URL(url).host; } catch { return ""; }
  }

  // The address the bar shows at rest: host and path, no scheme, no query —
  // "duckduckgo.com" rather than "https://duckduckgo.com/". The full URL is
  // shown while the input has focus, so it can be edited or copied whole.
  function shortAddress(url) {
    try {
      const u = new URL(url);
      const path = u.pathname === "/" ? "" : u.pathname;
      return u.host + path;
    } catch { return url; }
  }

  // What Enter does with the typed text: an address goes there (https://
  // prefixed when the scheme is missing), anything else is a search.
  function destinationFor(text) {
    const q = text.trim();
    if (!q) return null;
    if (/^https?:\/\//i.test(q)) return q;
    if (URL_LIKE.test(q.toLowerCase())) return "https://" + q;
    return SEARCH_URL + encodeURIComponent(q);
  }

  function showCurrentAddress() {
    addressEl.value = root.activeElement === addressEl ? location.href : shortAddress(location.href);
  }
  addressEl.addEventListener("focus", () => {
    addressEl.value = location.href;
    addressEl.select();
  });
  addressEl.addEventListener("blur", showCurrentAddress);
  addressEl.addEventListener("keydown", (e) => {
    // Nothing typed here is the page's business (a "/" that focuses its
    // search box, an Escape that closes its menu).
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      const to = destinationFor(addressEl.value);
      if (to) location.assign(to);
    } else if (e.key === "Escape") {
      // Back to the page's own URL, still focused, the way an omnibox does.
      e.preventDefault();
      addressEl.value = location.href;
      addressEl.select();
    }
  });
  addressEl.addEventListener("keyup", (e) => e.stopPropagation());
  addressEl.addEventListener("keypress", (e) => e.stopPropagation());

  async function refresh() {
    // A single-page app moves without a load; the bar follows the URL on
    // every refresh unless the owner is typing in it.
    if (root.activeElement !== addressEl) showCurrentAddress();
    const r = await send({ type: "list" });
    if (!r || !Array.isArray(r.tabs)) return;
    tabsEl.textContent = "";
    for (const tab of r.tabs) {
      const name = (tab.title || "").trim() || hostOf(tab.url) || "Untitled page";
      const b = document.createElement("button");
      b.className = "tab" + (tab.id === r.currentId ? " current" : "");
      b.title = name;
      if (tab.favicon && /^https?:/.test(tab.favicon)) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = tab.favicon;
        b.appendChild(img);
      }
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = name;
      b.appendChild(t);
      const x = document.createElement("button");
      x.className = "x";
      x.title = "Close";
      x.textContent = "✕";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        send({ type: "close", id: tab.id }).then(refresh);
      });
      b.appendChild(x);
      b.addEventListener("click", () => send({ type: "activate", id: tab.id }));
      tabsEl.appendChild(b);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "changed") refresh();
  });
  window.addEventListener("popstate", showCurrentAddress);
  window.addEventListener("hashchange", showCurrentAddress);

  (document.body || document.documentElement).appendChild(host);
  document.documentElement.classList.add("clawbox-kiosk-bar-shown");
  refresh();
  // The worker broadcasts changes; this is the fallback for a broadcast a
  // sleeping worker missed.
  setInterval(refresh, 5000);
})();
