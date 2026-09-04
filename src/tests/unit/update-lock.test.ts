import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The desktop lock.
 *
 * `updateClawBoxAndReboot` runs `git reset --hard` and `git clean -fd` over the
 * project while the desktop is still on screen, and every app on it can write
 * through /setup-api — so a window left open can save into a tree being
 * rewritten underneath it. While an update owns the box, the middleware sends
 * page navigations to /updating instead.
 *
 * The flag has to be on DISK rather than in the updater's memory, because the
 * reader is the middleware: it answers before any route handler is entered, and
 * it already reads data/config.json with `fs` for setup_complete.
 *
 * Two properties decide whether this helps or harms, and neither is visible in
 * the happy path:
 *  - it must SURVIVE the reboot the update performs, or the desktop unlocks
 *    while post_update is still rewriting the box;
 *  - it must never OUTLIVE a dead update, or the owner is locked out of the
 *    surfaces they need to recover with.
 */
const REPO = process.cwd();
const UPDATER = readFileSync(path.join(REPO, "src/lib/updater.ts"), "utf-8");
const NL = String.fromCharCode(10);

function fn(name: string): string {
  const start = UPDATER.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in updater.ts`);
  const end = UPDATER.indexOf(`${NL}}`, start);
  return UPDATER.slice(start, end);
}

describe("the lock is written where a run starts and released where one ends", () => {
  it("is set when the owner starts an update", () => {
    expect(fn("startUpdate")).toContain("setUpdateLock()");
  });

  it("is re-asserted by the half that runs after the reboot", () => {
    // A box power-cycled rather than rebooted by the update may have lost the
    // write; the second half owns the box just as much as the first.
    const resume = fn("resumeContinuation");
    expect(resume).toContain("setUpdateLock()");
  });

  it("is released exactly once on the success path, in launchUpdate", () => {
    expect(fn("launchUpdate")).toContain("clearUpdateLock()");
  });

  it("is NOT released on the reboot path", () => {
    // This is the property that makes the lock work at all. do_rebuild kills
    // the web server mid-run; if anything on that path cleared the flag, the
    // desktop would unlock while post_update, gateway_verify and
    // verify_build_identity were still to come.
    for (const name of ["updateClawBoxAndReboot", "waitForRebuildToTakeOver"]) {
      expect(fn(name), `${name} must not release the lock`).not.toContain("clearUpdateLock");
    }
  });

  it("is released at boot when there is no update left to resume", () => {
    // The anti-lockout guarantee. A run that died between setting the lock and
    // writing its continuation flag would otherwise leave the desktop locked
    // with nothing left to unlock it.
    const resume = fn("resumeContinuation");
    const noContinuation = resume.indexOf("if (!needsContinuation)");
    expect(noContinuation).toBeGreaterThan(-1);
    const branch = resume.slice(noContinuation, resume.indexOf("return false", noContinuation));
    expect(branch, "the nothing-to-resume branch must clear the lock").toContain("clearUpdateLock()");
  });

  it("is released when the rebuild produced no new build", () => {
    const resume = fn("resumeContinuation");
    expect(resume).toContain("await clearUpdateLock()");
  });
});

describe("the updating screen tells the truth about escaping", () => {
  const PAGE = readFileSync(path.join(REPO, "src/app/updating/page.tsx"), "utf-8");

  it("offers no link back to the desktop, because one would not work", () => {
    // While the lock is set the middleware redirects "/" straight back here,
    // so a button offering escape would be a button that does nothing.
    expect(PAGE).not.toMatch(/href="\/"/);
  });

  it("names the escape that does work: a restart", () => {
    // Load-bearing, and true because of the boot release pinned above: at boot
    // the updater finds no update to resume and clears the lock.
    expect(PAGE).toMatch(/restart it/i);
  });

  it("holds the screen when a poll fails, instead of taking it down", () => {
    // The inverse of the usual rule. do_rebuild stops the web server for
    // minutes; a failed poll is the normal course of an update, not evidence
    // that it ended.
    expect(PAGE).toContain("setOffline(true)");
    const catchAt = PAGE.indexOf("} catch {");
    expect(PAGE.slice(catchAt, catchAt + 400)).not.toContain("window.location");
  });
});

describe("update-lock — behaviour against a real config store", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "update-lock-"));
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    process.env.CLAWBOX_ROOT = tmp;
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.CLAWBOX_ROOT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const onDisk = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(tmp, "data", "config.json"), "utf-8"));
    } catch {
      return {};
    }
  };

  it("writes a flag the middleware can read without importing anything", () => {
    // The middleware parses config.json itself; the key is the whole contract.
    return import("@/lib/update-lock").then(async (m) => {
      expect(m.UPDATE_LOCK_KEY).toBe("update_in_progress");
      await m.setUpdateLock();
      expect(onDisk()[m.UPDATE_LOCK_KEY]).toBe(true);
      expect(await m.isUpdateLocked()).toBe(true);
    });
  });

  it("removes the key rather than writing false", () => {
    // An older middleware reading `false` and a newer one reading `undefined`
    // must reach the same answer; absent is the one both agree on.
    return import("@/lib/update-lock").then(async (m) => {
      await m.setUpdateLock();
      await m.clearUpdateLock();
      expect(m.UPDATE_LOCK_KEY in onDisk()).toBe(false);
      expect(await m.isUpdateLocked()).toBe(false);
    });
  });

  it("reports unlocked on a box that has never updated", () => {
    return import("@/lib/update-lock").then(async (m) => {
      expect(await m.isUpdateLocked()).toBe(false);
    });
  });
});
