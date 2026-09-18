import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * A plugin the owner installs after boot has to reach the chat by itself.
 *
 * WHAT THE MECHANISM IS, because it is the thing most easily got wrong here.
 * Hermes has no runtime plugin reload — its own `plugins install` ends with
 * "Restart the gateway for the plugin to take effect" — so the only way a
 * running process sees a new plugin is a restart of that process. On this SKU
 * the process serving chat is `clawbox-hermes-dashboard.service`, and ClawBox
 * ALREADY has the restart for it: `bounceHermesDashboard()`, which stops the
 * dashboard as the clawbox user that owns it and lets the unit's
 * `Restart=always` bring it back, then waits for a NEW main PID and for :9119 to
 * answer before it says "restarted".
 *
 * It needs no root and it must not get any. A `systemctl restart` grant over
 * this unit would also START it, which is exactly how an OpenClaw box could
 * resurrect the dashboard its foreign-edition teardown had just stopped and
 * disabled — the invariant `sudoers-coverage.test.ts` and
 * `install-foreign-edition-teardown.test.ts` both own.
 *
 * So what is new here is not a way to restart. It is knowing WHEN to, doing it
 * once per burst, and telling the owner — whose open chat window the restart
 * drops, deliberately.
 */

const bounceMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const declarationMock = vi.hoisted(() => vi.fn());
const stateMock = vi.hoisted(() => vi.fn());
const servingMock = vi.hoisted(() => vi.fn());
const unitStateMock = vi.hoisted(() => vi.fn());
const mainPidMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-control", () => ({
  bounceHermesDashboard: bounceMock,
  hermesDashboardServing: servingMock,
  hermesDashboardUnitState: unitStateMock,
  hermesDashboardMainPid: mainPidMock,
}));
vi.mock("@/lib/email-notify", () => ({ notifyOwner: notifyMock }));
vi.mock("@/lib/hermes-plugin-set", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-plugin-set")>()),
  readHermesPluginDeclaration: declarationMock,
  readHermesPluginState: stateMock,
}));

import {
  HERMES_PLUGIN_DEBOUNCE_MS,
  _resetHermesPluginReloadStateForTests,
  bounceHermesDashboardShared,
  createHermesPluginWatcher,
  reloadHermesPlugins,
} from "@/lib/hermes-plugin-reload";

/** A declaration, as the watcher reads it. */
function declared(names: string[]) {
  return { names, enabled: names, signature: `sig:${names.join(",")}`, changedAt: 1_000 };
}

let restoreEnv: () => void;

beforeEach(() => {
  bounceMock.mockReset();
  notifyMock.mockReset();
  declarationMock.mockReset();
  stateMock.mockReset();
  servingMock.mockReset();
  unitStateMock.mockReset();
  mainPidMock.mockReset();
  // A replacement by default: a different pid every read, so a test that says
  // nothing about pids gets the ordinary "systemd started a new process".
  let nextPid = 1000;
  mainPidMock.mockImplementation(async () => ({ read: true, pid: (nextPid += 1) }));
  bounceMock.mockResolvedValue("restarted");
  notifyMock.mockResolvedValue(undefined);
  servingMock.mockResolvedValue(true);
  unitStateMock.mockResolvedValue("running");
  declarationMock.mockResolvedValue(declared(["superpowers"]));
  stateMock.mockResolvedValue({
    declared: ["superpowers"],
    loaded: ["superpowers"],
    stale: false,
    changedAfterStart: false,
    dashboardStartedAt: 1,
    signature: "sig:superpowers",
  });
  // The baseline lives in `process-store.ts` now — shared with the route and
  // every other caller that bounces the dashboard, and therefore shared between
  // tests in one process until it is put back.
  _resetHermesPluginReloadStateForTests();
  restoreEnv = saveEnv("CLAWBOX_EDITION");
  process.env.CLAWBOX_EDITION = "hermes";
});

afterEach(() => restoreEnv());

describe("the plugin watcher", () => {
  /** A watcher whose clock the test moves by hand. */
  function watcherAt(clock: { ms: number }) {
    return createHermesPluginWatcher({ now: () => clock.ms });
  }

  it("takes the plugin set it finds at boot as the baseline, and restarts nothing", async () => {
    // THE CASE THAT WOULD HAVE MADE THIS A BOOT LOOP. The web server starts,
    // reads a box that has had `superpowers` installed for a week, and must not
    // conclude that anything changed. Every restart it orders drops the owner's
    // chat, and this one would order one at every boot.
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    expect(await watcher.tick()).toBe("baseline");
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("does nothing while the plugin set is unchanged", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    for (let i = 0; i < 5; i++) {
      clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 2;
      expect(await watcher.tick()).toBe("unchanged");
    }
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("restarts the dashboard once when a plugin is installed", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();

    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    // The change is SEEN, but not acted on yet: `hermes plugins install` writes
    // the ledger and the config a moment apart, and acting on the first write
    // would restart into a half-declared set and then again on the second.
    expect(await watcher.tick()).toBe("waiting");
    expect(bounceMock).not.toHaveBeenCalled();

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of writes into ONE restart", async () => {
    // `hermes plugins install` touches the ledger, the config and the plugin
    // directory; an enable touches the config again. Each of those is a change,
    // and a restart per change is four outages for one action.
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();

    for (const set of [["a"], ["a", "b"], ["a", "b", "c"]]) {
      declarationMock.mockResolvedValue(declared(set));
      clock.ms += HERMES_PLUGIN_DEBOUNCE_MS / 2;
      expect(await watcher.tick()).toBe("waiting");
    }
    expect(bounceMock).not.toHaveBeenCalled();

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("does not restart again for the set it has already restarted for", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    await watcher.tick();

    for (let i = 0; i < 5; i++) {
      clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 2;
      expect(await watcher.tick()).toBe("unchanged");
    }
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a rewrite whose CONTENT is the same", async () => {
    // The dashboard's own `ExecStartPre` re-provisions auth and rewrites
    // config.yaml on every start. Keyed on mtime, this watcher would restart the
    // dashboard because the dashboard restarted — for ever.
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    // A new object every call, same signature: the reader hashes content.
    declarationMock.mockImplementation(async () => declared(["superpowers"]));
    for (let i = 0; i < 4; i++) {
      clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 2;
      expect(await watcher.tick()).toBe("unchanged");
    }
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("forgets a change that was undone before the window closed", async () => {
    // Install then immediately remove: nothing is different from what the
    // dashboard is already running, so there is nothing to restart FOR.
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    declarationMock.mockResolvedValue(declared(["superpowers", "oops"]));
    expect(await watcher.tick()).toBe("waiting");
    declarationMock.mockResolvedValue(declared(["superpowers"]));
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("unchanged");
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("tells the owner the chat restarted, naming the plugin", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    await watcher.tick();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const message = String(notifyMock.mock.calls[0][0]);
    expect(message).toContain("weather");
    // The owner's open chat window went down with the restart. The notice is
    // the only thing that tells them why, and what to do about it.
    expect(message.toLowerCase()).toContain("new chat");
  });

  it("does not take the baseline forward when the restart failed — it tries again", async () => {
    // FALSE SUCCESS, the exact shape. A bounce that answered "failed" left the
    // dashboard running the OLD plugin set — so recording the new signature as
    // "done" would mean nothing ever tried again, and the plugin would stay
    // invisible until the next reboot with the box reporting no work outstanding.
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    bounceMock.mockResolvedValue("failed");
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("failed");

    bounceMock.mockResolvedValue("restarted");
    // The retry waits a WIDER window than the first attempt — see below — so the
    // clock has to carry past it, and the change is still outstanding when it does.
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(2);
  });

  it("backs off between failed restarts instead of bouncing a broken box for ever", async () => {
    // A dashboard systemd has GIVEN UP on — crash-looped past its start limit,
    // which this module is unprivileged to clear — answers "failed" after
    // spending the bounce's whole budget. Retrying it on every poll would be a
    // SIGTERM every few seconds against a process already failing to start, for
    // the life of the web server.
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    bounceMock.mockResolvedValue("failed");
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("failed");
    expect(bounceMock).toHaveBeenCalledTimes(1);

    // One more debounce window is no longer enough.
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("waiting");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("clears the backoff once a restart succeeds", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    bounceMock.mockResolvedValue("failed");
    declarationMock.mockResolvedValue(declared(["a"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    await watcher.tick();

    bounceMock.mockResolvedValue("restarted");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("restarted");

    // A LATER, UNRELATED change must not inherit the widened window: the box is
    // healthy again, and the owner installing a second plugin should wait the
    // ordinary debounce, not the backoff the first failure earned.
    declarationMock.mockResolvedValue(declared(["a", "b"]));
    expect(await watcher.tick()).toBe("waiting");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("restarted");
  });

  it("does not seed a baseline over a dashboard that is BEHIND the files", async () => {
    // The baseline is supposed to be "the set the RUNNING dashboard loaded",
    // and the dashboard OUTLIVES the web server: an update or a
    // `clawbox-setup` restart re-seeds it from a file the chat backend has
    // never read. `scripts/register-mcp.sh` makes that concrete — it runs at
    // EVERY web-server boot and can append the EMAIL-directive hook plugin to
    // `plugins.enabled`, and whether the plugin stayed invisible for the rest
    // of that dashboard's life was a race between its write and this tick five
    // seconds later.
    stateMock.mockResolvedValue({
      declared: ["superpowers"], loaded: [], stale: true, changedAfterStart: true,
      dashboardStartedAt: 1, signature: "sig:superpowers",
    });
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    expect(await watcher.tick()).toBe("waiting");
    expect(bounceMock).not.toHaveBeenCalled();

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("still seeds when the running dashboard cannot be asked at all", async () => {
    // `null` is "could not be established", and a watcher that bounced the
    // owner's chat on every boot it could prove nothing about would be worse
    // than one that waits for the next real change.
    stateMock.mockResolvedValue({
      declared: ["superpowers"], loaded: null, stale: null, changedAfterStart: null,
      dashboardStartedAt: null, signature: "sig:superpowers",
    });
    const clock = { ms: 0 };
    expect(await watcherAt(clock).tick()).toBe("baseline");
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("seeds — and bounces NOTHING — on a box that is behind but whose files predate the dashboard", async () => {
    // THE DEFECT HARDWARE FOUND, on the owner's own box (2026-09-18). A
    // declaration and a registry that can never agree leave `stale` true for
    // good, and a seed rule that read it alone bounced the owner's chat at
    // EVERY web-server boot — one outage per update, per `clawbox-setup`
    // restart, for ever. The second fact is what bounds it: once the dashboard
    // has restarted, its start is newer than the files, so there is nothing new
    // to restart FOR.
    stateMock.mockResolvedValue({
      declared: ["superpowers"], loaded: ["other"], stale: true, changedAfterStart: false,
      dashboardStartedAt: 5_000, signature: "sig:superpowers",
    });
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    expect(await watcher.tick()).toBe("baseline");
    for (let i = 0; i < 4; i++) {
      clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 2;
      expect(await watcher.tick()).toBe("unchanged");
    }
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("opens no window while ANOTHER caller's bounce is in flight", async () => {
    // The route and the MCP tool bounce through the same function. A watcher
    // that opened a window over one of those SIGTERMs a dashboard that is in
    // the middle of coming back — one action, two outages, two "open a new
    // chat" notices fifteen seconds apart.
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));

    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inBounce = new Promise<void>((resolve) => { entered = resolve; });
    bounceMock.mockImplementation(() => {
      entered();
      return new Promise((resolve) => { release = () => resolve("restarted"); });
    });
    const inFlight = reloadHermesPlugins("the assistant asked");
    // THE BOUNCE HAVING STARTED IS THE BARRIER, not a count of microtask turns:
    // `await Promise.resolve()` proved nothing about where the other call had
    // got to, so this test could pass on scheduling rather than on the flag.
    await inBounce;

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("waiting");
    release();
    await inFlight;
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("takes the baseline from a reload the ROUTE performed, so one change is one restart", async () => {
    // THE TWO-MODULE-COPIES TRAP. `instrumentation.ts` reaches this file with
    // `require(...)` while the route `import`s it, so a baseline kept in a
    // module-level `let` is not the same object in the two — and the assistant
    // doing exactly what `hermes_plugins_reload` tells it to do (install, then
    // call the tool) dropped the owner's chat twice.
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();

    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await reloadHermesPlugins("the assistant asked");
    expect(bounceMock).toHaveBeenCalledTimes(1);

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("unchanged");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("does not take the baseline forward over a bounce that is only PENDING", async () => {
    // `pending` means the stop took and systemd owns the unit — not that the
    // replacement is up. Recording it as loaded would leave a plugin invisible
    // with the box reporting no work outstanding, which is the same false
    // success as recording a failed one.
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    bounceMock.mockResolvedValue("pending");
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("pending");

    // The next window RECONCILES rather than stopping anything again: the
    // replacement, whenever it arrives, reads the files as they are now.
    servingMock.mockResolvedValue(true);
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("reconciled");
    expect(bounceMock).toHaveBeenCalledTimes(1);

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("unchanged");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("waits, without stopping anything, while the replacement is still coming up", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    bounceMock.mockResolvedValue("pending");
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    await watcher.tick();

    servingMock.mockResolvedValue(false);
    unitStateMock.mockResolvedValue("restarting");
    for (let i = 0; i < 3; i++) {
      clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 8;
      expect(await watcher.tick()).toBe("waiting");
    }
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("bounces again only once recovery is established as FAILED", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    bounceMock.mockResolvedValue("pending");
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    await watcher.tick();

    // Not serving, and systemd says nothing is coming on its own.
    servingMock.mockResolvedValue(false);
    unitStateMock.mockResolvedValue("down");
    bounceMock.mockResolvedValue("restarted");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 8;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(2);
  });

  it("survives a read that throws, and keeps polling", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAt(clock);
    await watcher.tick();
    declarationMock.mockRejectedValueOnce(new Error("ENOENT"));
    expect(await watcher.tick()).toBe("unreadable");
    declarationMock.mockResolvedValue(declared(["superpowers"]));
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 2;
    expect(await watcher.tick()).toBe("unchanged");
  });
});

describe("reloadHermesPlugins", () => {
  it("restarts the dashboard and reports what it now loads", async () => {
    stateMock.mockResolvedValue({
      declared: ["superpowers"],
      loaded: ["superpowers"],
      stale: false,
      dashboardStartedAt: 2,
    });
    const result = await reloadHermesPlugins("the assistant asked");
    expect(result.restarted).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.plugins).toContain("superpowers");
  });

  it("reports `pending` as not-ready rather than as a failure", async () => {
    // `bounceHermesDashboard` tells "the stop took and systemd owns it now" apart
    // from "nothing is coming back". They are opposite instructions to the
    // caller, and collapsing them is what once had an owner run `systemctl
    // restart` by hand over a dashboard that was already restarting.
    bounceMock.mockResolvedValue("pending");
    const result = await reloadHermesPlugins("the assistant asked");
    expect(result.restarted).toBe(true);
    expect(result.ready).toBe(false);
  });

  it("says so, and restarts nothing, when the bounce failed", async () => {
    bounceMock.mockResolvedValue("failed");
    const result = await reloadHermesPlugins("the assistant asked");
    expect(result.restarted).toBe(false);
    expect(result.ready).toBe(false);
  });

  it("never claims a plugin loaded when the running dashboard cannot be asked", async () => {
    // `loaded: null` is "this box cannot be asked", which is not "it loaded
    // nothing". The answer carries the declared set and says the loaded one is
    // unknown rather than inventing an empty one.
    stateMock.mockResolvedValue({
      declared: ["superpowers"],
      loaded: null,
      stale: null,
      dashboardStartedAt: null,
    });
    const result = await reloadHermesPlugins("the assistant asked");
    expect(result.plugins).toEqual(["superpowers"]);
    expect(result.loaded).toBeNull();
  });
});

describe("the shared bounce claim", () => {
  it("adds no second outage when another caller already holds the claim", async () => {
    // THE OWNER'S CARD AND THE AGENT'S TOOL, pressed together. The claim used to
    // be taken AFTER an await (reading the declaration), so both calls got past
    // the check and both stopped the dashboard — and the first `finally` then
    // cleared a flag the second bounce was still relying on, which is the window
    // the watcher SIGTERMs a restarting dashboard through.
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inBounce = new Promise<void>((resolve) => { entered = resolve; });
    bounceMock.mockImplementation(() => {
      entered();
      return new Promise((resolve) => { release = () => resolve("restarted"); });
    });

    const first = reloadHermesPlugins("the owner pressed reload");
    await inBounce;
    const second = await reloadHermesPlugins("the assistant asked");

    expect(second.restarted).toBe(false);
    expect(second.inFlight).toBe(true);
    expect(bounceMock).toHaveBeenCalledTimes(1);
    release();
    expect((await first).restarted).toBe(true);
  });

  it("moves the baseline for a DIRECT bounce, so the watcher does not repeat it", async () => {
    // `POST /setup-api/clawkeep/restore` rewrites the whole of ~/.hermes and
    // bounces the dashboard itself; `hermes-image-refresh` bounces it to pick up
    // the image backend. Neither went through this module, so neither raised the
    // gate nor moved the baseline: one restore was two chat outages and two
    // "open a new chat" notices about a plugin set nobody had touched.
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    expect(await bounceHermesDashboardShared("a ClawKeep restore replaced ~/.hermes")).toBe("restarted");

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("unchanged");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile over a dashboard that is still the SAME process", async () => {
    // `bounceHermesDashboard` answers `pending` for any unit state that is not
    // `running`/`down`, which includes both systemd reads having failed — and
    // there the old process never stopped. The port then answers (it is the OLD
    // process answering), and the watcher recorded the change as loaded and gave
    // up. The pid is the one fact that tells the two apart.
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    mainPidMock.mockResolvedValue({ read: true, pid: 4242 });
    bounceMock.mockResolvedValue("pending");
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("pending");

    // The port answers — but it is the same process answering, so this is not a
    // replacement and the bounce has to be taken again rather than recorded.
    servingMock.mockResolvedValue(true);
    bounceMock.mockResolvedValue("restarted");
    mainPidMock.mockResolvedValue({ read: true, pid: 4242 });
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 8;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(2);
  });

  it("reconciles when the pid really did move", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    mainPidMock.mockResolvedValue({ read: true, pid: 4242 });
    bounceMock.mockResolvedValue("pending");
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("pending");

    servingMock.mockResolvedValue(true);
    mainPidMock.mockResolvedValue({ read: true, pid: 5151 });
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 8;
    expect(await watcher.tick()).toBe("reconciled");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  /**
   * A pid that cannot settle the question at all — `awaitingPid` is null when
   * the pre-bounce read failed, and when systemd reported the perfectly valid
   * `MainPID=0`. The port answering is not the missing proof: a `pending` from
   * "systemd could not be asked, twice" leaves the OLD process serving :9119
   * exactly as well as a replacement would.
   */
  function bounceWithNoPidBaseline() {
    mainPidMock.mockResolvedValue({ read: false, pid: null });
    bounceMock.mockResolvedValue("pending");
    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
  }

  it("does not reconcile on the port alone when no pid can prove the replacement", async () => {
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    bounceWithNoPidBaseline();
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("pending");

    // The port answers, and the running registry STILL does not have what the
    // box declares — so whatever is serving has not read the change.
    servingMock.mockResolvedValue(true);
    stateMock.mockResolvedValue({
      declared: ["superpowers", "weather"],
      loaded: ["superpowers"],
      stale: true,
      changedAfterStart: true,
      dashboardStartedAt: 1,
      signature: "sig:superpowers,weather",
    });
    bounceMock.mockResolvedValue("restarted");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 8;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(2);
  });

  it("reconciles on the registry's own answer when no pid can prove it", async () => {
    // The other half, so the rule above cannot be tightened into a watcher that
    // never finishes: `stale: false` is the running process saying it HAS the
    // set the box declares, which is exactly what the baseline records.
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    bounceWithNoPidBaseline();
    await watcher.tick();
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS + 1;
    expect(await watcher.tick()).toBe("pending");

    servingMock.mockResolvedValue(true);
    stateMock.mockResolvedValue({
      declared: ["superpowers", "weather"],
      loaded: ["superpowers", "weather"],
      stale: false,
      changedAfterStart: false,
      dashboardStartedAt: 9_000,
      signature: "sig:superpowers,weather",
    });
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 8;
    expect(await watcher.tick()).toBe("reconciled");
    expect(bounceMock).toHaveBeenCalledTimes(1);

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 8;
    expect(await watcher.tick()).toBe("unchanged");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("takes one more bounce for a change that arrived while the claim was held", async () => {
    // `in_flight` says another restart owns the dashboard. It does NOT say the
    // replacement will have read what THIS caller just wrote: a ClawKeep
    // restore rewrites the whole of ~/.hermes, and a restore that lands after
    // the running bounce has read its files is served by a process that never
    // saw it. Nothing then reloaded it — the declaration need not have moved,
    // so the watcher's own signature comparison cannot catch it either.
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inBounce = new Promise<void>((resolve) => { entered = resolve; });
    bounceMock.mockImplementation(() => {
      entered();
      return new Promise((resolve) => { release = () => resolve("restarted"); });
    });

    const first = bounceHermesDashboardShared("the assistant asked");
    await inBounce;
    expect(await bounceHermesDashboardShared("a ClawKeep restore replaced ~/.hermes")).toBe("in_flight");
    release();
    await first;

    bounceMock.mockReset();
    bounceMock.mockResolvedValue("restarted");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("waiting");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("keeps that debt when the WATCHER is the one holding the claim", async () => {
    // The sibling write. `reloadHermesPlugins` leaves the baseline to the claim,
    // but the watcher records its own `shared.baseline = acted` after a restart
    // that worked — which would put the signature straight back over the mark
    // the claim had just made, and the restore that arrived mid-bounce would be
    // forgotten again.
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inBounce = new Promise<void>((resolve) => { entered = resolve; });
    bounceMock.mockImplementation(() => {
      entered();
      return new Promise((resolve) => { release = () => resolve("restarted"); });
    });

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("waiting");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    const bouncing = watcher.tick();
    await inBounce;
    expect(await bounceHermesDashboardShared("a ClawKeep restore replaced ~/.hermes")).toBe("in_flight");
    release();
    expect(await bouncing).toBe("restarted");

    bounceMock.mockReset();
    bounceMock.mockResolvedValue("restarted");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("waiting");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("adds no extra bounce when nobody arrived during the one in flight", async () => {
    // The debt above is owed only to a caller that actually arrived: an
    // ordinary bounce must still be ONE restart, which is the whole point of
    // the claim recording a baseline.
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    expect(await bounceHermesDashboardShared("the owner pressed reload")).toBe("restarted");

    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("unchanged");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  /**
   * A HELD BOUNCE the test can let go of, so a second caller is provably
   * inside the claim's window when it arrives.
   */
  function heldBounce() {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inBounce = new Promise<void>((resolve) => { entered = resolve; });
    bounceMock.mockImplementation(() => {
      entered();
      return new Promise((resolve) => { release = () => resolve("restarted"); });
    });
    return { inBounce, release: () => release() };
  }

  it("owes NOTHING to a second plugin reload for the same declaration", async () => {
    // THE DEBT IS FOR A MUTATION THE RUNNING BOUNCE CANNOT HAVE READ, and a
    // plugin reload for the signature that bounce is already acting on is not
    // one: the replacement coming up reads those very files. Owed anyway — as
    // it was for EVERY in-flight caller — it put `BASELINE_BEHIND` over the
    // baseline, and the watcher's next window dropped the owner's chat a
    // second time for a plugin set the new process had already loaded. The
    // owner's card and the agent's `hermes_plugins_reload` pressed together is
    // exactly that pair.
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    const held = heldBounce();
    const first = reloadHermesPlugins("the assistant asked", { signature: "sig:superpowers,weather" });
    await held.inBounce;
    const second = await reloadHermesPlugins("the owner pressed reload", {
      signature: "sig:superpowers,weather",
    });
    expect(second.inFlight).toBe(true);
    held.release();
    await first;

    bounceMock.mockReset();
    bounceMock.mockResolvedValue("restarted");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 8;
    expect(await watcher.tick()).toBe("unchanged");
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("keeps the debt when the second reload's declaration is a DIFFERENT one", async () => {
    // `hermes plugins install` landing while the first bounce is in flight:
    // the replacement read the set as it was, and what this caller wrote is
    // still outstanding. The signature is what says so.
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    const held = heldBounce();
    const first = reloadHermesPlugins("the assistant asked", { signature: "sig:superpowers,weather" });
    await held.inBounce;
    declarationMock.mockResolvedValue(declared(["superpowers", "weather", "images"]));
    expect(
      (await reloadHermesPlugins("the owner pressed reload", {
        signature: "sig:superpowers,weather,images",
      })).inFlight,
    ).toBe(true);
    held.release();
    await first;

    bounceMock.mockReset();
    bounceMock.mockResolvedValue("restarted");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("waiting");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the debt for a RESTORE that arrived during a plugin reload", async () => {
    // The signature does not represent what a ClawKeep restore changed: it puts
    // back the whole of ~/.hermes and its plugin set can be byte-identical
    // beside a completely different `state.db`. A caller that is not a plugin
    // reload therefore owes the bounce whatever the signatures say — the same
    // for the image refresh, which installs a backend the declaration never
    // mentions.
    const clock = { ms: 0 };
    const watcher = watcherAtTop(clock);
    await watcher.tick();

    declarationMock.mockResolvedValue(declared(["superpowers", "weather"]));
    const held = heldBounce();
    const first = reloadHermesPlugins("the assistant asked", { signature: "sig:superpowers,weather" });
    await held.inBounce;
    expect(await bounceHermesDashboardShared("a ClawKeep restore replaced ~/.hermes")).toBe("in_flight");
    held.release();
    await first;

    bounceMock.mockReset();
    bounceMock.mockResolvedValue("restarted");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("waiting");
    clock.ms += HERMES_PLUGIN_DEBOUNCE_MS * 4;
    expect(await watcher.tick()).toBe("restarted");
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });
});

/** The same clock-driven watcher the suite above builds; hoisted for reuse. */
function watcherAtTop(clock: { ms: number }) {
  return createHermesPluginWatcher({ now: () => clock.ms });
}
