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
 * The assertions are DERIVED from the declaration sites (the manifest's own
 * `icons[]` and the root layout's `metadata.icons`) rather than hard-coded, so
 * adding an icon to either place without opening the gate fails here.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

const repoRoot = path.resolve(__dirname, "../../..");

function manifestIconPaths(): string[] {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "public/manifest.json"), "utf8"),
  ) as { icons?: Array<{ src?: string }> };
  const srcs = (manifest.icons ?? [])
    .map((i) => i.src)
    .filter((s): s is string => typeof s === "string" && s.startsWith("/"));
  expect(srcs.length, "manifest.json declares no icons").toBeGreaterThan(0);
  return srcs;
}

/**
 * The icon URLs `src/app/layout.tsx` puts in the document head. Read as text
 * rather than imported: layout.tsx pulls in globals.css and the whole app
 * shell, and this only needs the declared URLs.
 */
function layoutIconPaths(): string[] {
  const source = fs.readFileSync(path.join(repoRoot, "src/app/layout.tsx"), "utf8");
  const block = source.slice(source.indexOf("icons: {"), source.indexOf("appleWebApp:"));
  const urls = [...block.matchAll(/url:\s*"(\/[^"]+)"/g)].map((m) => m[1]);
  expect(urls.length, "layout.tsx declares no icon urls").toBeGreaterThan(0);
  return urls;
}

describe("icons declared to the browser are reachable without a session", () => {
  let tmpRoot: string;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pwa-icons-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    // A box with an owner and a finished wizard — the state in which the auth
    // gate is fully armed.
    fs.mkdirSync(path.join(tmpRoot, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "data/config.json"),
      JSON.stringify({ setup_complete: true, password_configured: true }),
    );
    process.env.SESSION_SECRET = "test-secret";
    delete process.env.CLAWBOX_TEST_MODE;
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    delete process.env.CLAWBOX_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function get(pathname: string) {
    const mod = await import("@/middleware");
    return mod.middleware(new NextRequest(new URL(`http://localhost${pathname}`)));
  }

  it("serves every icon public/manifest.json declares", async () => {
    for (const iconPath of manifestIconPaths()) {
      const response = await get(iconPath);
      expect(response.status, `${iconPath} must not need a session`).toBe(200);
      expect(response.headers.get("Location"), iconPath).toBeNull();
    }
  });

  it("serves every icon the root layout puts in the document head", async () => {
    for (const iconPath of layoutIconPaths()) {
      const response = await get(iconPath);
      expect(response.status, `${iconPath} must not need a session`).toBe(200);
      expect(response.headers.get("Location"), iconPath).toBeNull();
    }
  });

  it("still shields a non-icon page and the API surface", async () => {
    // The opening is icons only; it must not have widened the gate.
    expect((await get("/dashboard")).status).toBe(307);
    expect((await get("/setup-api/system/info")).status).toBe(401);
  });
});
