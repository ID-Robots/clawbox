import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import { SESSION_EXPIRED_CLOSE_CODE } from "@/lib/session-expiry";

// scripts/upgrade-session-watch.js: every socket production-server.js admitted
// is closed when the session it was admitted on would no longer be accepted —
// at the cookie's expiry, or on a revocation the periodic re-check sees.

const requireCjs = createRequire(import.meta.url);
const watchModule = requireCjs("../../../scripts/upgrade-session-watch.js") as {
  SESSION_EXPIRED_CLOSE_CODE: number;
  SESSION_EXPIRED_CLOSE_REASON: string;
  DEFAULT_RECHECK_MS: number;
  recheckMsFromEnv(value: unknown, fallback?: number): number;
  createUpgradeSessionWatch(opts: {
    verify: (cookieHeader: string | undefined) => { exp: number } | null;
    recheckMs?: number;
    now?: () => number;
  }): { watch(cookieHeader: string | undefined, session: { exp: number } | null, close: () => void): () => void; size(): number };
};

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

/** A stand-in for the cookie check: valid until `exp`, unless revoked. */
function fakeSessions() {
  const revoked = new Set<string>();
  const exps = new Map<string, number>();
  return {
    revoked,
    issue(name: string, expInSeconds: number) {
      const exp = Math.floor(Date.now() / 1000) + expInSeconds;
      exps.set(name, exp);
      return { cookie: `clawbox_session=${name}`, session: { exp } };
    },
    verify: (cookieHeader: string | undefined) => {
      const name = (cookieHeader ?? "").replace("clawbox_session=", "");
      const exp = exps.get(name);
      if (exp === undefined || revoked.has(name)) return null;
      return exp > Math.floor(Date.now() / 1000) ? { exp } : null;
    },
  };
}

describe("createUpgradeSessionWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes a socket at the moment its session expires, not before", () => {
    const sessions = fakeSessions();
    const watch = watchModule.createUpgradeSessionWatch({ verify: sessions.verify, recheckMs: 60_000 });
    const close = vi.fn();
    const { cookie, session } = sessions.issue("a", 20 * 60);
    watch.watch(cookie, session, close);

    vi.advanceTimersByTime(20 * 60 * 1000 - 1);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(watch.size()).toBe(0);
  });

  it("closes a socket whose session is revoked within one re-check", () => {
    const sessions = fakeSessions();
    const watch = watchModule.createUpgradeSessionWatch({ verify: sessions.verify, recheckMs: 5_000 });
    const close = vi.fn();
    const { cookie, session } = sessions.issue("a", 24 * 3600);
    watch.watch(cookie, session, close);

    vi.advanceTimersByTime(12_000);
    expect(close).not.toHaveBeenCalled();
    sessions.revoked.add("a");
    vi.advanceTimersByTime(5_000);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes only the sockets whose session ended", () => {
    const sessions = fakeSessions();
    const watch = watchModule.createUpgradeSessionWatch({ verify: sessions.verify, recheckMs: 1_000 });
    const short = vi.fn();
    const long = vi.fn();
    const a = sessions.issue("short", 60);
    const b = sessions.issue("long", 3600);
    watch.watch(a.cookie, a.session, short);
    watch.watch(b.cookie, b.session, long);

    vi.advanceTimersByTime(61_000);
    expect(short).toHaveBeenCalledTimes(1);
    expect(long).not.toHaveBeenCalled();
    expect(watch.size()).toBe(1);
  });

  it("stops watching a socket that closed on its own", () => {
    const sessions = fakeSessions();
    const watch = watchModule.createUpgradeSessionWatch({ verify: sessions.verify, recheckMs: 1_000 });
    const close = vi.fn();
    const { cookie, session } = sessions.issue("a", 60);
    const unwatch = watch.watch(cookie, session, close);
    unwatch();
    vi.advanceTimersByTime(120_000);
    expect(close).not.toHaveBeenCalled();
    expect(watch.size()).toBe(0);
    // Nothing left to judge: the re-check interval is gone too.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes each socket once, however many checks see it ended", () => {
    const sessions = fakeSessions();
    const watch = watchModule.createUpgradeSessionWatch({ verify: sessions.verify, recheckMs: 100 });
    const close = vi.fn();
    const { cookie, session } = sessions.issue("a", 1);
    watch.watch(cookie, session, close);
    vi.advanceTimersByTime(10_000);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the check throws, and survives a close that throws", () => {
    const watch = watchModule.createUpgradeSessionWatch({
      verify: () => {
        throw new Error("config.json unreadable");
      },
      recheckMs: 1_000,
    });
    const close = vi.fn(() => {
      throw new Error("socket already gone");
    });
    watch.watch("clawbox_session=x", { exp: Math.floor(Date.now() / 1000) + 3600 }, close);
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("re-arms rather than closing when the expiry timer fires on a clock that is behind", () => {
    let skew = 0;
    const exp = Math.floor(T0 / 1000) + 30;
    const watch = watchModule.createUpgradeSessionWatch({
      // The check reads a clock half a second behind the timer's.
      verify: () => (exp > Math.floor((Date.now() - skew) / 1000) ? { exp } : null),
      recheckMs: 60_000,
    });
    const close = vi.fn();
    skew = 500;
    watch.watch("clawbox_session=a", { exp }, close);
    vi.advanceTimersByTime(30_000);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("the session-expired close code", () => {
  it("is the one the browser reads as signed out", () => {
    expect(watchModule.SESSION_EXPIRED_CLOSE_CODE).toBe(SESSION_EXPIRED_CLOSE_CODE);
  });

  it("is an application code a browser accepts in a close frame", () => {
    expect(watchModule.SESSION_EXPIRED_CLOSE_CODE).toBeGreaterThanOrEqual(4000);
    expect(watchModule.SESSION_EXPIRED_CLOSE_CODE).toBeLessThanOrEqual(4999);
    expect(Buffer.byteLength(watchModule.SESSION_EXPIRED_CLOSE_REASON)).toBeLessThanOrEqual(123);
  });
});

describe("recheckMsFromEnv", () => {
  it("takes a positive integer and falls back on anything else", () => {
    expect(watchModule.recheckMsFromEnv("250")).toBe(250);
    for (const bad of [undefined, "", "0", "-5", "1.5", "soon"]) {
      expect(watchModule.recheckMsFromEnv(bad)).toBe(watchModule.DEFAULT_RECHECK_MS);
    }
  });
});
