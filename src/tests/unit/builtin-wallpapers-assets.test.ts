import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { builtinWallpapers } from "@/lib/builtin-wallpapers";

/**
 * Every built-in wallpaper that names an image file ships that file under
 * `public/`. A tile is an `<img src>` and the desktop paints the picture as a
 * `background-image`, so an entry whose file is missing is a broken tile on the
 * Appearance card and a black desktop on a fresh box — the default wallpaper
 * most of all.
 *
 * `lobster-orbital-wallpaper.jpeg` (the OpenClaw default since 2026-09-15) is
 * a 3840×2160 picture the OWNER supplies; this fails until it lands, on
 * purpose — the alternative is a default the box cannot draw.
 */
const PUBLIC_DIR = path.join(process.cwd(), "public");

describe("the built-in wallpapers' image files", () => {
  const images = [...builtinWallpapers("openclaw"), ...builtinWallpapers("hermes")]
    .filter((wp) => wp.image !== "")
    .map((wp) => wp.image);

  it.each([...new Set(images)])("ships %s under public/", (image) => {
    const file = path.join(PUBLIC_DIR, image.replace(/^\//, ""));
    expect(fs.existsSync(file), `${file} is missing`).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(0);
  });
});
