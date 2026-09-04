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
    const ownerId = openSession(owner, null);
    openSession(runFirst, "run-abc12345");
    openSession(runSecond, "run-abc12345");
    openSession(otherRun, "run-zzz99999");

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
    openSession(dead, "run-abc12345");
    await closeSessionsForRun("run-abc12345");
    expect(sessionCount()).toBe(0);
  });

  it("sweeps only what nobody has touched, and an action is a touch", () => {
    const idle = page();
    const busy = page();
    const idleId = openSession(idle, null);
    const busyId = openSession(busy, "run-abc12345");
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

  it("hands out an id per page and takes it back on close", async () => {
    const first = openSession(page(), null);
    const second = openSession(page(), null);
    expect(first).not.toBe(second);
    expect(await closeSession(first)).toBe(true);
    // Idempotent: closing a session that is gone is the state the caller wanted.
    expect(await closeSession(first)).toBe(false);
    expect(getSession(first)).toBeNull();
    expect(sessionCount()).toBe(1);
  });
});
