import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `restartGateway()` used to answer as soon as `systemctl restart` returned.
 *
 * clawbox-gateway.service is `Type=simple` with no `NotifyAccess`, so systemd
 * considers the start job done the moment the main process is FORKED — seconds
 * before OpenClaw binds :18789. Every save route that awaited it therefore
 * answered `{success:true}` over a gateway that was not yet serving: the model
 * was configured, the Telegram token registered, the transcription engine
 * switched, and the box did not answer for another ten to fifteen seconds. When
 * the gateway did not come back at all, the owner was told the save had worked.
 *
 * So the restart is not finished until the port is open, and a gateway that
 * never opens it is a failure the callers can report.
 */
const execFileMock = vi.hoisted(() => vi.fn());
const waitForPortOpenMock = vi.hoisted(() => vi.fn());

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execFile: execFileMock,
}));

vi.mock("@/lib/port-probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/port-probe")>()),
  waitForPortOpen: waitForPortOpenMock,
}));

describe("restartGateway waits for the gateway to listen again", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    waitForPortOpenMock.mockReset();
    // promisify(execFile) resolves through the node-style callback.
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      cb(null, { stdout: "", stderr: "" });
    });
    waitForPortOpenMock.mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.CLAWBOX_EDITION;
    delete process.env.CLAWBOX_EDITION_FILE;
  });

  /** Force the edition through the env fallback (no root-owned file in tests). */
  async function load(edition: string) {
    process.env.CLAWBOX_EDITION_FILE = "/nonexistent/edition.env";
    process.env.CLAWBOX_EDITION = edition;
    return import("@/lib/openclaw-config");
  }

  it("rejects when the gateway never starts listening again", async () => {
    const { restartGateway, GatewayNotReadyError } = await load("openclaw");
    waitForPortOpenMock.mockResolvedValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(restartGateway()).rejects.toBeInstanceOf(GatewayNotReadyError);
    await expect(restartGateway()).rejects.toThrow(/did not come back/i);
    errorSpy.mockRestore();
  });

  it("probes the gateway's own port on loopback", async () => {
    const { restartGateway } = await load("openclaw");
    await restartGateway();

    expect(waitForPortOpenMock).toHaveBeenCalledTimes(1);
    const [port, host] = waitForPortOpenMock.mock.calls[0];
    expect(port).toBe(18789);
    expect(host).toBe("127.0.0.1");
  });

  it("resolves as soon as the port opens", async () => {
    const { restartGateway } = await load("openclaw");
    await expect(restartGateway()).resolves.toBeUndefined();
  });

  it("waits after the legacy user-unit fallback too", async () => {
    // The fallback path used to `return` straight out of the catch block, so a
    // box without the system unit kept the old unwaited behaviour.
    const { restartGateway } = await load("openclaw");
    const missing = new Error("Unit clawbox-gateway.service could not be found.");
    execFileMock.mockImplementation((_cmd: string, args: string[], _o: unknown, cb: ExecCallback) => {
      if (args.includes("restart") && args.includes("clawbox-gateway.service")) {
        cb(missing);
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });
    waitForPortOpenMock.mockResolvedValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(restartGateway()).rejects.toThrow(/did not come back/i);
    expect(execFileMock.mock.calls.some(([, args]) => (args as string[]).includes("--user"))).toBe(true);
    errorSpy.mockRestore();
  });

  it("does not probe at all on a Hermes device", async () => {
    // No gateway, no port, nothing to wait for — and a wait here would add 30 s
    // to every save on the one edition that has nothing to restart.
    const { restartGateway } = await load("hermes");
    await expect(restartGateway()).resolves.toBeUndefined();
    expect(waitForPortOpenMock).not.toHaveBeenCalled();
  });

  it("lets a caller that runs its own recovery wait opt out", async () => {
    // The updater restarts the gateway and then waits 45 s itself, reading the
    // journal when that fails so it can quarantine legacy state and retry. A
    // throw from here would skip that recovery entirely.
    const { restartGateway } = await load("openclaw");
    waitForPortOpenMock.mockResolvedValue(false);

    await expect(restartGateway({ awaitReady: false })).resolves.toBeUndefined();
    expect(waitForPortOpenMock).not.toHaveBeenCalled();
  });
});
