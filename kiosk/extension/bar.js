// ClawBox Kiosk Tabs — the bar itself, shared by content.js (every web page
// the desktop opened), newtab.html (the extension's own start page, where
// content scripts do not run) and desktop.js (the ClawBox desktop page). Each
// loads this file first and then calls `clawboxKioskBar.mount(opts)`:
// `{ startPage: true }` on the start page, `{ desktop: true }` on the desktop.
//
// On the DESKTOP the bar is the kiosk's tab strip, always up: the ClawBox
// chip is the current page, the tab chips switch to the others and "+" opens
// a new tab. The address box is left out there — the desktop is not a page to
// type an address over, and "+" lands on the start page's own search box —
// and so are back/forward/reload and Close, which would act on the desktop
// itself. DevTools stays: the desktop is a page like any other to inspect. It wears the shelf's glass
// there rather than the solid ground (ChromeShelf.tsx: the same tint, blur and
// hairline), so the desktop's wallpaper runs on behind the bar's empty space
// and the top bar and the shelf read as one frame. The desktop cannot be
// pushed down the way a web page is (every surface on it is position: fixed),
// so the bar TELLS it how tall it is instead: `--clawbox-kiosk-bar-h` on
// <html>, and a `clawbox:kiosk-bar` event on window once it is up, which
// src/lib/kiosk-bar-inset.ts reads to lay the desktop out under it.
//
// Fixed 40 px strip at the top, in a shadow root so the page's CSS cannot
// restyle it and ours cannot leak into the page. The page is pushed down by
// the same 40 px (content.css plus offset.js for web pages, newtab.css for
// the start page) so nothing sits under the bar. Everything the bar does that
// needs the `tabs` permission goes through background.js; navigation is the
// page's own location/history and needs nothing.
//
// Three columns, the middle one at the bar's exact horizontal centre: on the
// left the ClawBox tab (the crab and the wordmark, as the desktop draws them),
// the tab chips, "+" (a new tab on the start page) and back / forward /
// reload; in the middle the address box; on the right DevTools for this tab
// (also F12 / Ctrl+Shift+I) and Close. The two side
// columns are always equal, so the address box stays centred whatever the
// tab count. A thin coral line under the bar runs while the page is loading
// or leaving.
//
// The look is the desktop's (src/app/globals.css tokens, ChromeShelf.tsx):
// --ground behind, --border-subtle under, Satoshi/system-ui 13 px, shelf-style
// rounded buttons that light up white/10 on hover, coral for the action.

(() => {
  const BAR_H = 40;
  // What the desktop reads (src/lib/kiosk-bar-inset.ts: KIOSK_BAR_VAR and
  // KIOSK_BAR_EVENT; the extension test holds the names together).
  const INSET_VAR = "--clawbox-kiosk-bar-h";
  const INSET_EVENT = "clawbox:kiosk-bar";
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
    lock: '<path d="M6 22q-.82 0-1.41-.59T4 20V10q0-.82.59-1.41T6 8h1V6q0-2.07 1.46-3.54T12 1t3.54 1.46T17 6v2h1q.82 0 1.41.59T20 10v10q0 .82-.59 1.41T18 22zm0-2h12V10H6zm6-3q.82 0 1.41-.59T14 15t-.59-1.41T12 13t-1.41.59T10 15t.59 1.41T12 17M9 8h6V6q0-1.25-.87-2.13T12 3t-2.13.87T9 6z"/>',
    code: '<path d="m8 18-6-6 6-6 1.4 1.43L4.83 12l4.58 4.58zm8 0-1.4-1.43L19.17 12l-4.58-4.58L16 6l6 6z"/>',
    search: '<path d="M9.5 16a6.5 6.5 0 1 1 4.53-1.84l.06.05 4.85 4.85-1.41 1.41-4.85-4.85-.05-.06A6.47 6.47 0 0 1 9.5 16zm0-2a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z"/>',
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
      box-sizing: border-box; position: relative; height: ${BAR_H}px; padding: 0 6px;
      display: grid; grid-template-columns: minmax(0, 1fr) clamp(260px, 32vw, 560px) minmax(0, 1fr); align-items: center; column-gap: 12px;
      background: var(--ground); border-bottom: 1px solid var(--border-subtle);
      font: 500 13px/1 "Satoshi", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text-primary);
      -webkit-font-smoothing: antialiased; }
    .bar *, .bar *::before, .bar *::after { box-sizing: border-box; }
    .start, .end { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .end { justify-content: flex-end; }
    .center { display: flex; min-width: 0; }
    button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 32px;
      padding: 0 10px; border-radius: 8px; color: var(--text-secondary); white-space: nowrap; flex: none;
      transition: background-color .12s, color .12s; }
    button:hover { background: rgba(255,255,255,0.10); color: var(--text-primary); }
    button:active { background: rgba(255,255,255,0.15); }
    button:focus-visible { outline: 2px solid var(--coral-ring); outline-offset: -2px; }
    button[disabled] { opacity: 0.35; cursor: default; }
    button[disabled]:hover { background: none; color: var(--text-secondary); }
    .icon { width: 32px; padding: 0; justify-content: center; }
    .home { position: relative; gap: 7px; padding: 0 12px 0 6px; background: rgba(249,115,22,0.08); }
    .home:hover { background: rgba(249,115,22,0.16); }
    .home img { width: 26px; height: 26px; object-fit: contain; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.45)); }
    .home .word { font-weight: 700; font-size: 14px; letter-spacing: -0.01em;
      background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent; color: var(--coral-bright); }
    .bar.desktop { background: rgba(17, 24, 39, 0.55); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
    .bar.desktop .home { background: rgba(249,115,22,0.14); cursor: default; }
    .bar.desktop .home::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--coral-bright); }
    .bar.desktop { grid-template-columns: minmax(0, 1fr) auto; }
    .bar.desktop .nav, .bar.desktop .center, .bar.desktop .close { display: none; }
    .devtools.failed { color: #f87171; }
    .sep { width: 1px; height: 24px; background: var(--border-subtle); margin: 0 2px; flex: none; }
    .tabs { display: flex; align-items: center; gap: 2px; flex: 0 1 auto; min-width: 0; overflow: hidden; }
    .tabs:empty { display: none; }
    .tab { flex: 1 1 0; min-width: 32px; max-width: 200px; height: 32px; padding: 0 2px 0 8px; color: var(--text-secondary); position: relative; overflow: hidden; }
    .tab.current { color: var(--text-primary); background: rgba(249,115,22,0.10); }
    .tab.current::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--coral-bright); }
    .tab img, .tab .globe { width: 14px; height: 14px; border-radius: 3px; flex: none; }
    .tab .globe { color: var(--text-muted); display: inline-flex; }
    .tab .t { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .x { height: 22px; width: 22px; padding: 0; justify-content: center; border-radius: 11px; color: var(--text-muted); opacity: 0; }
    .tab:hover .x, .tab.current .x, .x:focus-visible { opacity: 1; }
    .x:hover { color: var(--text-primary); background: rgba(255,255,255,0.15); }
    .tabs.narrow .tab { justify-content: center; padding: 0; }
    .tabs.narrow .tab .t, .tabs.narrow .tab .x { display: none; }
    .tabs.narrow .tab:hover img, .tabs.narrow .tab:hover .globe { display: none; }
    .tabs.narrow .tab:hover .x { display: inline-flex; opacity: 1; }
    .nav { display: flex; gap: 0; margin-left: auto; flex: none; }
    .omni { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 14px 0 12px;
      border-radius: 16px; background: var(--bg-surface); border: 1px solid var(--border-subtle); color: var(--text-muted);
      cursor: text; transition: background-color .12s, border-color .12s, box-shadow .12s; }
    .omni:hover { background: var(--bg-elevated); }
    .omni:focus-within { background: var(--bg-elevated); border-color: var(--coral-ring); box-shadow: 0 0 0 1px var(--coral-ring); }
    .lead { display: inline-flex; flex: none; }
    .address { all: unset; box-sizing: border-box; flex: 1 1 0; min-width: 0; height: 100%; color: var(--text-primary);
      font: inherit; font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .address::placeholder { color: var(--text-muted); }
    .close { color: var(--text-secondary); padding: 0 10px 0 8px; }
    .close:hover { color: var(--text-primary); }
    .progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; pointer-events: none; opacity: 0; transition: opacity .2s; }
    .progress::before { content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 40%; border-radius: 2px; transform: translateX(-100%);
      background: linear-gradient(90deg, var(--coral-mid), var(--coral-bright), var(--cyan-bright)); }
    .bar.loading .progress { opacity: 1; }
    .bar.loading .progress::before { animation: clawbox-kiosk-slide 1.1s ease-in-out infinite; }
    /* transform, not left: the line runs while a page loads, when the main
       thread is busiest, and a transform is the compositor's alone. 250% of
       its own 40% width is the bar's far edge. */
    @keyframes clawbox-kiosk-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }`;

  function mount(opts) {
    const startPage = !!(opts && opts.startPage);
    const desktop = !!(opts && opts.desktop);
    if (window.top !== window || document.getElementById("clawbox-kiosk-bar")) return null;

    const host = document.createElement("div");
    host.id = "clawbox-kiosk-bar";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>${STYLE}</style>
      <div class="bar${desktop ? " desktop" : ""}" role="toolbar" aria-label="ClawBox">
        <div class="start">
          <button class="home" title="${desktop ? "ClawBox" : "Back to ClawBox"}"${desktop ? ' aria-current="page"' : ""}><img alt="" src="${chrome.runtime.getURL("logo.png")}"><span class="word">ClawBox</span></button>
          <span class="sep"></span>
          <div class="tabs"></div>
          <button class="icon add" title="New tab" aria-label="New tab">${svg("plus", 20)}</button>
          <span class="nav">
            <button class="icon back" title="Back" aria-label="Back">${svg("back", 20)}</button>
            <button class="icon forward" title="Forward" aria-label="Forward">${svg("forward", 20)}</button>
            <button class="icon reload" title="Reload" aria-label="Reload">${svg("reload", 18)}</button>
          </span>
        </div>
        <label class="center omni">
          <span class="lead"></span>
          <input class="address" type="text" spellcheck="false" autocomplete="off" autocapitalize="off"
            placeholder="Search or enter address" title="Search or enter address" aria-label="Address">
        </label>
        <div class="end">
          <button class="icon devtools" title="Developer tools (F12)" aria-label="Developer tools">${svg("code", 18)}</button>
          <button class="close" title="Close this page">${svg("close", 18)}<span>Close</span></button>
        </div>
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

    // On the desktop the ClawBox chip is the page already showing.
    root.querySelector(".home").addEventListener("click", () => { if (!desktop) send({ type: "home" }); });
    // The worker opens the extension's own start page.
    root.querySelector(".add").addEventListener("click", () => send({ type: "create" }));
    // The worker knows which tab asked: it lands on the desktop, then closes it.
    root.querySelector(".close").addEventListener("click", () => send({ type: "closeSelf" }));
    // DevTools on this tab, through the worker (see openDevTools there). A
    // refusal turns the button red with the reason as its tooltip.
    const devtoolsEl = root.querySelector(".devtools");
    const devtoolsTitle = devtoolsEl.title;
    async function openDevTools() {
      const r = await send({ type: "devtools" });
      const failed = !r || !r.ok;
      devtoolsEl.classList.toggle("failed", failed);
      devtoolsEl.title = failed ? "Developer tools: " + ((r && r.error) || "the extension did not answer") : devtoolsTitle;
    }
    devtoolsEl.addEventListener("click", openDevTools);
    // F12 and Ctrl+Shift+I, the keys every browser opens DevTools on. In a
    // window with menus Chrome takes them before the page does; in --kiosk
    // they reach the page, so they are caught here, ahead of its own handlers.
    window.addEventListener("keydown", (e) => {
      if (e.key === "F12" || (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyI")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openDevTools();
      }
    }, true);
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

    // The start page has no address worth showing; there the box is a search
    // box. (The desktop draws no box at all.)
    const searchOnly = startPage;
    // The glyph at the head of the box: a magnifier where it is a search box,
    // a lock over https, a globe otherwise.
    const leadEl = root.querySelector(".lead");
    function updateLead() {
      const kind = searchOnly ? "search" : location.protocol === "https:" ? "lock" : "globe";
      if (leadEl.dataset.kind === kind) return;
      leadEl.dataset.kind = kind;
      leadEl.innerHTML = svg(kind, 16);
    }
    function showCurrentAddress() {
      updateLead();
      if (searchOnly) { addressEl.value = ""; return; }
      addressEl.value = root.activeElement === addressEl ? location.href : shortAddress(location.href);
    }
    addressEl.addEventListener("focus", () => {
      if (searchOnly) return;
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
        addressEl.value = searchOnly ? "" : location.href;
        addressEl.select();
      }
    });
    addressEl.addEventListener("keyup", (e) => e.stopPropagation());
    addressEl.addEventListener("keypress", (e) => e.stopPropagation());

    // What the chips on screen were drawn from: a refresh that finds the same
    // leaves them (and their measure) alone. Every refresh used to take the
    // strip down and build it again — new buttons, images and SVGs, then a
    // forced layout to fit them — every 5 s on every tab, desktop included,
    // whether or not anything had changed.
    let drawn = "";

    async function refresh() {
      // A page nobody can see keeps no strip up to date: it catches up the
      // moment it is shown (visibilitychange below).
      if (document.hidden) return;
      // A single-page app moves without a load; the bar follows the URL on
      // every refresh unless the owner is typing in it.
      if (root.activeElement !== addressEl) showCurrentAddress();
      updateNav();
      const r = await send({ type: "list" });
      if (!r || !Array.isArray(r.tabs)) return;
      // Exactly what a chip shows and acts on.
      const chips = r.tabs.map((tab) => ({
        id: tab.id,
        name: (tab.title || "").trim() || hostOf(tab.url) || "Untitled page",
        favicon: tab.favicon && /^(?:https?:|data:image\/)/.test(tab.favicon) ? tab.favicon : "",
        current: tab.id === r.currentId,
      }));
      const key = JSON.stringify(chips);
      if (key === drawn) return;
      drawn = key;
      tabsEl.textContent = "";
      for (const chip of chips) {
        const b = document.createElement("button");
        b.className = "tab" + (chip.current ? " current" : "");
        b.title = chip.name;
        if (chip.favicon) {
          const img = document.createElement("img");
          img.alt = "";
          img.src = chip.favicon;
          b.appendChild(img);
        } else {
          const g = document.createElement("span");
          g.className = "globe";
          g.innerHTML = svg("globe", 14);
          b.appendChild(g);
        }
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = chip.name;
        b.appendChild(t);
        const x = document.createElement("button");
        x.className = "x";
        x.title = "Close";
        x.setAttribute("aria-label", "Close " + chip.name);
        x.innerHTML = svg("close", 14);
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          send({ type: "close", id: chip.id }).then(refresh);
        });
        b.appendChild(x);
        b.addEventListener("click", () => send({ type: "activate", id: chip.id }));
        tabsEl.appendChild(b);
      }
      fitTabs();
    }

    // Chips share the room equally (up to 200 px each). Once that is too
    // little for a title, they show the site's icon alone, and the close
    // button takes its place under the pointer.
    //
    // Measured only when that can change: the chips were rebuilt, the window
    // was resized, or a font arrived (the wordmark and the titles change width
    // with it — the 5 s rebuild used to correct a fit made before it came).
    function fitTabs() {
      tabsEl.classList.remove("narrow");
      const n = tabsEl.childElementCount;
      if (n && tabsEl.clientWidth / n < 84) tabsEl.classList.add("narrow");
    }
    window.addEventListener("resize", fitTabs);
    if (document.fonts) document.fonts.addEventListener("loadingdone", fitTabs);

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "changed") refresh();
    });
    // Once on being shown: the broadcasts and polls it sat out while hidden.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
    window.addEventListener("popstate", () => { showCurrentAddress(); updateNav(); });
    window.addEventListener("hashchange", showCurrentAddress);

    (document.body || document.documentElement).appendChild(host);
    if (desktop) {
      // The desktop makes its own room (see the header).
      document.documentElement.style.setProperty(INSET_VAR, BAR_H + "px");
      window.dispatchEvent(new Event(INSET_EVENT));
    } else {
      // A web page is pushed down (content.css / newtab.css key on the class).
      document.documentElement.classList.add("clawbox-kiosk-bar-shown");
    }
    settle();
    refresh();
    // The worker broadcasts changes; this is the fallback for a broadcast a
    // sleeping worker missed (a no-op while the page is hidden, and nothing
    // redrawn when the tabs are as they were).
    setInterval(refresh, 5000);
    return { refresh, focusAddress: () => addressEl.focus() };
  }

  globalThis.clawboxKioskBar = { BAR_H, SEARCH_URL, destinationFor, mount };
})();
