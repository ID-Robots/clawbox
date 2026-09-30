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
 *    never injects the bar into the desktop itself.
 */
const EXT = nodePath.resolve(__dirname, "../../../kiosk/extension");
const read = (f: string) => fs.readFileSync(nodePath.join(EXT, f), "utf-8");

function regexLiteral(source: string, name: string): string {
  const m = new RegExp(`const ${name} = (/.*?/);`).exec(source);
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
});
