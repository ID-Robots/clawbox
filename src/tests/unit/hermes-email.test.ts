import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hermes-telegram", () => ({
  ensureHermesGateway: vi.fn(),
  hermesGatewayStatus: vi.fn(),
}));
vi.mock("@/lib/hermes-env", () => ({
  clearHermesEnvValues: vi.fn(),
  getHermesEnvValue: vi.fn(),
  setHermesEnvValues: vi.fn(),
}));

import { ensureHermesGateway, hermesGatewayStatus } from "@/lib/hermes-telegram";
import { stopHermesEmailPolling } from "@/lib/hermes-email";

const mockEnsure = vi.mocked(ensureHermesGateway);
const mockStatus = vi.mocked(hermesGatewayStatus);

beforeEach(() => {
  vi.clearAllMocks();
});

// The two halves of "email is going away" pull in opposite directions:
// clearing the EMAIL_* block does nothing to an adapter that is already
// polling, but ensureHermesGateway INSTALLS and STARTS a system service when
// none exists — which is not something un-ticking a checkbox may do.
describe("stopHermesEmailPolling", () => {
  it("restarts the gateway when one is already running", async () => {
    mockStatus.mockResolvedValue({ installed: true, running: true, scope: "system" });
    mockEnsure.mockResolvedValue({ installed: true, running: true, scope: "system" });

    await expect(stopHermesEmailPolling()).resolves.toBe("stopped");
    expect(mockEnsure).toHaveBeenCalledTimes(1);
  });

  it("installs nothing on a device whose gateway is not running", async () => {
    mockStatus.mockResolvedValue({ installed: false, running: false, scope: null });

    await expect(stopHermesEmailPolling()).resolves.toBe("none-running");
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("leaves an installed-but-stopped gateway stopped", async () => {
    // The bench box's state before this feature was ever exercised: the unit
    // exists and is enabled, but nothing is running. Turning email off must not
    // be what starts it.
    mockStatus.mockResolvedValue({ installed: true, running: false, scope: "system" });

    await expect(stopHermesEmailPolling()).resolves.toBe("none-running");
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("says so when a gateway it cannot restart is still receiving", async () => {
    // Somebody's foreground `hermes gateway run`: there is no unit to restart,
    // and ensureHermesGateway leaves that one alone rather than blocking this
    // request in the foreground. It keeps the EMAIL_* values it loaded at
    // startup, so answering "stopped" here would tell the owner receiving had
    // ended while the allowlist can still reach the agent.
    mockStatus.mockResolvedValue({ installed: false, running: true, scope: null });

    await expect(stopHermesEmailPolling()).resolves.toBe("unmanaged");
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});
