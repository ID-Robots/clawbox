/**
 * The Control UI's bundles must load without a session cookie.
 *
 * The gateway links its stylesheet as `<link rel="stylesheet" crossorigin>`,
 * and `crossorigin` (anonymous) omits credentials even same-origin — so that
 * request carries no cookie, the auth gate answered it with a redirect to
 * /login, and the OpenClaw app rendered unstyled behind its own "Styles failed
 * to load" banner. Module scripts default to same-origin credentials, which is
 * why the JS loaded and only the CSS broke.
 *
 * The opening is deliberately narrow: static bundle extensions, GET/HEAD, and
 * only under /assets/.
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { isGatewayStaticPath, isPublicGatewayAsset } from "@/lib/gateway-static";

describe("isPublicGatewayAsset", () => {
  it("admits the bundles a browser fetches credential-less", () => {
    for (const p of [
      "/assets/control-ui-core-C8H8-RSs.css",
      "/assets/control-ui-core-Br5DB0Zj.js",
      "/assets/index-C-r6qkLh.mjs",
      "/assets/font-latin.woff2",
      "/assets/logo.svg",
      "/assets/core.js.map",
    ]) {
      expect(isPublicGatewayAsset(p, "GET"), p).toBe(true);
      expect(isPublicGatewayAsset(p, "HEAD"), p).toBe(true);
    }
  });

  it("is read-only — a write to the same path still needs a session", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isPublicGatewayAsset("/assets/core.js", method)).toBe(false);
    }
  });

  it("does not open a static prefix to anything but a file", () => {
    // Otherwise the prefix becomes a general unauthenticated window onto the
    // gateway rather than a way to load its stylesheet.
    for (const p of [
      "/assets/secrets.env",
      "/assets/",
      "/assets/nested/dir",
      "/assets/no-extension",
      "/themes/",
      "/fonts/nope",
    ]) {
      expect(isPublicGatewayAsset(p, "GET"), p).toBe(false);
    }
  });

  it("is case-sensitive — a case-folded prefix is NOT public", () => {
    // The gate must agree with the ROUTER, which is case-sensitive. When
    // middleware passed a lower-cased path here, /ASSETS/x.css was admitted
    // without a session, matched no /assets route, and fell to the catch-all,
    // which answered an unauthenticated caller with the SPA shell — and that
    // shell carries the injected gateway auth token.
    for (const p of [
      "/ASSETS/x.css",
      "/Assets/x.css",
      "/THEMES/dash.css",
      "/Fonts/geist.css",
      "/ASSET-MANIFEST.JSON",
    ]) {
      expect(isPublicGatewayAsset(p, "GET"), p).toBe(false);
      expect(isGatewayStaticPath(p), p).toBe(false);
    }
  });

  it("covers no path outside the gateway's own trees", () => {
    for (const p of ["/api/status.js", "/setup-api/kv.css", "/assetsx/a.js", "/a.js"]) {
      expect(isPublicGatewayAsset(p, "GET"), p).toBe(false);
    }
  });

  // The trees the Control UI keeps OUTSIDE /assets. Missing them is what left
  // the app unstyled after the /assets fix: `/fonts/geist.css` was answered
  // 200 text/html with the 19 KB SPA shell, and `/themes/*.css` with a 307 to
  // /login — a stylesheet that parses as nothing either way.
  it("covers the trees outside /assets that the UI also loads", () => {
    for (const p of [
      "/themes/dash.css",
      "/fonts/geist.css",
      "/fonts/geist/geist-400.woff2",
      "/provider-icons/openai.svg",
      "/file-icons/ts.svg",
      "/app-art/cover.png",
      "/plugin-art/icon.png",
      "/asset-manifest.json",
      "/manifest.webmanifest",
      "/apple-touch-icon.png",
    ]) {
      expect(isPublicGatewayAsset(p, "GET"), p).toBe(true);
      expect(isGatewayStaticPath(p), p).toBe(true);
    }
  });

  // Since the middleware matcher stopped skipping `/fonts/`, this gate is the
  // ONLY thing that lets the box's own font files load without a session —
  // the wizard over the captive portal and the /updating page both draw with
  // them before or without a cookie. So every file actually shipped under
  // public/fonts/ has to pass it, or the next font added with an extension
  // the list lacks would render as a redirect to /login.
  it("admits every file shipped in public/fonts/", () => {
    const dir = path.join(process.cwd(), "public", "fonts");
    const files = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      expect(isPublicGatewayAsset(`/fonts/${name}`, "GET"), name).toBe(true);
      expect(isPublicGatewayAsset(`/fonts/${name}`, "HEAD"), name).toBe(true);
    }
  });

  it("routes those same paths as bytes, never as the SPA shell", () => {
    // isGatewayStaticPath is what the catch-all asks before deciding to serve
    // HTML; a false here is a stylesheet answered with the app shell.
    expect(isGatewayStaticPath("/fonts/geist.css")).toBe(true);
    expect(isGatewayStaticPath("/chat")).toBe(false);
    expect(isGatewayStaticPath("/chat/main")).toBe(false);
    expect(isGatewayStaticPath("/sessions")).toBe(false);
  });
});
