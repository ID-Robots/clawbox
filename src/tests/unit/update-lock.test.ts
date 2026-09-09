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
  it("is taken before the first step runs, and awaited", () => {
    // Awaited, not fired and forgotten: config-store.set happens to be
    // synchronous inside today, and nothing here should depend on that staying
    // true. Reported by CodeRabbit on #649.
    const run = fn("runUpdate");
    expect(run).toContain("await setUpdateLock()");
    expect(run.indexOf("await setUpdateLock()")).toBeLessThan(run.indexOf("for (let i = startFrom"));
  });

  it("is re-asserted at every step boundary, because another process can drop it", () => {
    // config-store.set is an unlocked read-modify-write of the whole of
    // data/config.json, and post_update runs install.sh and restarts the
    // gateway — both of which write that file by their own paths. A writer that
    // read it before the flag was set and wrote after removes it silently.
    //
    // Observed on hardware 2026-09-04: set 17:44, gone by 17:51, run finished
    // 17:53:29 — the desktop unlocked while post_update was still rewriting the
    // box. One write per step heals it within a step.
    const run = fn("runUpdate");
    const loopAt = run.indexOf("for (let i = startFrom");
    expect(loopAt).toBeGreaterThan(-1);
    const body = run.slice(loopAt);
    expect(body, "the loop must re-take the lock").toContain("setUpdateLock()");
    // Before the step runs, not after it.
    expect(body.indexOf("setUpdateLock()")).toBeLessThan(body.indexOf("Running step:"));
  });

  it("is taken by the flow that rewrites the tree, and not by the other one", () => {
    // The OpenClaw-only flow reinstalls a package and bounces the gateway; it
    // never runs `git reset --hard`, so locking the owner's desktop for it
    // would be over-reach. Same test the drift baseline uses.
    const run = fn("runUpdate");
    const at = run.indexOf("await setUpdateLock()");
    expect(run.slice(0, at)).toContain("steps.some((s) => s.id === RESTART_STEP_ID)");
  });

  it("covers the half that runs after the reboot", () => {
    // runUpdate is the entry point for both halves, so one call covers the
    // continuation too — whose flag survived the reboot, but may not have on a
    // box that was power-cycled instead.
    expect(fn("runUpdate")).toContain("await setUpdateLock()");
    // …and the fire-and-forget calls it replaced are gone.
    expect(fn("startUpdate")).not.toContain("void setUpdateLock");
    expect(fn("resumeContinuation")).not.toContain("void setUpdateLock");
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
    // The whole branch, not up to its first `return false`: it now returns
    // early for an update that is STILL RUNNING in another process, and the
    // release lives past that.
    const branch = resume.slice(noContinuation, resume.indexOf("// The restart this is resuming", noContinuation));
    expect(branch, "the nothing-to-resume branch must clear the lock").toContain("clearUpdateLock()");
  });

  it("does NOT release a lock another process is still updating under", () => {
    // The same evidence — lock held, nothing to resume — is what a second web
    // server sees while the FIRST one is still working through the steps: an
    // update restarts this process by design and the old one keeps going. Read
    // as a crash, the new process released the lock and stamped an
    // interruption, so a run whose journal shows every step completing was
    // reported failed with every step pending.
    const resume = fn("resumeContinuation");
    const noContinuation = resume.indexOf("if (!needsContinuation)");
    const branch = resume.slice(noContinuation, resume.indexOf("// The restart this is resuming", noContinuation));
    const guard = branch.indexOf("updateLockHeldByLiveProcess()");
    expect(guard, "the branch must ask whether the update is still running").toBeGreaterThan(-1);
    expect(guard, "and it must ask BEFORE releasing the lock").toBeLessThan(branch.indexOf("clearUpdateLock()"));
  });

  it("is released when the rebuild produced no new build", () => {
    const resume = fn("resumeContinuation");
    expect(resume).toContain("await clearUpdateLock()");
  });
});

describe("a desktop that was already open learns the update started", () => {
  const MIDDLEWARE = readFileSync(path.join(REPO, "src/middleware.ts"), "utf-8");
  const DESKTOP = readFileSync(path.join(REPO, "src/app/page.tsx"), "utf-8");
  const CONSTANTS = readFileSync(path.join(REPO, "src/lib/update-constants.ts"), "utf-8");

  it("stamps the lock header on /setup-api while the lock is held", () => {
    // The redirect above only fires on a NAVIGATION, and a page that is already
    // open makes none: it stayed on the desktop, kept polling, and went blank
    // when the rebuild stopped the web server under it. Reported on the box,
    // 2026-09-09 — the owner had to reload by hand to reach /updating.
    expect(MIDDLEWARE).toMatch(/const updateInProgress = readConfigCached\(\)\.updateInProgress/);
    // `isSetupApiPath`, not a bare `startsWith("/setup-api")`: that helper
    // matches on a SEGMENT boundary, which is the rule the rest of this file
    // already lives by — `/setup-api` also starts with `/setup`, and a
    // hand-rolled prefix test is how the two namespaces get folded into one.
    expect(MIDDLEWARE).toMatch(
      /if \(updateInProgress && isSetupApiPath\(pathname\)\) \{\s*\n\s*res\.headers\.set\(UPDATE_LOCK_HEADER, "1"\);/,
    );
  });

  it("still refuses to REDIRECT an API call", () => {
    // Defect #304: an API surface answering a navigation redirect with HTML.
    // The header is the whole point — it carries the fact without moving the
    // request. The redirect stays gated on a desktop PAGE path.
    expect(MIDDLEWARE).toMatch(/if \(isDesktopPagePath\(pathname\) && updateInProgress\)/);
  });

  it("turns the header into a navigation from a request the desktop already makes", () => {
    // Read off the pending-actions poll rather than a new interval or endpoint:
    // the lock is read for the redirect regardless, so the header is free, and
    // nothing new has to be polled for a twice-a-year event.
    expect(DESKTOP).toMatch(/res\.headers\.get\(UPDATE_LOCK_HEADER\) === "1"/);
    // `replace`, not `assign`: the page it leaves is one the middleware would
    // bounce straight back, so it must not be left in history.
    expect(DESKTOP).toMatch(/window\.location\.replace\(UPDATING_PAGE\)/);
  });

  it("keeps both constants out of the fs-importing module", () => {
    // update-lock.ts opens with `import fs`, and the desktop is a client
    // component — importing the constants from there would drag Node's fs into
    // the browser bundle, which is the exact reason update-constants.ts exists.
    expect(CONSTANTS).toMatch(/export const UPDATE_LOCK_HEADER = "x-clawbox-update-lock"/);
    expect(CONSTANTS).toMatch(/export const UPDATING_PAGE = "\/updating"/);
    expect(CONSTANTS).not.toMatch(/^import /m);
    expect(DESKTOP).toMatch(/from "@\/lib\/update-constants"/);
    expect(DESKTOP).not.toMatch(/from "@\/lib\/update-lock"/);
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

  it("mounts its own I18nProvider, or it would render raw keys", () => {
    // The root layout is a server component and mounts none, and useT() without
    // a provider returns a fallback that renders the KEY — this screen would
    // have shown a literal "update.title" to the owner. tsc cannot see it.
    // /login and /app/[id] each mount their own for the same reason.
    expect(PAGE).toContain("I18nProvider");
    expect(PAGE.indexOf("<I18nProvider>")).toBeLessThan(PAGE.indexOf("<UpdatingScreen />"));
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

  it("says whether it actually took the lock, and says so out loud when it did not", async () => {
    // A failure must not stop the update — refusing to update a box because a
    // courtesy lock could not be written is the worse outcome, and an
    // unwritable config.json is exactly what an update exists to repair. But it
    // must not be silent either. Reported by CodeRabbit on #649.
    const m = await import("@/lib/update-lock");
    expect(await m.setUpdateLock()).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Make the store unwritable: a FILE where the data directory should be.
    fs.rmSync(path.join(tmp, "data"), { recursive: true, force: true });
    fs.writeFileSync(path.join(tmp, "data"), "not a directory");
    expect(await m.setUpdateLock()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports unlocked on a box that has never updated", () => {
    return import("@/lib/update-lock").then(async (m) => {
      expect(await m.isUpdateLocked()).toBe(false);
    });
  });
});
