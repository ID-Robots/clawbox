import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  WhatsappPairingManager,
  REAP_AFTER_MS,
  RESTART_DELAY_MS,
  RESTART_DELAY_MAX_MS,
  TICK_MS,
  type BridgeProcessHandle,
  type PairingDeps,
} from "@/lib/whatsapp-pairing";

/** A bridge process we can drive line by line. */
class FakeBridge implements BridgeProcessHandle {
  lineCb: ((line: string) => void) | null = null;
  exitCb: ((code: number | null) => void) | null = null;
  killed = false;
  exited = false;

  onLine(cb: (line: string) => void) {
    this.lineCb = cb;
  }
  onExit(cb: (code: number | null) => void) {
    this.exitCb = cb;
  }
  kill() {
    this.killed = true;
  }

  /** Emit raw stdout (callers include their own newlines). */
  write(chunk: string) {
    this.lineCb?.(chunk);
  }
  emit(event: Record<string, unknown>) {
    this.write(JSON.stringify({ ts: 1, ...event }) + "\n");
  }
  exit(code: number | null = 1) {
    this.exited = true;
    this.exitCb?.(code);
  }
}

interface Harness {
  manager: WhatsappPairingManager;
  deps: PairingDeps;
  bridges: FakeBridge[];
  latest(): FakeBridge;
  advance(ms: number): void;
  /** Make the next credsExist() hang. Returns the release. */
  gateCreds(): () => void;
  /** Bridges still holding a socket: spawned, not killed, not exited. */
  live(): FakeBridge[];
  state: {
    installed: boolean;
    scriptExists: boolean;
    creds: boolean;
    cleared: number;
    installs: number;
    enabled: number;
    installFails: boolean;
  };
}

function makeHarness(overrides: Partial<Harness["state"]> = {}): Harness {
  let clock = 1_000_000;
  const bridges: FakeBridge[] = [];
  // A latch on credsExist(), which is the first await inside launch() and
  // therefore the window a DELETE has to land in.
  let credsGate: Promise<void> | null = null;
  const state = {
    installed: true,
    scriptExists: true,
    creds: false,
    cleared: 0,
    installs: 0,
    enabled: 0,
    installFails: false,
    ...overrides,
  };

  const deps: PairingDeps = {
    bridgeDir: () => "/bridge",
    sessionDir: () => "/session",
    bridgeInstalled: async () => state.installed,
    bridgeScriptExists: async () => state.scriptExists,
    async install() {
      state.installs += 1;
      if (state.installFails) throw new Error("install_failed");
      state.installed = true;
    },
    async credsExist() {
      if (credsGate) await credsGate;
      return state.creds;
    },
    async clearSession() {
      state.cleared += 1;
    },
    async markEnabled() {
      state.enabled += 1;
    },
    spawnBridge() {
      const b = new FakeBridge();
      bridges.push(b);
      return b;
    },
    now: () => clock,
  };

  return {
    manager: new WhatsappPairingManager(deps),
    deps,
    bridges,
    latest: () => bridges[bridges.length - 1],
    advance: (ms: number) => {
      clock += ms;
    },
    gateCreds: () => {
      let release!: () => void;
      credsGate = new Promise<void>((r) => {
        release = () => {
          credsGate = null;
          r();
        };
      });
      return release;
    },
    live: () => bridges.filter((b) => !b.killed && !b.exited),
    state,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WhatsappPairingManager — startup", () => {
  it("starts idle", () => {
    const h = makeHarness();
    expect(h.manager.peek().phase).toBe("idle");
    expect(h.manager.peek().qr).toBeNull();
  });

  it("spawns the bridge and waits for a QR", async () => {
    const h = makeHarness();
    const snap = await h.manager.start();
    expect(snap.phase).toBe("starting");
    expect(h.bridges).toHaveLength(1);
  });

  it("reports bridge_missing rather than pretending to pair", async () => {
    const h = makeHarness({ scriptExists: false });
    const snap = await h.manager.start();
    expect(snap.phase).toBe("error");
    expect(snap.error).toBe("bridge_missing");
    expect(h.bridges).toHaveLength(0);
  });

  it("installs the bridge dependencies when they are absent", async () => {
    const h = makeHarness({ installed: false });
    await h.manager.start();
    expect(h.state.installs).toBe(1);
    expect(h.bridges).toHaveLength(1);
  });

  it("skips the install when node_modules already exists", async () => {
    const h = makeHarness({ installed: true });
    await h.manager.start();
    expect(h.state.installs).toBe(0);
  });

  it("surfaces install_failed without spawning a bridge", async () => {
    const h = makeHarness({ installed: false, installFails: true });
    const snap = await h.manager.start();
    expect(snap.phase).toBe("error");
    expect(snap.error).toBe("install_failed");
    expect(h.bridges).toHaveLength(0);
  });

  it("is idempotent — a second start does not spawn a second bridge", async () => {
    const h = makeHarness();
    await h.manager.start();
    await h.manager.start();
    expect(h.bridges).toHaveLength(1);
  });

  it("clears an unpaired session directory so the next QR is fresh", async () => {
    const h = makeHarness({ creds: false });
    await h.manager.start();
    expect(h.state.cleared).toBe(1);
  });

  it("never clears a session that already holds creds.json unless forced", async () => {
    const h = makeHarness({ creds: true });
    await h.manager.start();
    expect(h.state.cleared).toBe(0);
  });

  it("force re-pair wipes the existing credentials first", async () => {
    const h = makeHarness({ creds: true });
    await h.manager.start({ force: true });
    expect(h.state.cleared).toBe(1);
  });
});

describe("WhatsappPairingManager — QR rotation", () => {
  it("exposes the raw Baileys payload, not rendered art", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.latest().emit({ event: "qr", qr: "2@AAA,BBB,CCC,DDD,1" });

    const snap = h.manager.peek();
    expect(snap.phase).toBe("waiting");
    expect(snap.qr).toBe("2@AAA,BBB,CCC,DDD,1");
    expect(snap.qrCount).toBe(1);
  });

  it("replaces the payload on every refresh and counts the rotation", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.latest().emit({ event: "qr", qr: "2@FIRST" });
    h.advance(30_000);
    h.latest().emit({ event: "qr", qr: "2@SECOND" });
    h.advance(30_000);
    h.latest().emit({ event: "qr", qr: "2@THIRD" });

    const snap = h.manager.peek();
    expect(snap.qr).toBe("2@THIRD");
    expect(snap.qrCount).toBe(3);
  });

  it("drops a payload whose socket closed, so no dead QR stays on screen", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.latest().emit({ event: "qr", qr: "2@STALE" });
    h.latest().emit({ event: "disconnected", reason: 408 });

    const snap = h.manager.peek();
    expect(snap.phase).toBe("starting");
    expect(snap.qr).toBeNull();
  });

  it("handles a payload split across two stdout chunks", async () => {
    const h = makeHarness();
    await h.manager.start();
    const line = JSON.stringify({ ts: 1, event: "qr", qr: "2@SPLIT" }) + "\n";
    h.latest().write(line.slice(0, 12));
    expect(h.manager.peek().qr).toBeNull();
    h.latest().write(line.slice(12));
    expect(h.manager.peek().qr).toBe("2@SPLIT");
  });

  it("ignores the plain-text lines the bridge's reconnect logger writes", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.latest().write("Reconnect failed (socket hang up). Retrying in 5s...\n");
    h.latest().write("{ not json at all\n");
    h.latest().emit({ event: "qr", qr: "2@OK" });

    expect(h.manager.peek().phase).toBe("waiting");
    expect(h.manager.peek().qr).toBe("2@OK");
  });
});

describe("WhatsappPairingManager — scan and success", () => {
  it("shows 'scanned' on the 515 restart WhatsApp sends after a successful link", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.latest().emit({ event: "qr", qr: "2@AAA" });
    h.latest().emit({ event: "disconnected", reason: 515 });

    const snap = h.manager.peek();
    expect(snap.phase).toBe("scanned");
    expect(snap.qr).toBeNull();
  });

  it("pairs on the bridge's connected event and records the number", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.latest().emit({ event: "qr", qr: "2@AAA" });
    h.latest().emit({
      event: "connected",
      user: { id: "359881234567:12@s.whatsapp.net", name: "Bench Box" },
    });

    const snap = h.manager.peek();
    expect(snap.phase).toBe("paired");
    expect(snap.user).toEqual({ id: "359881234567:12@s.whatsapp.net", name: "Bench Box" });
  });

  it("writes WHATSAPP_ENABLED only after a real connected event", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.latest().emit({ event: "qr", qr: "2@AAA" });
    expect(h.state.enabled).toBe(0);

    h.latest().emit({ event: "connected", user: { id: "1@s.whatsapp.net", name: null } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.enabled).toBe(1);
  });

  it("stops the bridge once paired", async () => {
    const h = makeHarness();
    await h.manager.start();
    const bridge = h.latest();
    bridge.emit({ event: "connected", user: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.killed).toBe(true);
  });

  it("tolerates a connected event with no user object", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.latest().emit({ event: "connected" });
    expect(h.manager.peek().phase).toBe("paired");
    expect(h.manager.peek().user).toBeNull();
  });
});

describe("WhatsappPairingManager — auto-restart", () => {
  it("respawns when the bridge exits and the panel is still polling", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.poll();

    h.latest().exit(1);
    expect(h.manager.peek().phase).toBe("starting");
    expect(h.manager.peek().restarts).toBe(1);

    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    expect(h.bridges).toHaveLength(2);
  });

  it("keeps respawning indefinitely — there is no attempt ceiling", async () => {
    const h = makeHarness();
    await h.manager.start();

    for (let i = 0; i < 12; i += 1) {
      h.manager.poll();
      h.latest().emit({ event: "qr", qr: `2@ROUND${i}` });
      h.latest().exit(1);
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    }

    expect(h.bridges).toHaveLength(13);
    expect(h.manager.peek().restarts).toBe(12);
    expect(h.manager.peek().phase).not.toBe("error");
  });

  it("still serves a QR after a restart, so the owner never sees a dead panel", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.poll();
    h.latest().exit(1);
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    h.latest().emit({ event: "qr", qr: "2@AFTER_RESTART" });

    expect(h.manager.peek().phase).toBe("waiting");
    expect(h.manager.peek().qr).toBe("2@AFTER_RESTART");
  });

  it("does not respawn when nobody has polled for over a minute", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.advance(REAP_AFTER_MS + 1);

    h.latest().exit(1);
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    expect(h.bridges).toHaveLength(1);
    expect(h.manager.peek().phase).toBe("idle");
  });

  it("does not respawn after a successful pairing", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.poll();
    h.latest().emit({ event: "connected", user: null });
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS * 2);
    expect(h.bridges).toHaveLength(1);
    expect(h.manager.peek().phase).toBe("paired");
  });

  it("recovers from a logged_out error instead of stopping", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.poll();
    h.latest().emit({ event: "error", error: "logged_out", reason: 401 });
    h.latest().exit(1);
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);

    expect(h.bridges).toHaveLength(2);
  });
});

describe("WhatsappPairingManager — reaping", () => {
  it("keeps the session alive while polls are recent", async () => {
    const h = makeHarness();
    await h.manager.start();

    // Five minutes of a panel left open: poll every 2 s, never reaped.
    for (let elapsed = 0; elapsed < 300_000; elapsed += 2_000) {
      h.advance(2_000);
      h.manager.poll();
      h.manager.tick();
    }

    expect(h.manager.peek().phase).not.toBe("idle");
    expect(h.latest().killed).toBe(false);
  });

  it("reaps the bridge a minute after the last poll", async () => {
    const h = makeHarness();
    await h.manager.start();
    const bridge = h.latest();

    h.manager.poll();
    h.advance(REAP_AFTER_MS + 1);
    h.manager.tick();

    expect(h.manager.peek().phase).toBe("idle");
    expect(bridge.killed).toBe(true);
  });

  it("never reaps a paired session", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.latest().emit({ event: "connected", user: null });
    h.advance(REAP_AFTER_MS * 10);
    h.manager.tick();

    expect(h.manager.peek().phase).toBe("paired");
  });

  it("poll() renews the keepalive; peek() does not", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.advance(REAP_AFTER_MS - 1_000);
    h.manager.peek();
    h.advance(2_000);
    h.manager.tick();

    expect(h.manager.peek().phase).toBe("idle");
  });
});

describe("WhatsappPairingManager — cancel", () => {
  it("stops the bridge and returns to idle", async () => {
    const h = makeHarness();
    await h.manager.start();
    const bridge = h.latest();
    h.latest().emit({ event: "qr", qr: "2@AAA" });

    const snap = h.manager.stop();
    expect(snap.phase).toBe("idle");
    expect(snap.qr).toBeNull();
    expect(bridge.killed).toBe(true);
  });

  it("does not respawn a bridge that exits because we cancelled it", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.poll();
    h.manager.stop();
    h.bridges[0].exit(null);
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS * 2);

    expect(h.bridges).toHaveLength(1);
  });

  it("can start a fresh session after a cancel", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.stop();
    const snap = await h.manager.start();

    expect(snap.phase).toBe("starting");
    expect(h.bridges).toHaveLength(2);
  });
});

/*
 * Process lifecycle.
 *
 * The bug these cover was not a wrong snapshot, it was orphaned `node
 * bridge.js` processes: 20 interleaved start/cancel calls left three bridges
 * running, an explicit cancel killed exactly one, and the reaper never reached
 * the rest — they held Baileys websockets and wrote pre-keys into the same auth
 * directory the next attempt would use. Every case below asserts on processes,
 * not on phases.
 */
describe("WhatsappPairingManager — process lifecycle", () => {
  it("spawns exactly one bridge for simultaneous starts", async () => {
    const h = makeHarness();

    // Three POSTs in one tick. They all clear the `starting || proc` guard
    // before any of them yields, so the guard is only worth anything if the
    // flag is claimed before the first await.
    await Promise.all([h.manager.start(), h.manager.start(), h.manager.start()]);

    expect(h.bridges).toHaveLength(1);
    expect(h.live()).toHaveLength(1);
  });

  it("leaves nothing running when a cancel overtakes a start", async () => {
    const h = makeHarness();
    const release = h.gateCreds();

    const started = h.manager.start();
    await Promise.resolve();
    await Promise.resolve();
    h.manager.stop(); // the DELETE lands while launch() is still awaiting
    release();
    await started;

    expect(h.live()).toHaveLength(0);
  });

  it("leaves a consistent snapshot when a cancel overtakes a start", async () => {
    const h = makeHarness();
    const release = h.gateCreds();

    const started = h.manager.start();
    await Promise.resolve();
    await Promise.resolve();
    h.manager.stop();
    release();
    await started;

    // Not "waiting with startedAt: null" — cancelled means idle, all the way.
    const snap = h.manager.peek();
    expect(snap.phase).toBe("idle");
    expect(snap.startedAt).toBeNull();
    expect(snap.qr).toBeNull();
  });

  it("does not leave an unreapable bridge when a cancel lands mid-restart", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.poll();
    h.latest().exit(1); // schedules the respawn

    const release = h.gateCreds();
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS); // respawn starts, blocks on credsExist
    h.manager.stop(); // cancel: tears the ticker down, sees no process to kill
    release();
    await vi.advanceTimersByTimeAsync(0);

    // Let a full minute of no polling pass, and let the real interval run.
    h.advance(REAP_AFTER_MS * 10);
    await vi.advanceTimersByTimeAsync(TICK_MS * 4);

    expect(h.live()).toHaveLength(0);
  });

  it("re-arms the reaper on the restart path", async () => {
    const h = makeHarness();
    await h.manager.start();
    h.manager.poll();
    h.latest().exit(1);
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    expect(h.bridges).toHaveLength(2);

    // Panel closed. Nobody polls again. Drive the interval, not tick().
    h.advance(REAP_AFTER_MS + 1);
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);

    expect(h.live()).toHaveLength(0);
    expect(h.manager.peek().phase).toBe("idle");
  });

  it("ignores stdout from a bridge it no longer owns", async () => {
    const h = makeHarness();
    await h.manager.start();
    const orphan = h.latest();

    h.manager.stop();
    await h.manager.start(); // a fresh session with a fresh bridge

    orphan.emit({ event: "qr", qr: "2@FROM_A_DEAD_SOCKET" });
    expect(h.manager.peek().qr).toBeNull();

    // The dangerous one: `connected` from an orphan writes WHATSAPP_ENABLED.
    orphan.emit({ event: "connected", user: { id: "1@s.whatsapp.net", name: null } });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.manager.peek().phase).not.toBe("paired");
    expect(h.state.enabled).toBe(0);
  });

  it("survives interleaved start/cancel calls without accumulating bridges", async () => {
    const h = makeHarness();

    // The reviewer's "20 rapid clicks": POST, DELETE, POST, DELETE …
    for (let i = 0; i < 20; i += 1) {
      const started = h.manager.start();
      if (i % 2 === 1) h.manager.stop();
      await started;
      await vi.advanceTimersByTimeAsync(0);
    }
    h.manager.stop();
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MAX_MS);

    expect(h.live()).toHaveLength(0);
  });
});

describe("WhatsappPairingManager — failure backoff", () => {
  it("wipes a revoked session instead of relaunching over the same credentials", async () => {
    const h = makeHarness({ creds: true });
    await h.manager.start();
    expect(h.state.cleared).toBe(0); // a real pairing is never wiped by accident

    h.manager.poll();
    h.latest().emit({ event: "error", error: "logged_out", reason: 401 });
    h.latest().exit(1);
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);

    // Without this the respawn re-presents the revoked creds.json and earns the
    // same 401, every two seconds, forever.
    expect(h.state.cleared).toBe(1);
    expect(h.bridges).toHaveLength(2);
  });

  it("backs off a bridge that never gets as far as a QR", async () => {
    const h = makeHarness();
    await h.manager.start();

    // 20 rounds of two seconds, with the bridge dying before it emits anything.
    for (let i = 0; i < 20; i += 1) {
      h.manager.poll();
      h.latest().exit(1);
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    }

    // Flat 2 s retries spawned 21 node processes over this window on a Jetson.
    expect(h.bridges.length).toBeLessThanOrEqual(8);
    expect(h.bridges.length).toBeGreaterThan(1);
  });

  it("still has no attempt ceiling once it has backed off", async () => {
    const h = makeHarness();
    await h.manager.start();
    for (let i = 0; i < 20; i += 1) {
      h.manager.poll();
      h.latest().exit(1);
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    }

    const before = h.bridges.length;
    h.manager.poll();
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MAX_MS * 2);

    expect(h.bridges.length).toBeGreaterThan(before);
    expect(h.manager.peek().phase).not.toBe("error");
  });

  it("resets the backoff as soon as a QR appears", async () => {
    const h = makeHarness();
    await h.manager.start();

    // Two failures, then a round that reaches a QR.
    for (let i = 0; i < 2; i += 1) {
      h.manager.poll();
      h.latest().exit(1);
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MAX_MS);
    }
    h.manager.poll();
    h.latest().emit({ event: "qr", qr: "2@PROGRESS" });
    h.latest().exit(1);

    // Back to the fast delay, because the last bridge demonstrably worked.
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    expect(h.manager.peek().phase).toBe("starting");
    expect(h.bridges).toHaveLength(4);
  });

  it("stamps startedAt on every non-idle snapshot", async () => {
    const h = makeHarness();
    await h.manager.start();
    expect(h.manager.peek().startedAt).not.toBeNull();

    h.manager.poll();
    h.latest().exit(1);
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
    h.latest().emit({ event: "qr", qr: "2@AFTER" });

    const snap = h.manager.peek();
    expect(snap.phase).toBe("waiting");
    expect(snap.startedAt).not.toBeNull();
  });
});
