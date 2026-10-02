import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";

/**
 * kiosk/extension — the MV3 extension the kiosk Chrome loads (no build step,
 * plain JS). Nothing here runs it; what this pins is the things that must
 * agree with the rest of the repo and with each other:
 *
 *  - background.js decides "is this tab the desktop" with the SAME path rule
 *    src/lib/kiosk-tabs.ts uses, or the shelf and the bar would disagree
 *    about which tab "home" is;
 *  - the manifest asks for `tabs`, plus `debugger` and the loopback host for
 *    DevTools and nothing else, and runs on http(s) only: the web-page script
 *    never reaches the desktop's origin, and the desktop's own script
 *    (desktop.js) mounts on the desktop page alone;
 *  - DevTools on a tab (the bar's button, F12, Ctrl+Shift+I) goes through the
 *    worker to the kiosk's own CDP port, which install-kiosk-tabs.sh opens to
 *    this extension's origin;
 *  - the bar is ONE file (bar.js) mounted from three places — the content
 *    script on web pages, newtab.html on the start page and desktop.js on the
 *    desktop — so they look and behave the same, and the page offset matches
 *    the bar's height;
 *  - its address box sits in the middle of three columns whose sides are
 *    equal, so it is centred on the bar whatever the tab count, and its first
 *    tab wears ClawBox's own crab (the desktop's clawbox-icon.png);
 *  - on a web page, offset.js lays the page's fixed and sticky headers and
 *    its viewport-tall shells out below the bar, which the margin alone does
 *    not move, and only once the bar is up;
 *  - on the desktop the bar is always up, in the shelf's glass, and tells the
 *    desktop its height through the variable and event
 *    src/lib/kiosk-bar-inset.ts reads;
 *  - the bar's address rule (Enter: address or search), the "+" landing on
 *    the extension's start page, and the start page's own search box;
 *  - the version is bumped (semver): Chrome caches unpacked extension code
 *    across restarts and re-reads it only when the version changes;
 *  - what keeps the extension cheap on a busy page: offset.js judges a box
 *    again only for a change that can move one, the bar redraws its strip
 *    only when the tabs changed and not at all while hidden, and the worker
 *    sends one broadcast per burst of tab events.
 *
 * kiosk-extension-runtime.test.ts RUNS the three scripts (jsdom, a stand-in
 * `chrome`) for the behaviour behind the last point.
 */
const EXT = nodePath.resolve(__dirname, "../../../kiosk/extension");
const read = (f: string) => fs.readFileSync(nodePath.join(EXT, f), "utf-8");
const exists = (f: string) => fs.existsSync(nodePath.join(EXT, f));

function regexLiteral(source: string, name: string): string {
  const m = new RegExp(`const ${name} = (/.*?/);`).exec(source);
  if (!m) throw new Error(`${name} not found`);
  return m[1];
}

function stringConst(source: string, name: string): string {
  const m = new RegExp(`const ${name} = "([^"]*)";`).exec(source);
  if (!m) throw new Error(`${name} not found`);
  return m[1];
}

const JS_FILES = ["background.js", "bar.js", "offset.js", "content.js", "desktop.js", "newtab.js"];
const BAR_H = 40;

describe("kiosk extension", () => {
  it("has its files and valid JS", () => {
    for (const f of ["manifest.json", ...JS_FILES, "content.css", "newtab.html", "newtab.css", "logo.png"]) {
      expect(exists(f), f).toBe(true);
    }
    // A syntax error would only show in chrome://extensions on the laptop.
    for (const f of JS_FILES) {
      expect(() => new Function(read(f).replace(/\bchrome\b/g, "globalThis.chrome")), f).not.toThrow();
    }
  });

  it("asks for tabs (and DevTools' two), http(s) only; web pages and the desktop each get their own script", () => {
    const m = JSON.parse(read("manifest.json"));
    expect(m.manifest_version).toBe(3);
    // `debugger` for getTargets() alone and the loopback host for the kiosk's
    // CDP port: what DevTools on a tab needs, and nothing wider.
    expect(m.permissions).toEqual(["tabs", "debugger"]);
    expect(m.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(m.background).toEqual({ service_worker: "background.js" });
    expect(m.content_scripts).toHaveLength(2);
    const [web, desk] = m.content_scripts;
    expect(web.matches).toEqual(["http://*/*", "https://*/*"]);
    expect(web.exclude_matches).toEqual(expect.arrayContaining(["http://localhost:3005/*", "http://127.0.0.1:3005/*"]));
    expect(web.all_frames).toBe(false);
    // bar.js and offset.js first: content.js is one call into each.
    expect(web.js).toEqual(["bar.js", "offset.js", "content.js"]);
    expect(web.css).toEqual(["content.css"]);
    // The desktop's hosts, exactly what the web-page script leaves out. The
    // pages the desktop opened there get the web-page bar and its offset, so
    // the same two files and the same stylesheet — which keys on the class a
    // web-page mount adds, never on the desktop (it makes its own room).
    expect([...desk.matches].sort()).toEqual([...web.exclude_matches].sort());
    expect(desk.js).toEqual(["bar.js", "offset.js", "desktop.js"]);
    expect(desk.css).toEqual(["content.css"]);
    expect(read("content.css")).toMatch(/^html\.clawbox-kiosk-bar-shown \{/m);
    expect(desk.all_frames).toBe(false);
  });

  it("desktop.js: the desktop bar on the desktop, nothing on the shell, the web bar everywhere else", () => {
    const desk = read("desktop.js");
    const bg = read("background.js");
    const origins = (src: string) => {
      const m = /const DESKTOP_ORIGINS = \[([\s\S]*?)\];/.exec(src);
      if (!m) throw new Error("DESKTOP_ORIGINS not found");
      return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    };
    const shellPath = (src: string) => /const SHELL_PATH = (\/.*\/);/.exec(src)?.[1];
    // One list of desktop origins and one shell rule, in the worker and here.
    expect(origins(desk)).toEqual(origins(bg));
    expect(shellPath(desk)).toBeTruthy();
    expect(shellPath(desk)).toBe(shellPath(bg));
    // Chrome ignores the port in a match pattern, so the script checks the
    // origin itself: only the desktop's "/" gets the desktop bar.
    expect(desk).toMatch(/if \(DESKTOP_ORIGINS\.includes\(here\)\) \{\s*if \(location\.pathname === "\/"\) \{\s*clawboxKioskBar\.mount\(\{ desktop: true \}\);\s*return;\s*\}\s*if \(SHELL_PATH\.test\(location\.pathname\)\) return;\s*\}/);
    // A page the desktop opened there gets what content.js gives a web page.
    expect(desk).toMatch(/if \(clawboxKioskBar\.mount\(\{ startPage: false \}\)\) \{\s*clawboxKioskOffset\.start\(clawboxKioskBar\.BAR_H\);\s*\}/);
  });

  it("on the desktop, the bar is always up and tells the desktop its height", () => {
    const bar = read("bar.js");
    const inset = fs.readFileSync(nodePath.resolve(__dirname, "../../lib/kiosk-bar-inset.ts"), "utf-8");
    // The names and the height the desktop reads (src/lib/kiosk-bar-inset.ts).
    expect(stringConst(bar, "INSET_VAR")).toBe(stringConst(inset, "KIOSK_BAR_VAR"));
    expect(stringConst(bar, "INSET_EVENT")).toBe(stringConst(inset, "KIOSK_BAR_EVENT"));
    expect(bar).toContain('document.documentElement.style.setProperty(INSET_VAR, BAR_H + "px")');
    expect(bar).toContain("window.dispatchEvent(new Event(INSET_EVENT))");
    // Always up: never hidden, whatever the tab count, and no page offset on
    // the desktop (it makes its own room).
    expect(bar).not.toContain('host.style.display = "none"');
    expect(bar).not.toContain("setShown");
    expect(bar).toMatch(/if \(desktop\) \{[\s\S]*?\} else \{\s*\/\/[^\n]*\n\s*document\.documentElement\.classList\.add\("clawbox-kiosk-bar-shown"\);/);
    // Nothing that would act on the desktop itself, and no address box there
    // (the owner's ask: the desktop is not a page to type an address over;
    // "+" lands on the start page's own search box).
    expect(bar).toContain(".bar.desktop .nav, .bar.desktop .center, .bar.desktop .close { display: none; }");
    // …and with the middle column gone, the tabs take the width up to the
    // DevTools button, which the desktop keeps (it is a page to inspect too).
    expect(bar).toContain(".bar.desktop { grid-template-columns: minmax(0, 1fr) auto; }");
    expect(bar).toContain("const searchOnly = startPage;");
    expect(bar).not.toContain('send({ type: "create", url: to })');
    // The worker tells the desktop's bar too when the tabs change.
    const bg = read("background.js");
    expect(bg).not.toMatch(/if \(t\.id == null \|\| isDesktop\(t\.url\)\) continue;/);
    expect(bg).toContain('chrome.tabs.sendMessage(t.id, { type: "changed" })');
  });

  it("the strip is redrawn only when the tabs changed, and not while its page is hidden", () => {
    const bar = read("bar.js");
    // A signature of exactly what the chips show and act on.
    expect(bar).toContain("const key = JSON.stringify(chips);");
    expect(bar).toContain('if (key === drawn) return;');
    expect(bar).toMatch(/const chips = r\.tabs\.map\(\(tab\) => \(\{\s*id: tab\.id,\s*name: [^\n]*,\s*favicon: [^\n]*,\s*current: tab\.id === r\.currentId,\s*\}\)\);/);
    // Hidden: nothing; shown again: once.
    expect(bar).toMatch(/async function refresh\(\) \{[^}]*?if \(document\.hidden\) return;/);
    expect(bar).toContain('document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });');
    // The fit is measured after a rebuild, a resize or a font, never on a
    // refresh that changed nothing.
    expect(bar.match(/fitTabs\(\);/g)).toHaveLength(1);
    expect(bar).toContain('window.addEventListener("resize", fitTabs);');
    expect(bar).toContain('document.fonts.addEventListener("loadingdone", fitTabs);');
  });

  it("the worker sends one broadcast per burst of tab events", () => {
    const bg = read("background.js");
    expect(bg).toMatch(/const BROADCAST_DELAY_MS = \d+;/);
    expect(Number(/const BROADCAST_DELAY_MS = (\d+);/.exec(bg)?.[1])).toBeLessThanOrEqual(250);
    for (const ev of ["onCreated", "onRemoved", "onActivated"]) {
      expect(bg).toContain(`chrome.tabs.${ev}.addListener(broadcastSoon);`);
    }
    expect(bg).toContain('if (info.title || info.url || info.favIconUrl || info.status === "complete") broadcastSoon();');
    // No listener broadcasts on its own.
    expect(bg).not.toMatch(/addListener\(broadcast\)|\) broadcast\(\);/);
  });

  it("carries a semver version, bumped past 1.5.0 (offset.js skips inert style writes, the strip redraws only on change, one broadcast per burst)", () => {
    const m = JSON.parse(read("manifest.json"));
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = m.version.split(".").map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThan(1e6 + 5e3);
  });

  it("centres the address box: three columns, the two sides equal", () => {
    const bar = read("bar.js");
    // Equal `minmax(0, 1fr)` sides never grow with their content, so the
    // middle column is at the bar's centre however many tabs are open.
    expect(bar).toMatch(/display: grid; grid-template-columns: minmax\(0, 1fr\) clamp\([^)]*\) minmax\(0, 1fr\);/);
    // Left: ClawBox, the tabs, "+", back/forward/reload. Middle: the box.
    // Right: DevTools, Close.
    expect(bar).toMatch(
      /<div class="start">[\s\S]*class="home"[\s\S]*class="tabs"[\s\S]*class="icon add"[\s\S]*class="nav"[\s\S]*<\/div>\s*<label class="center omni">[\s\S]*<input class="address"[\s\S]*<\/label>\s*<div class="end">\s*<button class="icon devtools"[^\n]*\n\s*<button class="close"/,
    );
    // Tabs share the left column equally and fall back to their icons.
    expect(bar).toContain(".tab { flex: 1 1 0;");
    expect(bar).toContain('tabsEl.classList.add("narrow")');
  });

  it("the ClawBox tab and the start page wear the crab, not a stand-in", () => {
    // The same picture the desktop draws (ClawIcon.tsx), copied: the kiosk
    // loads the extension from disk and a web page cannot fetch the box's.
    const crab = fs.readFileSync(nodePath.resolve(__dirname, "../../../public/clawbox-icon.png"));
    expect(fs.readFileSync(nodePath.join(EXT, "logo.png")).equals(crab)).toBe(true);
    const bar = read("bar.js");
    expect(bar).toContain('<img alt="" src="${chrome.runtime.getURL("logo.png")}"><span class="word">ClawBox</span>');
    // The wordmark in the desktop's brand gradient (.title-gradient).
    expect(bar).toContain("background: linear-gradient(135deg, #f97316 0%, #ea580c 100%)");
    expect(read("newtab.html")).toContain('<h1 class="wordmark"><img alt="" src="logo.png"><span>ClawBox</span></h1>');
    expect(read("newtab.html")).toContain('<link rel="icon" href="logo.png">');
    const m = JSON.parse(read("manifest.json"));
    // A web page loads the picture from the extension, so it is exposed.
    expect(m.web_accessible_resources[0].resources).toEqual(["logo.png"]);
    expect(Object.values(m.icons)).toEqual(["logo.png", "logo.png", "logo.png"]);
    expect(exists("icon.svg")).toBe(false);
  });

  it("lays a web page's fixed furniture out below the bar, once the bar is up", () => {
    const off = read("offset.js");
    const content = read("content.js");
    // Mount first (it returns null in a frame or on a second run), and offset
    // by the bar's own height.
    expect(content).toMatch(/if \(clawboxKioskBar\.mount\(\{ startPage: false \}\)\) \{\s*clawboxKioskOffset\.start\(clawboxKioskBar\.BAR_H\);\s*\}/);
    expect(off).toContain("globalThis.clawboxKioskOffset = { start };");
    // Fixed and sticky headers go down by the bar; so does an absolute one
    // on the canvas, but not one a script already placed below the bar.
    expect(off).toMatch(/if \(pos === "fixed"\) \{[\s\S]*?out\.push\(\["top", `\$\{top \+ BAR_H\}px`\]\);/);
    expect(off).toMatch(/if \(pos === "sticky"\) \{[\s\S]*?out\.push\(\["top", /);
    expect(off).toContain("top >= BAR_H || isAuto(typed(el, \"top\")) || !againstCanvas(el)");
    // A box anchored at the bottom, one in the top layer, one another box
    // contains, and the bar itself are left alone.
    expect(off).toContain('if (inTopLayer(el) || isAuto(typed(el, "top")) || !againstViewport(el)) return out;');
    expect(off).toContain('el.matches(":modal, :fullscreen, :popover-open")');
    expect(off).toContain('const BAR_HOST_ID = "clawbox-kiosk-bar";');
    // A viewport-tall shell loses the bar's height, in values that follow the
    // viewport, except a replaced element a script sized itself; a
    // percentage height follows its parent and is left alone.
    expect(off).toContain('out.push(["height", `calc(${full} - ${BAR_H}px)`]);');
    expect(off).toContain('const full = icb ? "100%" : "100vh";');
    expect(off).toContain('!(t && t.unit === "percent")');
    expect(off).toMatch(/out\.push\(\["top", `\$\{top \+ BAR_H\}px`\]\);\s*viewportTall\(el, cs, out, true\);/);
    // …including a percentage min-height, which stays a percentage when read.
    expect(off).toContain('if (icb && Math.abs((minH / 100) * vh - vh) < SLACK) out.push(["min-height", `calc(100% - ${BAR_H}px)`]);');
    // <html>, <body> and big subtrees are judged again only on a resize or a
    // change of their own (restyling one costs its whole subtree), and only a
    // box with a transition is held.
    expect(off).toContain("if (!heavy.has(el) || !s.own || s.own.has(el)) s.candidates.add(el);");
    expect(off).toContain('const moves = new Set(els.filter((el) => /[1-9]/.test(getComputedStyle(el).transitionDuration)));');
    // The scan keeps only boxes worth judging and yields on a big page; a
    // whole-document pass is spaced out.
    expect(off).toMatch(/if \(pos === "absolute"\) \{ if \(el\.offsetParent === document\.body\) s\.candidates\.add\(el\); \}\s*else if \(pos !== "static" && pos !== "relative"\) s\.candidates\.add\(el\);\s*else if \(el\.offsetHeight >= window\.innerHeight - SLACK\) s\.candidates\.add\(el\);/);
    expect(off).toContain("performance.now() - t0 > SLICE_MS) return false;");
    expect(off).toContain("now - lastFull >= FULL_GAP_MS");
    expect(off).toMatch(/const REPLACED = new Set\(\[[^\]]*"CANVAS"/);
    // Everything goes on as inline !important and comes back off to be
    // judged again; transitions are held while it does.
    expect(off).toContain('el.style.setProperty(prop, value, "important");');
    expect(off).toContain('el.style.setProperty("transition", "none", "important");');
    expect(off).toContain("for (const el of held.keys()) void getComputedStyle(el).transitionDuration;");
    expect(off).toContain("mo.takeRecords();");
    // The margin that moves the flow is still content.css's.
    expect(read("content.css")).toContain("html.clawbox-kiosk-bar-shown {\n  margin-top: 40px !important;\n}");
  });

  it("offset.js judges a box again only for a change that can move one", () => {
    const off = read("offset.js");
    // The old value is what tells a change from a rewrite; every class and
    // style record goes through the filter, and nothing asks for a frame
    // unless the filter left something to look at.
    expect(off).toContain('attributeFilter: ["class", "style"], attributeOldValue: true');
    expect(off).toContain("if (!changed(r, page)) continue;");
    expect(off).toContain("if (r.oldValue === t.getAttribute(r.attributeName)) return false;");
    expect(off).toContain("const mo = new MutationObserver((records) => { note(records); if (due()) askFrame(); });");
    // The rule: which longhands a verdict cannot read.
    const paintOnly = new Function(`return ${regexLiteral(off, "PAINT_ONLY")}`)() as RegExp;
    const selfOnly = new Function(`return ${regexLiteral(off, "SELF_ONLY")}`)() as RegExp;
    const inert = (prop: string, page: boolean) => paintOnly.test(prop) || (!page && selfOnly.test(prop));
    // A header hidden on scroll, a fade, a colour, a reading-progress bar's
    // width: never a pass, on an ordinary box.
    for (const p of ["transform", "translate", "opacity", "color", "background-color", "box-shadow", "width", "left", "will-change", "filter", "transition-duration", "visibility", "z-index"]) {
      expect(inert(p, false), p).toBe(true);
    }
    // What a verdict reads — the box's position, its vertical insets and
    // sizes, what makes up its offsetHeight — and anything unknown,
    // custom properties included (a `var()` can feed a `top`).
    for (const p of ["position", "top", "bottom", "height", "min-height", "max-height", "display", "margin-top", "padding-top", "border-top-width", "box-sizing", "inset-block-start", "block-size", "--header-top", "overflow-y", "contain", "font-size", "animation-name"]) {
      expect(inert(p, false), p).toBe(false);
      expect(inert(p, true), p).toBe(false);
    }
    // On <html> and <body> a transform, a filter or a will-change makes them
    // the containing block of every fixed box on the page: that still counts.
    for (const p of ["transform", "translate", "filter", "backdrop-filter", "will-change", "perspective", "clip-path", "width"]) {
      expect(inert(p, true), p).toBe(false);
    }
    expect(inert("opacity", true)).toBe(true);
    expect(inert("background-color", true)).toBe(true);
    // HEAVY is "more than HEAVY_SUBTREE descendants", found without counting
    // the whole subtree on every write.
    expect(off).toContain('el.getElementsByTagName("*")[HEAVY_SUBTREE]) heavy.add(el);');
    expect(off).not.toContain('getElementsByTagName("*").length');
  });

  it("wears the shelf's glass on the desktop, so the wallpaper shows behind the bar", () => {
    const bar = read("bar.js");
    const shelf = fs.readFileSync(nodePath.resolve(__dirname, "../../components/ChromeShelf.tsx"), "utf-8");
    // The same tint, blur and hairline as the shelf, copied (the extension
    // cannot import the component); kept equal here.
    expect(shelf).toContain('background: "rgba(17, 24, 39, 0.55)"');
    expect(shelf).toContain('backdropFilter: "blur(20px)"');
    expect(shelf).toContain('borderTop: "1px solid rgba(255, 255, 255, 0.1)"');
    expect(bar).toContain(".bar.desktop { background: rgba(17, 24, 39, 0.55); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);");
    expect(bar).toContain("border-bottom: 1px solid rgba(255, 255, 255, 0.1); }");
    // Web pages keep the solid ground: there is no wallpaper behind them.
    expect(bar).toContain("background: var(--ground); border-bottom: 1px solid var(--border-subtle);");
  });

  it("every file the manifest names exists", () => {
    const m = JSON.parse(read("manifest.json"));
    const named = new Set<string>([
      m.background.service_worker,
      ...m.content_scripts.flatMap((cs: { js: string[]; css?: string[] }) => [...cs.js, ...(cs.css ?? [])]),
      ...m.web_accessible_resources.flatMap((w: { resources: string[] }) => w.resources),
      ...Object.values(m.icons as Record<string, string>),
      m.chrome_url_overrides.newtab,
    ]);
    for (const f of named) expect(exists(f), f).toBe(true);
  });

  it("names the desktop with the same shell-path rule as src/lib/kiosk-tabs.ts", () => {
    const lib = fs.readFileSync(nodePath.resolve(__dirname, "../../lib/kiosk-tabs.ts"), "utf-8");
    expect(regexLiteral(read("background.js"), "SHELL_PATH")).toBe(regexLiteral(lib, "SHELL_PATH_RE"));
  });

  it(`the bar is a shadow root at a fixed ${BAR_H} px, matched by the page offset on the web hosts`, () => {
    const bar = read("bar.js");
    expect(bar).toContain("attachShadow");
    expect(bar).toContain(`const BAR_H = ${BAR_H}`);
    expect(read("content.css")).toMatch(new RegExp(`margin-top:\\s*${BAR_H}px`));
    expect(read("newtab.css")).toMatch(new RegExp(`padding-top:\\s*${BAR_H}px`));
    // The bar is defined once and mounted from both hosts.
    expect(bar).toContain("globalThis.clawboxKioskBar = { BAR_H, SEARCH_URL, destinationFor, mount }");
    expect(read("content.js")).toContain("clawboxKioskBar.mount({ startPage: false })");
    expect(read("newtab.js")).toContain("clawboxKioskBar.mount({ startPage: true })");
    expect(read("content.js")).not.toContain("attachShadow");
    expect(read("desktop.js")).not.toContain("attachShadow");
  });

  it("wears the desktop's tokens", () => {
    const bar = read("bar.js");
    const tokens = fs.readFileSync(nodePath.resolve(__dirname, "../../app/globals.css"), "utf-8");
    // The extension cannot import globals.css; the values are copied. Keep
    // them equal to the desktop's.
    for (const [name, value] of [
      ["--ground", "#0a0f1a"],
      ["--bg-surface", "#172030"],
      ["--bg-elevated", "#1e2939"],
      ["--coral-bright", "#f97316"],
      ["--coral-mid", "#ea580c"],
      ["--cyan-bright", "#00e5cc"],
      ["--text-primary", "#f9fafb"],
      ["--text-secondary", "#9ca3af"],
      ["--text-muted", "#6b7280"],
    ]) {
      expect(tokens, `${name} in globals.css`).toContain(`${name}: ${value};`);
      expect(bar, `${name} in bar.js`).toContain(`${name}: ${value};`);
      expect(read("newtab.css"), `${name} in newtab.css`).toContain(`${name}: ${value};`);
    }
    expect(bar).toContain("background: var(--ground); border-bottom: 1px solid var(--border-subtle);");
    expect(bar).toMatch(/font: 500 13px\/1 "Satoshi", system-ui/);
    // Back / forward / reload before the address field, and the loading line.
    expect(bar).toMatch(/class="icon back"[\s\S]*class="icon forward"[\s\S]*class="icon reload"[\s\S]*<input class="address"/);
    expect(bar).toContain("history.back()");
    expect(bar).toContain("history.forward()");
    expect(bar).toContain("location.reload()");
    expect(bar).toContain('document.readyState !== "complete"');
    expect(bar).toMatch(/\.bar\.loading \.progress/);
  });

  it("draws an address bar and a + that opens the extension's start page", () => {
    const bar = read("bar.js");
    expect(bar).toMatch(/<input class="address" type="text"/);
    expect(bar).toMatch(/<button class="icon add"/);
    // "+" goes through the worker (it holds `tabs`) with no URL, and the
    // worker opens the extension's own start page — the same file the
    // manifest registers as the new-tab override.
    expect(bar).toContain('send({ type: "create" })');
    const bg = read("background.js");
    expect(bg).toMatch(/case "create":\s*await chrome\.tabs\.create\(\{ url: START_PAGE, active: true \}\);/);
    expect(bg).toContain('const START_PAGE = chrome.runtime.getURL("newtab.html");');
    expect(JSON.parse(read("manifest.json")).chrome_url_overrides).toEqual({ newtab: "newtab.html" });
    // Nothing the worker is told can open another URL: "create" takes none.
    expect(bg).not.toContain("msg.url");
    // Close is the worker's: it knows which tab asked (sender.tab), lands on
    // the desktop first and then closes that tab — no list round trip.
    expect(bar).toContain('send({ type: "closeSelf" })');
    expect(bg).toMatch(/case "closeSelf":[\s\S]*?await goHome\(\);[\s\S]*?await chrome\.tabs\.remove\(sender\.tab\.id\);/);
    // Navigation is the page's own location; no permission grows for it.
    expect(bar).toContain("location.assign(to)");
  });

  it("the start page loads the bar, searches through the bar's rule, and links the four sites", () => {
    const html = read("newtab.html");
    // Scripts in load order: the bar's definition, then the page's own.
    expect(html).toMatch(/<script src="bar\.js"><\/script>\s*<script src="newtab\.js"><\/script>/);
    for (const ref of [...html.matchAll(/(?:src|href)="([^":]+)"/g)].map((m) => m[1])) {
      expect(exists(ref), ref).toBe(true);
    }
    expect(html).toContain('<link rel="stylesheet" href="newtab.css">');
    expect(html).toMatch(/<form class="search" role="search"/);
    expect(read("newtab.js")).toContain("clawboxKioskBar.destinationFor(input.value)");
    for (const site of ["https://duckduckgo.com/", "https://www.wikipedia.org/", "https://github.com/", "https://www.youtube.com/"]) {
      expect(html).toContain(`<a href="${site}">`);
    }
    // No inline script: MV3's default CSP for extension pages refuses it.
    expect(html).not.toMatch(/<script>|\son(?:click|load|submit|input|keydown|error)="/);
    // The desktop's shelf lists that page too (src/lib/kiosk-tabs.ts).
    const lib = fs.readFileSync(nodePath.resolve(__dirname, "../../lib/kiosk-tabs.ts"), "utf-8");
    expect(lib).toContain("START_PAGE_RE.test(t.url)");
  });

  it("closes the desktop tabs Chrome's session restore re-added, keeping the first", () => {
    // Session restore re-adds the desktop tab on every relaunch of the kiosk.
    // The worker dedupes on browser startup, on install, AND shortly after its
    // own load (neither event fires reliably after a relaunch), keeping the
    // desktop tab the owner is looking at, else the first.
    const bg = read("background.js");
    expect(bg).toContain("chrome.runtime.onStartup.addListener(dedupeDesktopTabs)");
    expect(bg).toContain("chrome.runtime.onInstalled.addListener(dedupeDesktopTabs)");
    expect(bg).toMatch(/\nsetTimeout\(dedupeDesktopTabs, \d+\);/);
    expect(bg).toContain("const desktops = all.filter((t) => t.id != null && isDesktop(t.url))");
    expect(bg).toContain("const keep = desktops.find((t) => t.active) || desktops[0];");
    expect(bg).toContain("await chrome.tabs.remove(desktops.filter((t) => t.id !== keep.id).map((t) => t.id));");
    // One implementation, not two: a second declaration would silently win.
    expect(bg.match(/async function dedupeDesktopTabs\(/g)).toHaveLength(1);
  });

  it("Enter: an address goes there, anything else is a DuckDuckGo search", () => {
    const bar = read("bar.js");
    const urlLike = new Function(`return ${regexLiteral(bar, "URL_LIKE")}`)() as RegExp;
    const searchUrl = stringConst(bar, "SEARCH_URL");
    expect(searchUrl).toBe("https://duckduckgo.com/?q=");
    // The rule the file applies, with the same lowering it does first.
    const isAddress = (s: string) => /^https?:\/\//i.test(s.trim()) || urlLike.test(s.trim().toLowerCase());
    for (const s of ["example.com", "Example.COM/path?x=1", "http://localhost:3005/", "HTTPS://a.b", " news.ycombinator.com "]) {
      expect(isAddress(s), s).toBe(true);
    }
    for (const s of ["what is 2.5 times 3", "kiosk", "localhost", "a. b", "", "cats dogs"]) {
      expect(isAddress(s), s).toBe(false);
    }
    expect(bar).toContain('return "https://" + q;');
    expect(bar).toContain("return SEARCH_URL + encodeURIComponent(q);");
  });

  it("the install script gives the kiosk Chrome dark internals", () => {
    const sh = fs.readFileSync(nodePath.resolve(__dirname, "../../../scripts/x64-migration/kiosk/install-kiosk-tabs.sh"), "utf-8");
    expect(sh).toContain('add_flag "--force-dark-mode"');
    expect(sh).toContain('add_flag "--enable-features=WebUIDarkMode"');
    // The anchor grep knows the new flags, or a rerun would insert them
    // above the extension lines rather than after.
    expect(sh).toMatch(/anchor=.*--force-dark-mode\$.*--enable-features=WebUIDarkMode\$.*--remote-allow-origins=/);
  });

  it("opens DevTools on a tab through the kiosk's CDP port, which the launcher opens to the extension", () => {
    const bar = read("bar.js");
    const bg = read("background.js");
    const sh = fs.readFileSync(nodePath.resolve(__dirname, "../../../scripts/x64-migration/kiosk/install-kiosk-tabs.sh"), "utf-8");
    const lib = fs.readFileSync(nodePath.resolve(__dirname, "../../lib/kiosk-tabs.ts"), "utf-8");
    // The bar: a </> button on every face (the desktop too), F12 and
    // Ctrl+Shift+I caught ahead of the page's own handlers.
    expect(bar).toContain('<button class="icon devtools" title="Developer tools (F12)" aria-label="Developer tools">');
    expect(bar).toContain('send({ type: "devtools" })');
    expect(bar).toMatch(/e\.key === "F12" \|\| \(e\.ctrlKey && e\.shiftKey && !e\.altKey && !e\.metaKey && e\.code === "KeyI"\)/);
    expect(bar).toMatch(/\}, true\);/);
    // The worker: the asking tab's own target, the browser endpoint, the
    // same DevTools F12 opens. It never attaches a debugger.
    expect(bg).toMatch(/case "devtools":[\s\S]*?await openDevTools\(sender\.tab\.id\);/);
    expect(bg).toContain("const target = targets.find((t) => t.tabId === tabId && t.type === \"page\");");
    expect(bg).toContain('await cdpCall(version.webSocketDebuggerUrl, "Target.openDevTools", { targetId: target.id });');
    expect(bg).not.toContain("chrome.debugger.attach");
    // One port: the worker's, the launcher's default and the desktop's.
    const port = /const CDP_PORT = (\d+);/.exec(bg)?.[1];
    expect(port).toBeDefined();
    expect(sh).toContain(`PORT="\${CLAWBOX_KIOSK_CDP_PORT:-${port}}"`);
    expect(lib).toContain(`export const DEFAULT_KIOSK_CDP_PORT = ${port};`);
    // The launcher allows exactly this extension's origin, by Chrome's rule
    // for an unpacked extension's id, and drops a stale one.
    expect(sh).toContain(`EXT_ID="$(printf '%s' "$EXT" | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p')"`);
    expect(sh).toContain('add_flag "--remote-allow-origins=chrome-extension://$EXT_ID"');
    expect(sh).toMatch(/sed -i "\/\^  --remote-allow-origins=\/\{\\\|=chrome-extension:\/\/\$EXT_ID/);
    // The rule, as Chrome applies it to the extension of a box's kiosk at
    // /home/clawbox/clawbox/kiosk/extension.
    const idFor = (p: string) =>
      [...crypto.createHash("sha256").update(p).digest("hex").slice(0, 32)].map((c) => "abcdefghijklmnop"[parseInt(c, 16)]).join("");
    expect(idFor("/home/clawbox/clawbox/kiosk/extension")).toBe("nehkanofolimmnmadochopjangeomkhk");
  });
});
