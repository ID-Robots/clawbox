import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The desktop "not refreshing" after a deploy came from a service worker an
 * earlier build had registered: cache-first for /_next/static and the page
 * shell, a fixed cache name, and an update check that /login's redirect
 * turned into "no update". Two things keep it from coming back: /sw.js must
 * be public, and the worker it fetches must be the kill switch — no fetch
 * handler, caches wiped, registration dropped.
 */
const sw = fs.readFileSync(path.resolve(__dirname, "../../../public/sw.js"), "utf8");

describe("public/sw.js", () => {
  it("is a kill switch: takes over, wipes caches, unregisters, reloads", () => {
    expect(sw).toContain("skipWaiting()");
    expect(sw).toContain("caches.keys()");
    expect(sw).toContain("caches.delete(");
    expect(sw).toContain("registration.unregister()");
    expect(sw).toContain("client.navigate(");
  });

  it("intercepts nothing", () => {
    expect(sw).not.toMatch(/addEventListener\(\s*['"]fetch['"]/);
    expect(sw).not.toMatch(/cache\.put|cache\.add|respondWith/);
  });
});
