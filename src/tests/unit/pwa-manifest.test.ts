import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * The installed home-screen app.
 *
 * The owner installs the box UI from whatever address they reached it on — the
 * LAN name, or the remote-access tunnel's host — so nothing in the manifest may
 * name a host: `id`, `start_url`, `scope` and every icon resolve against the
 * manifest's own URL and follow the origin it was installed from. And Android
 * Chrome's install needs a name, a short name, 192 and 512 px icons (maskable
 * as well as any, or the launcher draws the square icon shrunk inside a white
 * circle), a theme colour and a standalone display.
 */
const repoRoot = path.resolve(__dirname, "../../..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "public/manifest.json"), "utf8")) as {
  id?: string; name?: string; short_name?: string; start_url?: string; scope?: string;
  display?: string; theme_color?: string; background_color?: string;
  icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
};

function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("public/manifest.json", () => {
  it("names no host, so the installed app follows the origin it was installed from", () => {
    for (const field of [manifest.id, manifest.start_url, manifest.scope, ...(manifest.icons ?? []).map((i) => i.src)]) {
      expect(field, "manifest field missing").toEqual(expect.any(String));
      expect(field).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      expect(field).not.toMatch(/^\/\//);
    }
    for (const origin of ["https://abc-def.trycloudflare.com", "http://clawbox.local"]) {
      const base = `${origin}/manifest.json`;
      expect(new URL(manifest.start_url!, base).href).toBe(`${origin}/`);
      expect(new URL(manifest.scope!, base).href).toBe(`${origin}/`);
      expect(new URL(manifest.id!, base).href).toBe(`${origin}/`);
    }
  });

  it("carries what Android Chrome needs to install it as an app", () => {
    expect(manifest.name).toBe("ClawBox");
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.short_name!.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("matches the theme colour the document head declares", () => {
    const layout = fs.readFileSync(path.join(repoRoot, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain(`themeColor: "${manifest.theme_color}"`);
  });

  it.each(["any", "maskable"])("declares 192 and 512 px %s icons that exist at the size they claim", (purpose) => {
    const icons = (manifest.icons ?? []).filter((i) => (i.purpose ?? "any").split(/\s+/).includes(purpose));
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      const file = path.join(repoRoot, "public", new URL(icon.src, "http://box/manifest.json").pathname);
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(file)).toEqual({ width: w, height: h });
    }
  });

  it("never declares one icon as both any and maskable", () => {
    // The combined purpose is discouraged: the same artwork is either cropped
    // as a maskable icon or padded as an any icon, never right for both.
    for (const icon of manifest.icons ?? []) {
      expect((icon.purpose ?? "any").split(/\s+/)).toHaveLength(1);
    }
  });
});
