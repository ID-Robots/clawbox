import { describe, it, expect } from "vitest";
import {
  classifyInstallState,
  parseUnitState,
  waitForInstallComplete,
  InstallBootstrapFailedError,
  BOOTSTRAP_UNIT,
  type BootstrapUnitState,
  type InstallProbes,
} from "../../../e2e-install/helpers/container";

/**
 * The e2e-install harness waits for install.sh inside a systemd container.
 * Measured on PR #558: clawbox-bootstrap.service exited 1 at ~3 min, and the
 * wait loop kept polling the .needs-install marker until its 40-minute
 * deadline — 41 minutes to report a failure known at minute 3. The container
 * cannot run here; these tests pin the loop's decisions through fake probes so
 * that fail-fast, the success path and the backstop deadline are all proven
 * without docker.
 */

const ACTIVATING: BootstrapUnitState = { activeState: "activating", result: "success" };
const FAILED: BootstrapUnitState = { activeState: "failed", result: "exit-code" };
const ACTIVE: BootstrapUnitState = { activeState: "active", result: "success" };

type Poll = { markerGone: boolean; httpReady: boolean; unit: BootstrapUnitState };

/**
 * Fake probes that replay a scripted sequence of container states, one per
 * poll, and count how often the loop asked and slept. The last state repeats
 * so a "keeps waiting" script cannot run off its end.
 */
function scripted(polls: Poll[], opts: { stepMs?: number } = {}) {
  const calls = { markerGone: 0, httpReady: 0, bootstrapUnit: 0, installLogTail: 0, sleeps: [] as number[] };
  let clock = 0;
  const at = () => polls[Math.min(calls.markerGone - 1, polls.length - 1)];
  const probes: InstallProbes = {
    async markerGone() { calls.markerGone++; return at().markerGone; },
    async httpReady() { calls.httpReady++; return at().httpReady; },
    async bootstrapUnit() { calls.bootstrapUnit++; return at().unit; },
    async installLogTail() { calls.installLogTail++; return "step_build: FAILED\nnext build exited 1"; },
    async sleep(ms) { calls.sleeps.push(ms); clock += opts.stepMs ?? ms; },
    now: () => clock,
  };
  return { probes, calls };
}

describe("classifyInstallState", () => {
  it("marker present + unit failed → failed", () => {
    expect(classifyInstallState({ markerGone: false, httpReady: false, unitFailed: true })).toBe("failed");
  });

  it("marker gone + http ready → done", () => {
    expect(classifyInstallState({ markerGone: true, httpReady: true, unitFailed: false })).toBe("done");
  });

  it("marker present + unit still running → wait", () => {
    expect(classifyInstallState({ markerGone: false, httpReady: false, unitFailed: false })).toBe("wait");
  });

  it("marker gone but server not up yet → wait (the server comes up after the marker goes)", () => {
    expect(classifyInstallState({ markerGone: true, httpReady: false, unitFailed: false })).toBe("wait");
  });

  it("a live server with the marker still present is the installer's mid-run start, not completion", () => {
    expect(classifyInstallState({ markerGone: false, httpReady: true, unitFailed: false })).toBe("wait");
  });

  it("done wins over a failed unit: the marker only goes after install.sh exited 0", () => {
    expect(classifyInstallState({ markerGone: true, httpReady: true, unitFailed: true })).toBe("done");
  });
});

describe("parseUnitState", () => {
  it("reads the two properties systemctl show prints", () => {
    expect(parseUnitState("ActiveState=failed\nResult=exit-code\n")).toEqual(FAILED);
  });

  it("is independent of property order", () => {
    expect(parseUnitState("Result=exit-code\nActiveState=failed\n")).toEqual(FAILED);
  });

  it("a missing property is unknown, never failed", () => {
    expect(parseUnitState("")).toEqual({ activeState: "unknown", result: "unknown" });
    expect(parseUnitState("garbage without equals")).toEqual({ activeState: "unknown", result: "unknown" });
  });
});

describe("waitForInstallComplete", () => {
  it("marker present + unit failed → throws 'bootstrap failed' on the first poll, no further polling", async () => {
    const { probes, calls } = scripted([{ markerGone: false, httpReady: false, unit: FAILED }]);
    const err = await waitForInstallComplete(40 * 60_000, probes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallBootstrapFailedError);
    const message = (err as Error).message;
    expect(message).toMatch(/^bootstrap failed/);
    expect(message).toContain(BOOTSTRAP_UNIT);
    expect(message).toContain("Result=exit-code");
    // The cause is in the error itself, so the job log shows it where the
    // failure is reported, not only in a dump further down.
    expect(message).toContain("step_build: FAILED");
    expect((err as InstallBootstrapFailedError).installLogTail).toContain("next build exited 1");
    expect(calls.markerGone).toBe(1);
    expect(calls.bootstrapUnit).toBe(1);
    expect(calls.installLogTail).toBe(1);
    expect(calls.sleeps).toEqual([]);
  });

  it("a unit that fails after a few polls ends the wait on the poll that sees it", async () => {
    const { probes, calls } = scripted([
      { markerGone: false, httpReady: false, unit: ACTIVATING },
      { markerGone: false, httpReady: false, unit: ACTIVATING },
      { markerGone: false, httpReady: false, unit: FAILED },
    ]);
    await expect(waitForInstallComplete(40 * 60_000, probes)).rejects.toBeInstanceOf(InstallBootstrapFailedError);
    expect(calls.markerGone).toBe(3);
    expect(calls.sleeps).toHaveLength(2);
  });

  it("marker gone + http ready → resolves without sleeping", async () => {
    const { probes, calls } = scripted([{ markerGone: true, httpReady: true, unit: ACTIVE }]);
    await expect(waitForInstallComplete(40 * 60_000, probes)).resolves.toBeUndefined();
    expect(calls.sleeps).toEqual([]);
  });

  it("marker present + unit active → keeps waiting until the marker goes and the server answers", async () => {
    const { probes, calls } = scripted([
      { markerGone: false, httpReady: false, unit: ACTIVATING },
      { markerGone: false, httpReady: false, unit: ACTIVATING },
      { markerGone: true, httpReady: false, unit: ACTIVE },
      { markerGone: true, httpReady: true, unit: ACTIVE },
    ]);
    await expect(waitForInstallComplete(40 * 60_000, probes)).resolves.toBeUndefined();
    expect(calls.markerGone).toBe(4);
    expect(calls.sleeps).toEqual([5_000, 5_000, 5_000]);
    // HTTP is only asked once the marker is gone — before that a live server
    // is the installer's own mid-run start, not completion.
    expect(calls.httpReady).toBe(2);
    expect(calls.installLogTail).toBe(0);
  });

  it("an unknown unit state (docker exec failed) is not a failure — the loop keeps waiting", async () => {
    const { probes, calls } = scripted([
      { markerGone: false, httpReady: false, unit: { activeState: "unknown", result: "unknown" } },
      { markerGone: true, httpReady: true, unit: ACTIVE },
    ]);
    await expect(waitForInstallComplete(40 * 60_000, probes)).resolves.toBeUndefined();
    expect(calls.sleeps).toHaveLength(1);
  });

  it("the deadline is still the backstop for an installer that hangs without failing", async () => {
    // Each fake sleep advances the clock by one minute, so a 40-minute
    // deadline is reached after 40 polls of a unit that never fails.
    const { probes, calls } = scripted(
      [{ markerGone: false, httpReady: false, unit: ACTIVATING }],
      { stepMs: 60_000 },
    );
    const err = await waitForInstallComplete(40 * 60_000, probes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InstallBootstrapFailedError);
    expect((err as Error).message).toContain("did not finish within 2400000ms");
    expect(calls.sleeps).toHaveLength(40);
    expect(calls.installLogTail).toBe(0);
  });
});
