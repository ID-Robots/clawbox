import { describe, expect, it } from "vitest";
import fs from "node:fs";
import nodePath from "node:path";

/**
 * kiosk/extension — the MV3 extension the kiosk Chrome loads (no build step,
 * plain JS). Nothing here runs it; what this pins is the two things that must
 * agree with the rest of the repo:
 *
 *  - background.js decides "is this tab the desktop" with the SAME path rule
 *    src/lib/kiosk-tabs.ts uses, or the shelf and the bar would disagree
 *    about which tab "home" is;
 *  - the manifest asks for `tabs` and nothing else, runs on http(s) only, and
 *    never injects the bar into the desktop itself;
 *  - the bar's address rule (Enter: address or search) and its start page,
 *    which is the desktop's own Web icon's URL (src/lib/desktop-apps.ts).
 */
const EXT = nodePath.resolve(__dirname, "../../../kiosk/extension");
const read = (f: string) => fs.readFileSync(nodePath.join(EXT, f), "utf-8");

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

describe("kiosk extension", () => {
  it("has the four files and valid JS", () => {
    for (const f of ["manifest.json", "background.js", "content.js", "content.css", "icon.svg"]) {
      expect(fs.existsSync(nodePath.join(EXT, f)), f).toBe(true);
    }
    // A syntax error would only show in chrome://extensions on the laptop.
    for (const f of ["background.js", "content.js"]) {
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
    expect(cs.js).toEqual(["content.js"]);
    expect(cs.css).toEqual(["content.css"]);
  });

  it("names the desktop with the same shell-path rule as src/lib/kiosk-tabs.ts", () => {
    const lib = fs.readFileSync(nodePath.resolve(__dirname, "../../lib/kiosk-tabs.ts"), "utf-8");
    expect(regexLiteral(read("background.js"), "SHELL_PATH")).toBe(regexLiteral(lib, "SHELL_PATH_RE"));
  });

  it("the bar's host is a shadow root at a fixed 36 px, matched by the page offset", () => {
    const js = read("content.js");
    expect(js).toContain("attachShadow");
    expect(js).toContain("const BAR_H = 36");
    expect(read("content.css")).toMatch(/margin-top:\s*36px/);
  });

  it("draws an address bar and a + that opens the desktop's Web start page", () => {
    const js = read("content.js");
    expect(js).toMatch(/<input class="address" type="text"/);
    expect(js).toMatch(/<button class="add"/);
    // "+" goes through the worker (it holds `tabs`), on the same start page
    // the desktop's Web icon opens — one place to change, not two.
    const startUrl = stringConst(js, "START_URL");
    expect(js).toContain('send({ type: "create", url: START_URL })');
    const registry = fs.readFileSync(nodePath.resolve(__dirname, "../../lib/desktop-apps.ts"), "utf-8");
    expect(registry).toContain(`id: "web", name: "app.web", color: "#0f766e", type: "external", url: "${startUrl}"`);
    // The worker answers it, and only for a web page.
    const bg = read("background.js");
    expect(bg).toMatch(/case "create":/);
    expect(bg).toMatch(/\^https\?:\\\/\\\/.*\.test\(msg\.url\)/);
    expect(bg).toContain("chrome.tabs.create({ url: msg.url, active: true })");
    // Navigation is the page's own location; no permission grows for it.
    expect(js).toContain("location.assign(to)");
    expect(JSON.parse(read("manifest.json")).permissions).toEqual(["tabs"]);
  });

  it("Enter: an address goes there, anything else is a DuckDuckGo search", () => {
    const js = read("content.js");
    const urlLike = new Function(`return ${regexLiteral(js, "URL_LIKE")}`)() as RegExp;
    const searchUrl = stringConst(js, "SEARCH_URL");
    expect(searchUrl).toBe("https://duckduckgo.com/?q=");
    // The rule the file applies, with the same lowering it does first.
    const isAddress = (s: string) => /^https?:\/\//i.test(s.trim()) || urlLike.test(s.trim().toLowerCase());
    for (const s of ["example.com", "Example.COM/path?x=1", "http://localhost:3005/", "HTTPS://a.b", " news.ycombinator.com "]) {
      expect(isAddress(s), s).toBe(true);
    }
    for (const s of ["what is 2.5 times 3", "kiosk", "localhost", "a. b", "", "cats dogs"]) {
      expect(isAddress(s), s).toBe(false);
    }
    expect(js).toContain('return "https://" + q;');
    expect(js).toContain("return SEARCH_URL + encodeURIComponent(q);");
  });
});
