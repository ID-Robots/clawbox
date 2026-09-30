import { describe, expect, it } from "vitest";
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
 *  - the manifest asks for `tabs` and nothing else, runs on http(s) only, and
 *    never injects the bar into the desktop itself;
 *  - the bar is ONE file (bar.js) mounted from two places — the content
 *    script on web pages and newtab.html on the start page — so both look
 *    and behave the same, and the page offset matches the bar's height;
 *  - the bar's address rule (Enter: address or search), the "+" landing on
 *    the extension's start page, and the start page's own search box;
 *  - the version is bumped (semver): Chrome caches unpacked extension code
 *    across restarts and re-reads it only when the version changes.
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

const JS_FILES = ["background.js", "bar.js", "content.js", "newtab.js"];
const BAR_H = 40;

describe("kiosk extension", () => {
  it("has its files and valid JS", () => {
    for (const f of ["manifest.json", ...JS_FILES, "content.css", "newtab.html", "newtab.css", "icon.svg"]) {
      expect(exists(f), f).toBe(true);
    }
    // A syntax error would only show in chrome://extensions on the laptop.
    for (const f of JS_FILES) {
      expect(() => new Function(read(f).replace(/\bchrome\b/g, "globalThis.chrome")), f).not.toThrow();
    }
  });

  it("asks for tabs only, http(s) only, and stays off the desktop's own origin", () => {
    const m = JSON.parse(read("manifest.json"));
    expect(m.manifest_version).toBe(3);
    expect(m.permissions).toEqual(["tabs"]);
    expect(m.host_permissions).toBeUndefined();
    expect(m.background).toEqual({ service_worker: "background.js" });
    const [cs] = m.content_scripts;
    expect(cs.matches).toEqual(["http://*/*", "https://*/*"]);
    expect(cs.exclude_matches).toEqual(expect.arrayContaining(["http://localhost:3005/*", "http://127.0.0.1:3005/*"]));
    expect(cs.all_frames).toBe(false);
    // bar.js first: content.js is one call into what it defines.
    expect(cs.js).toEqual(["bar.js", "content.js"]);
    expect(cs.css).toEqual(["content.css"]);
  });

  it("carries a semver version, bumped past 1.0.0", () => {
    const m = JSON.parse(read("manifest.json"));
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = m.version.split(".").map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThan(1e6);
  });

  it("every file the manifest names exists", () => {
    const m = JSON.parse(read("manifest.json"));
    const named = new Set<string>([
      m.background.service_worker,
      ...m.content_scripts.flatMap((cs: { js: string[]; css: string[] }) => [...cs.js, ...cs.css]),
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

  it(`the bar is a shadow root at a fixed ${BAR_H} px, matched by the page offset on both hosts`, () => {
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
    expect(bg).toMatch(/case "create":/);
    expect(bg).toContain('const START_PAGE = chrome.runtime.getURL("newtab.html");');
    expect(bg).toContain("if (msg.url == null) {");
    expect(bg).toContain("await chrome.tabs.create({ url: START_PAGE, active: true });");
    expect(JSON.parse(read("manifest.json")).chrome_url_overrides).toEqual({ newtab: "newtab.html" });
    // A URL given still has to be a web page.
    expect(bg).toMatch(/\^https\?:\\\/\\\/.*\.test\(msg\.url\)/);
    expect(bg).toContain("chrome.tabs.create({ url: msg.url, active: true })");
    // Navigation is the page's own location; no permission grows for it.
    expect(bar).toContain("location.assign(to)");
    expect(JSON.parse(read("manifest.json")).permissions).toEqual(["tabs"]);
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
    expect(sh).toMatch(/anchor=.*--force-dark-mode\$.*--enable-features=WebUIDarkMode\$/);
  });
});
