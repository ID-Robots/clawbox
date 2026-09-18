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

vi.mock("@/lib/hermes-dashboard-control", () => ({ bounceHermesDashboard: bounceMock }));
vi.mock("@/lib/email-notify", () => ({ notifyOwner: notifyMock }));
vi.mock("@/lib/hermes-plugin-set", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-plugin-set")>()),
  readHermesPluginDeclaration: declarationMock,
  readHermesPluginState: stateMock,
}));

import {
  HERMES_PLUGIN_DEBOUNCE_MS,
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
  bounceMock.mockResolvedValue("restarted");
  notifyMock.mockResolvedValue(undefined);
  declarationMock.mockResolvedValue(declared(["superpowers"]));
  stateMock.mockResolvedValue({
    declared: ["superpowers"],
    loaded: ["superpowers"],
    stale: false,
    dashboardStartedAt: 1,
  });
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
