import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The boot hook starts the PTY server that backs the Terminal app.
 *
 * It used to start it with `npx tsx scripts/terminal-server.ts`. `tsx` is not a
 * dependency of this project — it only ever resolved because a box had once
 * been online and npm had left a copy in ~/.npm/_npx. On a freshly flashed box
 * whose first boot is AP mode with no internet, `npx` cannot fetch it: the
 * child died immediately and the exit handler re-spawned it every 2 s, for
 * ever, with no backoff and no cap.
 *
 * Four separate things are pinned here:
 *   1. the child is this same Node — `process.execPath` running a plain .mjs
 *      out of the checkout — so there is nothing to resolve, download or
 *      transpile at boot;
 *   2. a child that keeps dying backs off instead of fork-storming, and one
 *      that could never be spawned at all is still retried;
 *   3. a missing server file is named rather than looped on;
 *   4. the "already running?" probe accepts only our own server.
 */

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const REPO_ROOT = process.cwd();
const BANNER = "ClawBox Terminal WebSocket Server";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
  pid: number | undefined;
};

function fakeChild(pid: number | undefined): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = pid;
  return child;
}

describe("startTerminalServer", () => {
  let startTerminalServer: () => void;
  let spawnMock: ReturnType<typeof vi.fn>;
  let logged: string[];

  /** Let the ":3006 already listening?" probe settle and the child boot. */
  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
  }

  function childFromCall(index: number): FakeChild {
    return spawnMock.mock.results[index].value as FakeChild;
  }

  /**
   * End a child the way Node really does — 'exit' and then 'close'. Both,
   * deliberately: a supervisor listening to each of them would restart twice
   * per death, so the counts below are also what pins that it does not.
   */
  function die(child: FakeChild, code: number) {
    child.emit("exit", code);
    child.emit("close", code);
  }

  /** Load the boot hook with `root` as the box's project directory. */
  async function loadWithRoot(root: string) {
    vi.resetModules();
    vi.stubEnv("CLAWBOX_ROOT", root);
    const childProcess = await import("child_process");
    spawnMock = vi.mocked(childProcess.spawn) as unknown as ReturnType<typeof vi.fn>;
    let pid = 1000;
    spawnMock.mockImplementation(() => fakeChild(pid++));
    ({ startTerminalServer } = await import("@/instrumentation-node"));
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    // Nothing is listening on :3006 — the boot hook must start its own child.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
    await loadWithRoot(REPO_ROOT);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("runs the PTY server with this Node, not with npx/tsx", async () => {
    startTerminalServer();
    await settle();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    // The checkout's copy, not the build output's: in production the cwd is
    // .next/standalone, whose scripts/ only refreshes on a full rebuild.
    expect(args).toEqual([path.join(REPO_ROOT, "scripts", "terminal-server.mjs")]);
    // No package manager and no transpiler anywhere in the command line: those
    // are the parts that need a network on a box that has none.
    expect([command, ...args].join(" ")).not.toMatch(/\bnpx\b|\btsx\b/);
  });

  it("ships the file it starts", () => {
    // The child is `node scripts/terminal-server.mjs`; a .ts file would need a
    // transpiler again, which is the whole defect.
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "terminal-server.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts", "terminal-server.ts"))).toBe(false);
  });

  it("backs off when the child keeps dying instead of re-spawning every 2 s", async () => {
    startTerminalServer();
    await settle();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // First death: restart at the usual 2 s.
    die(childFromCall(0), 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Second death: 2 s must no longer be enough.
    die(childFromCall(1), 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spawnMock, "second restart still fires at 2 s — no backoff").toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // Third death: slower again, and it does still come back.
    die(childFromCall(2), 1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(spawnMock, "third restart still fires at 4 s — backoff is not growing").toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(spawnMock).toHaveBeenCalledTimes(4);
  });

  it("returns to the fast restart after the child has run for a while", async () => {
    startTerminalServer();
    await settle();

    die(childFromCall(0), 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // A child that stayed up is not a crash loop: the next death restarts fast.
    await vi.advanceTimersByTimeAsync(120_000);
    die(childFromCall(1), 0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  /**
   * A hot reload SIGTERMs the tracked child and then probes :3006. The child it
   * just signalled has not finished dying and still answers our own banner — so
   * believing the probe left the new generation with no child at all, while the
   * dying one's `close` was discarded as stale. The Terminal stayed dead until
   * the next reload.
   */
  it("does not mistake the child it just killed for a server already running", async () => {
    startTerminalServer();
    await settle();
    const first = childFromCall(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // The reload. Our own dying child answers the banner.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      text: () => Promise.resolve(BANNER),
    })));
    startTerminalServer();
    await settle();

    // It goes, as asked — its close belongs to the previous generation.
    die(first, 0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(spawnMock, "the hot reload left no terminal server running").toHaveBeenCalledTimes(2);
  });

  it("starts a replacement even if the child it killed never closes", async () => {
    startTerminalServer();
    await settle();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      text: () => Promise.resolve(BANNER),
    })));
    startTerminalServer();
    // The old child ignores SIGTERM and never emits 'close'.
    await vi.advanceTimersByTimeAsync(5000);

    expect(spawnMock, "a child that would not die stranded the Terminal").toHaveBeenCalledTimes(2);
  });

  /**
   * And a THIRD reload landing inside that wait. If the replacement disowns the
   * dying child, this call sees none and falls back to the probe — which the
   * same dying child answers — while the previous generation's wait is now
   * stale. Ownership has to outlive the SIGTERM, not the call.
   */
  it("keeps a reload during the grace period from being answered by the dying child", async () => {
    startTerminalServer();
    await settle();
    const first = childFromCall(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      text: () => Promise.resolve(BANNER),
    })));
    startTerminalServer();
    await settle();
    // A third reload, while the first child is still on its way out.
    startTerminalServer();
    await settle();

    die(first, 0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(spawnMock, "the newest reload started nothing").toHaveBeenCalledTimes(2);
  });

  it("retries a child that could not be spawned at all", async () => {
    startTerminalServer();
    await settle();

    // fork(2) answering EAGAIN under boot memory pressure: node emits 'error'
    // and 'close' and never 'exit', so an exit-only handler gave up for ever.
    const child = childFromCall(0);
    child.pid = undefined;
    child.emit("error", new Error("spawn EAGAIN"));
    child.emit("close", null);
    await vi.advanceTimersByTimeAsync(2000);

    expect(spawnMock, "a child that never started is never retried").toHaveBeenCalledTimes(2);
  });

  it("names the missing server file instead of looping on it, and heals when it returns", async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-no-scripts-"));
    try {
      await loadWithRoot(emptyRoot);
      startTerminalServer();
      await settle();

      expect(spawnMock).not.toHaveBeenCalled();
      expect(logged.join("\n")).toContain(path.join(emptyRoot, "scripts", "terminal-server.mjs"));
      await vi.advanceTimersByTimeAsync(59_000);
      expect(spawnMock, "a missing file must not be retried at the 2 s cadence").not.toHaveBeenCalled();

      // An update that lands the file mid-flight is picked up on the next look.
      fs.mkdirSync(path.join(emptyRoot, "scripts"));
      fs.writeFileSync(path.join(emptyRoot, "scripts", "terminal-server.mjs"), "");
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("leaves a terminal server that is already listening alone", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, text: async () => `${BANNER}\n` })));
    startTerminalServer();
    await settle();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(logged.join("\n")).toMatch(/already running/);
  });

  it("does not mistake another process on :3006 for the terminal server", async () => {
    // The port is loopback-only, but a leftover from a half-killed process tree
    // answering 200 used to be accepted as our PTY server — and the Terminal
    // app then talked to it.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, text: async () => "<html>nginx</html>" })));
    startTerminalServer();
    await settle();

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("probes for the banner the server actually answers", () => {
    // The string lives in both files and they have to agree, so pin them here
    // rather than discovering the drift as a terminal that never starts.
    const server = fs.readFileSync(path.join(REPO_ROOT, "scripts", "terminal-server.mjs"), "utf8");
    const hook = fs.readFileSync(path.join(REPO_ROOT, "src", "instrumentation-node.ts"), "utf8");
    expect(server).toContain(BANNER);
    expect(hook).toContain(BANNER);
  });
});
