/**
 * The icons a logged-out browser must be able to fetch.
 *
 * `public/manifest.json` is public, `display: standalone`, `sw.js` and
 * `appleWebApp.capable` are all in place — installing the box UI as an app is a
 * shipped feature. But the two icons the manifest DECLARES were not on the
 * middleware allow-list, so a browser fetching them while offering "Install
 * page as app" followed the 307 to /login and got a 31-byte redirect body
 * instead of a PNG: no icon in the install prompt, and browsers that require a
 * resolvable 192 px icon refused the prompt outright. `curl -f` does not even
 * error on it — the box answers a redirect, not a 4xx.
 *
 * The assertions are DERIVED from the declaration sites — the manifest's own
 * `icons[]` and the root layout's `metadata.icons` object, read as VALUES and
 * not as text, so every legal shape counts (a bare string in `icons.icon`, a
 * manifest `src` relative to the manifest URL) rather than only the two spelt
 * today. A guard that filtered for one shape would go quietly green over an
 * icon declared in another and 307ing on every box, which is this defect again.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Metadata } from "next";
import fs from "fs";
import os from "os";
import path from "path";

const repoRoot = path.resolve(__dirname, "../../..");

/**
 * Every icon path `public/manifest.json` declares.
 *
 * A manifest `src` is resolved against the manifest's own URL, so a relative
 * one is just as real as an absolute one — resolve rather than filter.
 */
function manifestIconPaths(): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "public/manifest.json"), "utf8"),
  ) as { icons?: Array<{ src?: string }> };
  const paths = (manifest.icons ?? [])
    .map((icon) => icon.src)
    .filter((src): src is string => typeof src === "string")
    .map((src) => new URL(src, "http://box/manifest.json").pathname);
  expect(paths.length, "manifest.json declares no icons").toBeGreaterThan(0);
  return paths;
}

/**
 * Every icon URL `src/app/layout.tsx` puts in the document head.
 *
 * `Metadata["icons"]` is a union: a bare string or URL, an array of those or of
 * `{ url }` descriptors, or an object keyed by rel (`icon`, `shortcut`,
 * `apple`, `other`). All of them end up as a `<link>` the browser fetches, so
 * all of them are walked. Anything absolute is somebody else's origin and not
 * this gate's business.
 */
function collectIconUrls(node: unknown, into: string[]): void {
  if (node === null || node === undefined) return;
  if (typeof node === "string" || node instanceof URL) {
    // Resolved, not filtered on a leading slash: a `new URL("/icon.png", …)`
    // stringifies absolute, and dropping it would be this guard
    // under-deriving again. Anything on another ORIGIN is somebody else's
    // asset and not this gate's business.
    const resolved = new URL(String(node), "http://box/");
    if (resolved.origin === "http://box") into.push(resolved.pathname + resolved.search);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectIconUrls(item, into);
    return;
  }
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    // An `IconDescriptor` is `{ url, sizes?, type?, … }` — only `url` is a URL.
    // Walking every value turned `sizes: "48x48"` into a path and asked the
    // gate for `/48x48`. Anything else here is the rel-keyed `Icons` object
    // (`icon`, `shortcut`, `apple`, `other`), whose values are all icons.
    if ("url" in record) {
      collectIconUrls(record.url, into);
      return;
    }
    for (const value of Object.values(record)) collectIconUrls(value, into);
  }
}

async function layoutIconPaths(): Promise<string[]> {
  const { metadata } = (await import("@/app/layout")) as { metadata: Metadata };
  const urls: string[] = [];
  collectIconUrls(metadata.icons, urls);
  // The manifest is declared here too and is fetched by the same logged-out
  // browser, so it belongs in the same check.
  collectIconUrls(metadata.manifest, urls);
  expect(urls.length, "layout.tsx declares no head icons").toBeGreaterThan(0);
  return urls;
}

describe("assets declared to the browser are reachable without a session", () => {
  let tmpRoot: string;

  function armAuth(bootstrapOpen: boolean) {
    fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "data/config.json"),
      // An owner and a finished wizard = the gate fully armed. The empty
      // object is a box still inside the first-boot bootstrap window, whose
      // wizard pages carry the same head icons.
      JSON.stringify(bootstrapOpen ? {} : { setup_complete: true, password_configured: true }),
    );
  }

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pwa-icons-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    process.env.SESSION_SECRET = "test-secret";
    delete process.env.CLAWBOX_TEST_MODE;
    armAuth(false);
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    delete process.env.CLAWBOX_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function get(pathname: string, method = "GET") {
    const mod = await import("@/middleware");
    return mod.middleware(
      new NextRequest(new URL(`http://localhost${pathname}`), { method }),
    );
  }

  async function expectServed(pathname: string) {
    const response = await get(pathname);
    expect(response.status, `${pathname} must not need a session`).toBe(200);
    expect(response.headers.get("Location"), pathname).toBeNull();
  }

  it("serves every icon public/manifest.json declares", async () => {
    for (const iconPath of manifestIconPaths()) await expectServed(iconPath);
  });

  it("serves everything the root layout puts in the document head", async () => {
    for (const iconPath of await layoutIconPaths()) await expectServed(iconPath);
  });

  it("serves them during the first-boot bootstrap window too", async () => {
    // The wizard's own pages carry the same head, and this is the state a box
    // is in when its owner first opens it.
    armAuth(true);
    vi.resetModules();
    for (const iconPath of [...manifestIconPaths(), ...(await layoutIconPaths())]) {
      await expectServed(iconPath);
    }
  });

  it("still shields a non-icon page and the API surface", async () => {
    // The opening is these assets only; it must not have widened the gate.
    expect((await get("/dashboard")).status).toBe(307);
    expect((await get("/setup-api/system/info")).status).toBe(401);
  });

  it("admits the exact path only — never a case-folded or trailing-slash lookalike", async () => {
    // middleware.ts decides on the RAW pathname because the ROUTER routes the
    // raw string: a lower-cased match would admit /ICON-192.PNG, which matches
    // no file in public/ and falls through to the gateway catch-all — served,
    // unauthenticated, with the SPA shell. That bypass has been shipped twice
    // (/Login, /ASSETS/x.css); this pins it for the entries added here.
    for (const lookalike of ["/ICON-192.PNG", "/Icon-512.png", "/icon-192.png/", "/favicon-32X32.png"]) {
      expect((await get(lookalike)).status, lookalike).toBe(307);
    }
  });

  it("admits a HEAD as well as a GET — a browser asks before it fetches", async () => {
    for (const iconPath of manifestIconPaths()) {
      const response = await get(iconPath, "HEAD");
      expect(response.status, `HEAD ${iconPath}`).toBe(200);
      expect(response.headers.get("Location"), iconPath).toBeNull();
    }
  });

  it("is read-only — a write to an icon path still needs a session", async () => {
    // Safe today only because Next's public/ handler and the gateway catch-all
    // both answer GET, so a POST 405s before anything else looks at it. The
    // gate says so itself rather than relying on what happens to sit behind it.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await get("/icon-192.png", method)).status, method).toBe(307);
    }
  });
});
