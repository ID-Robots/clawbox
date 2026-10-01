/**
 * Every Web UI page follows a session switch (TASK-1247).
 *
 * The follower is mounted per page, not in the root layout — the layout is a
 * server component and each page already owns its providers — so a NEW page
 * route could quietly be left behind on the previous session. This asks every
 * `page.tsx` under src/app for the hook; a page that deliberately does not
 * follow is named below with its reason.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = path.resolve(__dirname, "../../app");

/** Pages that are not tied to this box's session at all. */
const NOT_SESSION_PAGES: Record<string, string> = {
  // A public, server-rendered price page — the same for everyone, signed in or not.
  "portal/subscribe/page.tsx": "public plan page, no session",
};

function pages(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return pages(full);
    return entry.name === "page.tsx" ? [path.relative(APP_DIR, full).split(path.sep).join("/")] : [];
  });
}

describe("session-switch coverage of the page routes", () => {
  const all = pages(APP_DIR);

  it("finds the pages it is about", () => {
    for (const expected of ["page.tsx", "login/page.tsx", "app/[id]/page.tsx", "updating/page.tsx", "setup/page.tsx", "setup/settings/page.tsx"]) {
      expect(all).toContain(expected);
    }
  });

  it.each(all.filter((p) => !(p in NOT_SESSION_PAGES)))("%s follows a session switch", (page) => {
    const source = fs.readFileSync(path.join(APP_DIR, page), "utf8");
    expect(source).toMatch(/^"use client";/);
    expect(source).toMatch(/\buseFollowSessionSwitch\(/);
  });

  it("names only exemptions that still exist", () => {
    for (const page of Object.keys(NOT_SESSION_PAGES)) expect(all).toContain(page);
  });
});
