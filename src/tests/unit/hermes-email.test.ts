import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hermes-telegram", () => ({
  ensureHermesGateway: vi.fn(),
  hermesGatewayStatus: vi.fn(),
  readHermesGatewayStatus: vi.fn(),
}));
vi.mock("@/lib/hermes-env", () => ({
  clearHermesEnvValues: vi.fn(),
  getHermesEnvValue: vi.fn(),
  setHermesEnvValues: vi.fn(),
}));

import { ensureHermesGateway, hermesGatewayStatus, readHermesGatewayStatus } from "@/lib/hermes-telegram";
import { stopHermesEmailPolling } from "@/lib/hermes-email";

const mockEnsure = vi.mocked(ensureHermesGateway);
const mockMemo = vi.mocked(hermesGatewayStatus);
const mockRead = vi.mocked(readHermesGatewayStatus);

/** A probe that ran and returned this. */
const answered = (value: { installed: boolean; running: boolean; scope: "system" | "user" | null }) =>
  ({ value, answered: true }) as const;

beforeEach(() => {
  vi.clearAllMocks();
});

// The two halves of "email is going away" pull in opposite directions:
// clearing the EMAIL_* block does nothing to an adapter that is already
// polling, but ensureHermesGateway INSTALLS and STARTS a system service when
// none exists — which is not something un-ticking a checkbox may do.
describe("stopHermesEmailPolling", () => {
  it("restarts the gateway when one is already running", async () => {
    mockRead.mockResolvedValue(answered({ installed: true, running: true, scope: "system" }));
    mockEnsure.mockResolvedValue({ installed: true, running: true, scope: "system", applied: true });

    await expect(stopHermesEmailPolling()).resolves.toBe("stopped");
    expect(mockEnsure).toHaveBeenCalledTimes(1);
  });

  // runHermesCli resolves on a non-zero exit and the status probe runs
  // unprivileged, so before `applied` existed a restart that was REFUSED still
  // came back as `running: true` and this function answered "stopped" — telling
  // the owner receiving had ended while the old process kept polling the old
  // mailbox with the old allowlist.
  it("does not claim 'stopped' when the restart was refused", async () => {
    mockRead.mockResolvedValue(answered({ installed: true, running: true, scope: "system" }));
    mockEnsure.mockResolvedValue({ installed: true, running: true, scope: "system", applied: false });

    await expect(stopHermesEmailPolling()).resolves.toBe("restart-failed");
  });

  it("installs nothing on a device whose gateway is not running", async () => {
    mockRead.mockResolvedValue(answered({ installed: false, running: false, scope: null }));

    await expect(stopHermesEmailPolling()).resolves.toBe("none-running");
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("leaves an installed-but-stopped gateway stopped", async () => {
    // The bench box's state before this feature was ever exercised: the unit
    // exists and is enabled, but nothing is running. Turning email off must not
    // be what starts it.
    mockRead.mockResolvedValue(answered({ installed: true, running: false, scope: "system" }));

    await expect(stopHermesEmailPolling()).resolves.toBe("none-running");
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("says so when a gateway it cannot restart is still receiving", async () => {
    // Somebody's foreground `hermes gateway run`: there is no unit to restart,
    // and ensureHermesGateway leaves that one alone rather than blocking this
    // request in the foreground. It keeps the EMAIL_* values it loaded at
    // startup, so answering "stopped" here would tell the owner receiving had
    // ended while the allowlist can still reach the agent.
    mockRead.mockResolvedValue(answered({ installed: false, running: true, scope: null }));

    await expect(stopHermesEmailPolling()).resolves.toBe("unmanaged");
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("asks the gateway itself rather than the shared fifteen-second memo", async () => {
    // Opening Settings → Channels fires the Telegram, WhatsApp and Discord
    // status routes, all of which populate `hermesGatewayStatus()`'s memo. If
    // the gateway then dies and systemd brings it back, nothing invalidates
    // that entry — and reading it here would branch on a `running: false` from
    // before the restart, answer "none-running", and let the route report
    // "receiving stopped" over a gateway still polling the mailbox the owner
    // just disconnected. This function BRANCHES on the answer, so it takes the
    // uncached reader, exactly as `ensureHermesGateway` does.
    mockRead.mockResolvedValue(answered({ installed: true, running: true, scope: "system" }));
    // Stubbed so the wrong reader would still WORK: the point has to fail on
    // the assertion below, not on a crash.
    mockMemo.mockResolvedValue({ installed: true, running: true, scope: "system" });
    mockEnsure.mockResolvedValue({ installed: true, running: true, scope: "system", applied: true });

    await stopHermesEmailPolling();

    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockMemo).not.toHaveBeenCalled();
  });

  it("does not read a probe that failed as 'nothing was polling'", async () => {
    // A `hermes gateway status` that times out on a loaded box degrades to
    // {installed:false, running:false} — the same shape as a device with no
    // gateway at all. Answering "none-running" for it is the false success this
    // whole path exists to remove: nothing was restarted, and something may
    // very well still be receiving.
    mockRead.mockResolvedValue({
      value: { installed: false, running: false, scope: null },
      answered: false,
    });
    // What the memoised reader hands out for the same failure: the flag that
    // tells the two apart is gone, which is why this function may not use it.
    mockMemo.mockResolvedValue({ installed: false, running: false, scope: null });

    await expect(stopHermesEmailPolling()).resolves.toBe("restart-failed");
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});
