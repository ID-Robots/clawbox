import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, signSessionCookie, type SessionFixture } from "../helpers/session";
import { sessionLease, type SessionLease } from "@/lib/session-lease";
import {
  ENDED_TURN_RETENTION_MS,
  SESSION_RECHECK_MS,
  beginLiveTurn,
  liveTurnResponse,
  resetLiveTurns,
} from "@/lib/harness/hermes-live-turn";
import { SESSION_EXPIRED_CHAT_MESSAGE, SESSION_EXPIRED_STREAM_CODE } from "@/lib/session-expiry";

// SUP-1017 (TASK-2131): a session that ran out while the browser was being
// answered. The session gate judges a request once, when it arrives, and a
// Hermes turn then answers over the same response for minutes — so a browser
// whose session expired halfway through kept being handed the answer as if
// nobody had signed out. The lease is what the admitting cookie says about how
// long that may go on, and the live-turn stream ends with it.

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

function request(cookie?: string): Request {
  return new Request("http://clawbox.local/setup-api/hermes/chat", { headers: cookie ? { cookie } : {} });
}

describe("sessionLease", () => {
  let fixture: SessionFixture;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    fixture = installSessionFixture();
  });

  afterEach(() => {
    fixture.cleanup();
    vi.useRealTimers();
  });

  const writeConfig = (extra: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(fixture.root, "data", "config.json"),
      JSON.stringify({ password_configured: true, setup_complete: true, session_generation: 0, ...extra }),
    );

  it("is the admitting cookie's own expiry, and the box still admits it now", () => {
    const lease = sessionLease(request(`clawbox_session=${signSessionCookie({ expiresInSeconds: 1200 })}`));
    expect(lease).not.toBeNull();
    expect(lease!.expiresAt).toBe(T0 + 1_200_000);
    expect(lease!.stillValid()).toBe(true);
  });

  it("stops being valid once the cookie has run out", () => {
    const lease = sessionLease(request(`clawbox_session=${signSessionCookie({ expiresInSeconds: 60 })}`))!;
    vi.setSystemTime(T0 + 59_000);
    expect(lease.stillValid()).toBe(true);
    vi.setSystemTime(T0 + 60_000);
    expect(lease.stillValid()).toBe(false);
  });

  it("stops being valid the moment a password change revokes the cookie", () => {
    const lease = sessionLease(request(fixture.cookie))!;
    expect(lease.stillValid()).toBe(true);
    writeConfig({ session_generation: 1 });
    expect(lease.stillValid()).toBe(false);
  });

  it("is null for a request with no session cookie at all — the agent's bearer, the test harness", () => {
    expect(sessionLease(request())).toBeNull();
    expect(sessionLease(new Request("http://clawbox.local/x", { headers: { authorization: "Bearer mcp-token" } }))).toBeNull();
    expect(sessionLease(undefined)).toBeNull();
  });

  it("has already ended for a cookie the box no longer admits — it ran out or was revoked after the gate let it in", () => {
    // Null here would hand that request the unbounded stream the lease exists to end.
    for (const cookie of [
      signSessionCookie({ expiresInSeconds: -1 }),
      signSessionCookie({ gen: 7 }),
      signSessionCookie({ secret: "another-secret-0123456789abcdef0123" }),
    ]) {
      const lease = sessionLease(request(`clawbox_session=${cookie}`));
      expect(lease).not.toBeNull();
      expect(lease!.stillValid()).toBe(false);
      expect(lease!.expiresAt).toBeLessThanOrEqual(T0);
    }
  });

  it("stays null for a rejected cookie where the box judges no sessions: the e2e-install harness's test mode", () => {
    const saved = process.env.CLAWBOX_TEST_MODE;
    process.env.CLAWBOX_TEST_MODE = "1";
    try {
      expect(sessionLease(request(`clawbox_session=${signSessionCookie({ expiresInSeconds: -1 })}`))).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.CLAWBOX_TEST_MODE;
      else process.env.CLAWBOX_TEST_MODE = saved;
    }
  });
});

/** Everything a stream has said, as [event, data] pairs, read to its end. */
async function framesOf(res: Response): Promise<Array<[string, Record<string, unknown>]>> {
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const frame of (await res.text()).split("\n\n")) {
    if (!frame.trim()) continue;
    const name = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
    const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "{}";
    out.push([name, JSON.parse(data) as Record<string, unknown>]);
  }
  return out;
}

/** A lease the test controls: valid until `revoke()`, expiring at `expiresAt`. */
function testLease(expiresAt: number) {
  let revoked = false;
  const lease: SessionLease = {
    expiresAt,
    stillValid: () => !revoked && Date.now() < expiresAt,
  };
  return { lease, revoke: () => { revoked = true; } };
}

const SESSION_ENDED: [string, Record<string, unknown>] = ["error", { error: SESSION_EXPIRED_CHAT_MESSAGE, code: SESSION_EXPIRED_STREAM_CODE }];

describe("a live turn's stream, bounded by the session it was admitted on", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(T0);
    resetLiveTurns();
  });

  afterEach(() => {
    resetLiveTurns();
    vi.useRealTimers();
  });

  it("ends at the session's expiry with a frame that says why, and the turn goes on for everyone else", async () => {
    const live = beginLiveTurn("desktop");
    const { lease } = testLease(T0 + 20 * 60_000);
    const signedOut = liveTurnResponse((listener) => live.attach(listener), { lease });
    // A second page on a session with no end (the agent's bearer) follows the same turn.
    const unbounded = liveTurnResponse((listener) => live.attach(listener));

    live.emit("delta", { text: "The first half, " });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    live.emit("delta", { text: "and the rest." });
    live.emit("done", { text: "The first half, and the rest." });
    live.end();

    expect(await framesOf(signedOut)).toEqual([["delta", { text: "The first half, " }], SESSION_ENDED]);
    // Only the stream ended: the turn was not stopped, and finished for the other listener.
    expect(live.signal.aborted).toBe(false);
    expect((await framesOf(unbounded)).map(([name]) => name)).toEqual(["delta", "delta", "done"]);
  });

  it("ends within one recheck of a revocation — a password change, a removed user", async () => {
    const live = beginLiveTurn("desktop");
    const { lease, revoke } = testLease(T0 + 24 * 3_600_000);
    const res = liveTurnResponse((listener) => live.attach(listener), { lease });
    live.emit("delta", { text: "Thinking…" });
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
    revoke();
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
    live.emit("delta", { text: "never seen" });
    expect(await framesOf(res)).toEqual([["delta", { text: "Thinking…" }], SESSION_ENDED]);
    expect(live.signal.aborted).toBe(false);
  });

  it("re-arms rather than ending when the box still admits the cookie at its expiry (a clock that runs ahead)", async () => {
    const live = beginLiveTurn("desktop");
    let valid = true;
    const res = liveTurnResponse((listener) => live.attach(listener), {
      lease: { expiresAt: T0 + 5_000, stillValid: () => valid },
      recheckMs: 3_600_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    live.emit("delta", { text: "still yours" });
    valid = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await framesOf(res)).toEqual([["delta", { text: "still yours" }], SESSION_ENDED]);
  });

  it("ends at once for a session that ran out between the gate and the stream", async () => {
    const live = beginLiveTurn("desktop");
    const res = liveTurnResponse((listener) => live.attach(listener), {
      lease: { expiresAt: T0 - 1, stillValid: () => false },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await framesOf(res)).toEqual([SESSION_ENDED]);
  });

  it("follows the turn to its end, as before, when no session bounds it", async () => {
    const live = beginLiveTurn("desktop");
    const res = liveTurnResponse((listener) => live.attach(listener), { lease: null });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(48 * 3_600_000);
    live.emit("done", { text: "ok" });
    live.end();
    expect((await framesOf(res)).map(([name]) => name)).toEqual(["done"]);
  });

  it("leaves no timer behind once the turn ends, or the browser goes away first", async () => {
    const live = beginLiveTurn("desktop");
    const { lease } = testLease(T0 + 60_000);
    const ended = liveTurnResponse((listener) => live.attach(listener), { lease });
    const left = liveTurnResponse((listener) => live.attach(listener), { lease });
    expect(vi.getTimerCount()).toBe(4);
    await left.body!.cancel();
    expect(vi.getTimerCount()).toBe(2);
    live.emit("done", { text: "ok" });
    live.end();
    await framesOf(ended);
    // What is left is the turn's own: how long an ended turn is kept for a late re-attach.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(ENDED_TURN_RETENTION_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is never armed for a turn that had already ended when the page attached", async () => {
    const live = beginLiveTurn("desktop");
    live.emit("done", { text: "ok" });
    live.end();
    const before = vi.getTimerCount();
    const { lease } = testLease(T0 + 60_000);
    const res = liveTurnResponse((listener) => live.attach(listener), { lease });
    expect((await framesOf(res)).map(([name]) => name)).toEqual(["done"]);
    expect(vi.getTimerCount()).toBe(before);
  });
});
