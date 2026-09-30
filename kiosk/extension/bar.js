// ClawBox Kiosk Tabs — the bar itself, shared by content.js (every web page
// the desktop opened) and newtab.html (the extension's own start page, where
// content scripts do not run). Both load this file first and then call
// `clawboxKioskBar.mount({ startPage })`.
//
// Fixed 40 px strip at the top, in a shadow root so the page's CSS cannot
// restyle it and ours cannot leak into the page. The page is pushed down by
// the same 40 px (content.css for web pages, newtab.css for the start page)
// so nothing sits under the bar. Everything the bar does that needs the
// `tabs` permission goes through background.js; navigation is the page's own
// location/history and needs nothing.
//
// Left to right: ClawBox home, the tab chips, back / forward / reload, the
// address bar, "+" (a new tab on the start page), Close. A thin coral line
// under the bar runs while the page is loading or leaving.
//
// The look is the desktop's (src/app/globals.css tokens, ChromeShelf.tsx):
// --ground behind, --border-subtle under, Satoshi/system-ui 13 px, shelf-style
// rounded buttons that light up white/10 on hover, coral for the action.

(() => {
  const BAR_H = 40;
  // Where Enter sends text that is not an address.
  const SEARCH_URL = "https://duckduckgo.com/?q=";
  // Typed text that is an address rather than a search: http(s)://…, or a
  // host — something with a dot and no whitespace ("example.com",
  // "example.com/path?x=1"). Everything else is searched. No flag on the
  // literal, so the test can lift it out of this file; the input is lowered
  // before the test.
  const URL_LIKE = /^(?:https?:\/\/\S+|\S+\.\S+)$/;

  // Inline glyphs (Material Symbols Rounded outlines, 24-unit viewBox): the
  // extension cannot load the desktop's icon font.
  const ICON = {
    back: '<path d="M15.5 19 8.5 12l7-7 1.4 1.4L11.3 12l5.6 5.6z"/>',
    forward: '<path d="m8.5 19-1.4-1.4L12.7 12 7.1 6.4 8.5 5l7 7z"/>',
    reload: '<path d="M12 20a8 8 0 1 1 6.32-12.9L20 5.5V11h-5.5l2.4-2.4A6 6 0 1 0 18 12h2a8 8 0 0 1-8 8z"/>',
    globe: '<path d="M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20zm-1-2.05V18c-.55 0-1-.45-1-1v-1l-4.8-4.8A8 8 0 0 0 11 19.95zM17.9 17.4A8 8 0 0 0 14 4.25V5a2 2 0 0 1-2 2H10v2a1 1 0 0 1-1 1H7v2h6a1 1 0 0 1 1 1v3h1a2 2 0 0 1 1.9 1.4z"/>',
    close: '<path d="m12 13.4-4.9 4.9-1.4-1.4 4.9-4.9-4.9-4.9 1.4-1.4 4.9 4.9 4.9-4.9 1.4 1.4-4.9 4.9 4.9 4.9-1.4 1.4z"/>',
    plus: '<path d="M11 13H5v-2h6V5h2v6h6v2h-6v6h-2z"/>',
  };
  const svg = (name, size) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${ICON[name]}</svg>`;

  // What Enter does with the typed text: an address goes there (https://
  // prefixed when the scheme is missing), anything else is a search.
  function destinationFor(text) {
    const q = text.trim();
    if (!q) return null;
    if (/^https?:\/\//i.test(q)) return q;
    if (URL_LIKE.test(q.toLowerCase())) return "https://" + q;
    return SEARCH_URL + encodeURIComponent(q);
  }

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

  const STYLE = `
    :host { all: initial; position: fixed; top: 0; left: 0; right: 0; height: ${BAR_H}px; z-index: 2147483647; }
    .bar {
      --ground: #0a0f1a; --bg-surface: #172030; --bg-elevated: #1e2939;
      --coral-bright: #f97316; --coral-mid: #ea580c; --cyan-bright: #00e5cc;
      --text-primary: #f9fafb; --text-secondary: #9ca3af; --text-muted: #6b7280;
      --border-subtle: rgba(54, 65, 83, 0.6); --coral-ring: rgba(249, 115, 22, 0.6);
      box-sizing: border-box; position: relative; height: ${BAR_H}px; display: flex; align-items: center; gap: 4px; padding: 0 6px;
      background: var(--ground); border-bottom: 1px solid var(--border-subtle);
      font: 500 13px/1 "Satoshi", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text-primary);
      -webkit-font-smoothing: antialiased; }
    .bar *, .bar *::before, .bar *::after { box-sizing: border-box; }
    button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 32px;
      padding: 0 10px; border-radius: 8px; color: var(--text-secondary); white-space: nowrap; flex: none;
      transition: background-color .12s, color .12s; }
    button:hover { background: rgba(255,255,255,0.10); color: var(--text-primary); }
    button:active { background: rgba(255,255,255,0.15); }
    button:focus-visible { outline: 2px solid var(--coral-ring); outline-offset: -2px; }
    button[disabled] { opacity: 0.35; cursor: default; }
    button[disabled]:hover { background: none; color: var(--text-secondary); }
    .icon { width: 32px; padding: 0; justify-content: center; }
    .home { color: var(--coral-bright); font-weight: 600; letter-spacing: 0.01em; padding: 0 10px 0 8px; }
    .home:hover { color: var(--coral-bright); background: rgba(249,115,22,0.12); }
    .home img { width: 18px; height: 18px; border-radius: 5px; }
    .sep { width: 1px; height: 24px; background: var(--border-subtle); margin: 0 2px; flex: none; }
    .tabs { display: flex; align-items: center; gap: 2px; flex: 2 1 0; min-width: 0; overflow: hidden; }
    .tab { flex: 0 1 auto; min-width: 0; max-width: 220px; height: 32px; padding: 0 2px 0 8px; color: var(--text-secondary); position: relative; }
    .tab.current { color: var(--text-primary); background: rgba(249,115,22,0.10); }
    .tab.current::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--coral-bright); }
    .tab img, .tab .globe { width: 14px; height: 14px; border-radius: 3px; flex: none; }
    .tab .globe { color: var(--text-muted); display: inline-flex; }
    .tab .t { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .x { height: 22px; width: 22px; padding: 0; justify-content: center; border-radius: 11px; color: var(--text-muted); opacity: 0; }
    .tab:hover .x, .tab.current .x, .x:focus-visible { opacity: 1; }
    .x:hover { color: var(--text-primary); background: rgba(255,255,255,0.15); }
    .nav { gap: 0; }
    .address { all: unset; box-sizing: border-box; flex: 1 1 0; min-width: 140px; max-width: 560px; height: 32px;
      padding: 0 12px; border-radius: 8px; background: var(--bg-surface); border: 1px solid transparent; color: var(--text-primary);
      font: inherit; font-weight: 400; line-height: 30px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background-color .12s, border-color .12s; }
    .address::placeholder { color: var(--text-muted); }
    .address:hover { background: var(--bg-elevated); }
    .address:focus { background: var(--bg-elevated); border-color: var(--coral-ring); outline: 2px solid var(--coral-ring); outline-offset: -1px; }
    .close { color: var(--text-secondary); padding: 0 10px 0 8px; }
    .close:hover { color: var(--text-primary); }
    .progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; pointer-events: none; opacity: 0; transition: opacity .2s; }
    .progress::before { content: ""; position: absolute; top: 0; bottom: 0; left: -40%; width: 40%; border-radius: 2px;
      background: linear-gradient(90deg, var(--coral-mid), var(--coral-bright), var(--cyan-bright)); }
    .bar.loading .progress { opacity: 1; }
    .bar.loading .progress::before { animation: clawbox-kiosk-slide 1.1s ease-in-out infinite; }
    @keyframes clawbox-kiosk-slide { 0% { left: -40%; } 100% { left: 100%; } }`;

  function mount(opts) {
    const startPage = !!(opts && opts.startPage);
    if (window.top !== window || document.getElementById("clawbox-kiosk-bar")) return null;

    const host = document.createElement("div");
    host.id = "clawbox-kiosk-bar";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="bar" role="toolbar" aria-label="ClawBox">
        <button class="home" title="Back to ClawBox"><img alt="" src="${chrome.runtime.getURL("icon.svg")}"><span>ClawBox</span></button>
        <span class="sep"></span>
        <div class="tabs"></div>
        <span class="sep"></span>
        <span class="nav">
          <button class="icon back" title="Back" aria-label="Back">${svg("back", 20)}</button>
          <button class="icon forward" title="Forward" aria-label="Forward">${svg("forward", 20)}</button>
          <button class="icon reload" title="Reload" aria-label="Reload">${svg("reload", 18)}</button>
        </span>
        <input class="address" type="text" spellcheck="false" autocomplete="off" autocapitalize="off"
          placeholder="Search or enter address" title="Search or enter address" aria-label="Address">
        <button class="icon add" title="New tab" aria-label="New tab">${svg("plus", 20)}</button>
        <button class="close" title="Close this page">${svg("close", 18)}<span>Close</span></button>
        <div class="progress" aria-hidden="true"></div>
      </div>`;

    const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
    const barEl = root.querySelector(".bar");
    const tabsEl = root.querySelector(".tabs");
    const addressEl = root.querySelector(".address");
    const backEl = root.querySelector(".back");
    const forwardEl = root.querySelector(".forward");

    // The loading line: on while the document is still loading, and again
    // from the moment a navigation starts until the page is gone (a load
    // this page triggered, a link the owner clicked, back/forward).
    const setLoading = (on) => barEl.classList.toggle("loading", !!on);
    const settle = () => setLoading(document.readyState !== "complete");
    window.addEventListener("load", settle);
    window.addEventListener("pageshow", settle); // back from the bfcache
    window.addEventListener("beforeunload", () => setLoading(true));
    const go = (fn) => { setLoading(true); fn(); };

    root.querySelector(".home").addEventListener("click", () => send({ type: "home" }));
    // No URL: the worker opens the extension's own start page.
    root.querySelector(".add").addEventListener("click", () => send({ type: "create" }));
    root.querySelector(".close").addEventListener("click", async () => {
      // Land on the desktop, then close: closing the only foreground page
      // otherwise leaves Chrome showing whichever tab it picks.
      const me = await send({ type: "list" });
      await send({ type: "home" });
      if (me && me.currentId != null) send({ type: "close", id: me.currentId });
    });
    backEl.addEventListener("click", () => go(() => history.back()));
    forwardEl.addEventListener("click", () => go(() => history.forward()));
    root.querySelector(".reload").addEventListener("click", () => go(() => location.reload()));

    // Grey out back/forward where Chrome can say (the Navigation API); with
    // no answer both stay live, as a plain browser's do.
    function updateNav() {
      const nav = window.navigation;
      if (!nav || typeof nav.canGoBack !== "boolean") return;
      backEl.disabled = !nav.canGoBack;
      forwardEl.disabled = !nav.canGoForward;
    }

    function showCurrentAddress() {
      // The start page has no address worth showing; the box is a search box.
      if (startPage) { addressEl.value = ""; return; }
      addressEl.value = root.activeElement === addressEl ? location.href : shortAddress(location.href);
    }
    addressEl.addEventListener("focus", () => {
      if (startPage) return;
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
        if (to) go(() => location.assign(to));
      } else if (e.key === "Escape") {
        // Back to the page's own URL, still focused, the way an omnibox does.
        e.preventDefault();
        addressEl.value = startPage ? "" : location.href;
        addressEl.select();
      }
    });
    addressEl.addEventListener("keyup", (e) => e.stopPropagation());
    addressEl.addEventListener("keypress", (e) => e.stopPropagation());

    async function refresh() {
      // A single-page app moves without a load; the bar follows the URL on
      // every refresh unless the owner is typing in it.
      if (root.activeElement !== addressEl) showCurrentAddress();
      updateNav();
      const r = await send({ type: "list" });
      if (!r || !Array.isArray(r.tabs)) return;
      tabsEl.textContent = "";
      for (const tab of r.tabs) {
        const name = (tab.title || "").trim() || hostOf(tab.url) || "Untitled page";
        const b = document.createElement("button");
        b.className = "tab" + (tab.id === r.currentId ? " current" : "");
        b.title = name;
        if (tab.favicon && /^(?:https?:|data:image\/)/.test(tab.favicon)) {
          const img = document.createElement("img");
          img.alt = "";
          img.src = tab.favicon;
          b.appendChild(img);
        } else {
          const g = document.createElement("span");
          g.className = "globe";
          g.innerHTML = svg("globe", 14);
          b.appendChild(g);
        }
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = name;
        b.appendChild(t);
        const x = document.createElement("button");
        x.className = "x";
        x.title = "Close";
        x.setAttribute("aria-label", "Close " + name);
        x.innerHTML = svg("close", 14);
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
    window.addEventListener("popstate", () => { showCurrentAddress(); updateNav(); });
    window.addEventListener("hashchange", showCurrentAddress);

    (document.body || document.documentElement).appendChild(host);
    document.documentElement.classList.add("clawbox-kiosk-bar-shown");
    settle();
    refresh();
    // The worker broadcasts changes; this is the fallback for a broadcast a
    // sleeping worker missed.
    setInterval(refresh, 5000);
    return { refresh, focusAddress: () => addressEl.focus() };
  }

  globalThis.clawboxKioskBar = { BAR_H, SEARCH_URL, destinationFor, mount };
})();
