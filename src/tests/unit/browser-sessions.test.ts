/**
 * The CDP page registry — who opened which tab, and whose tab gets closed.
 *
 * It exists as its own module for exactly one reason: a coding run has to be
 * able to close ITS pages when it settles, and the runner cannot reach into a
 * route handler to do it. So the property that matters most here is the one
 * that was wrong while the registry lived in the route — closing a run's pages
 * must never touch the owner's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBrowserSessionsForTests,
  closeSession,
  closeSessionsForRun,
  getSession,
  openSession,
  SESSION_TIMEOUT_MS,
  sessionCount,
  sweepIdle,
  touchSession,
} from "@/lib/browser-sessions";

/** A page is just something that can be closed, as far as this module cares. */
function page() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  _resetBrowserSessionsForTests();
});

describe("browser sessions", () => {
  it("closes exactly the run's pages and leaves the owner's alone", async () => {
    const owner = page();
    const runFirst = page();
    const runSecond = page();
    const otherRun = page();
    const ownerId = openSession(owner, null, "desktop");
    openSession(runFirst, "run-abc12345", "desktop");
    openSession(runSecond, "run-abc12345", "desktop");
    openSession(otherRun, "run-zzz99999", "desktop");

    expect(await closeSessionsForRun("run-abc12345")).toBe(2);
    expect(runFirst.close).toHaveBeenCalled();
    expect(runSecond.close).toHaveBeenCalled();
    expect(owner.close).not.toHaveBeenCalled();
    expect(otherRun.close).not.toHaveBeenCalled();
    expect(getSession(ownerId)).not.toBeNull();
    expect(sessionCount()).toBe(2);
  });

  it("says nothing was closed for a run that never opened a page", async () => {
    // The normal case for a run that used browser_close itself, or never
    // touched the browser at all — an answer, not a failure.
    expect(await closeSessionsForRun("run-abc12345")).toBe(0);
  });

  it("forgets a session even when closing its page fails", async () => {
    // A page whose window is already gone must not stay in the registry, or
    // the owned Chromium is never judged idle and never closed.
    const dead = { close: vi.fn().mockRejectedValue(new Error("target closed")) };
    openSession(dead, "run-abc12345", "desktop");
    await closeSessionsForRun("run-abc12345");
    expect(sessionCount()).toBe(0);
  });

  it("sweeps only what nobody has touched, and an action is a touch", () => {
    const idle = page();
    const busy = page();
    const idleId = openSession(idle, null, "desktop");
    const busyId = openSession(busy, "run-abc12345", "desktop");
    const later = Date.now() + SESSION_TIMEOUT_MS + 1;
    touchSession(busyId);
    // `busy` was touched at "now"; only the clock has moved past the timeout
    // for the one nothing has done anything with.
    vi.spyOn(Date, "now").mockReturnValue(later);
    touchSession(busyId);
    vi.mocked(Date.now).mockRestore();

    expect(sweepIdle(later)).toEqual([idleId]);
    expect(idle.close).toHaveBeenCalled();
    expect(busy.close).not.toHaveBeenCalled();
    expect(getSession(busyId)).not.toBeNull();
  });

  it("counts the pages in one browser apart from the pages in the other", async () => {
    // The route closes its headless Chromium when nothing needs it any more,
    // and "nothing" is ITS pages: a tab open in the desktop window says
    // nothing about whether ours is still in use, and both are live at once
    // whenever the owner's switch moves between two sessions.
    openSession(page(), null, "desktop");
    const mine = openSession(page(), "run-abc12345", "headless");
    expect(sessionCount()).toBe(2);
    expect(sessionCount("headless")).toBe(1);
    expect(sessionCount("desktop")).toBe(1);

    await closeSession(mine);
    expect(sessionCount("headless")).toBe(0);
    expect(sessionCount("desktop")).toBe(1);
  });

  it("remembers which browser a page is in, so the answer can say", () => {
    // A run that asked for the owner's screen and was given the headless one
    // has no other way to find out.
    const desktop = openSession(page(), "run-abc12345", "desktop");
    const headless = openSession(page(), "run-abc12345", "headless");
    expect(getSession(desktop)?.browser).toBe("desktop");
    expect(getSession(headless)?.browser).toBe("headless");
  });

  it("hands out an id per page and takes it back on close", async () => {
    const first = openSession(page(), null, "desktop");
    const second = openSession(page(), null, "desktop");
    expect(first).not.toBe(second);
    expect(await closeSession(first)).toBe(true);
    // Idempotent: closing a session that is gone is the state the caller wanted.
    expect(await closeSession(first)).toBe(false);
    expect(getSession(first)).toBeNull();
    expect(sessionCount()).toBe(1);
  });
});
