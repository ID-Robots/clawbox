import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Enabling Gemma 4 on a Hermes box reported "AI model configured but gateway
 * failed to restart. Try rebooting the device." — on a device where the config
 * had been written correctly and there was no gateway to restart.
 *
 * The Hermes edition MASKS clawbox-gateway.service, and `systemctl restart` on
 * a masked unit fails with "Unit clawbox-gateway.service is masked." That text
 * did not match the "not found" branch, so it fell through to the throw. Hermes
 * has no daemon of its own — the CLI is invoked per request and re-reads its
 * config — so the correct behaviour is to do nothing at all.
 */
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execFile: execFileMock,
}));

describe("restartGateway across editions", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    // promisify(execFile) resolves through the node-style callback.
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: "", stderr: "" });
    });
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

  it("does not touch systemd on a Hermes device", async () => {
    const { restartGateway } = await load("hermes");
    await expect(restartGateway()).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("still restarts the gateway on an OpenClaw device", async () => {
    const { restartGateway } = await load("openclaw");
    await restartGateway();
    expect(execFileMock).toHaveBeenCalled();
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe("/usr/bin/sudo");
    expect(args).toContain("clawbox-gateway.service");
  });

  it("treats a masked unit as absent rather than as a failure", async () => {
    const { restartGateway } = await load("openclaw");
    execFileMock.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => {
      cb(new Error("Failed to restart clawbox-gateway.service: Unit clawbox-gateway.service is masked."));
    });
    // Falls through to the user-unit fallback (mocked to succeed) instead of
    // throwing, which is what surfaced the error banner to the customer.
    await expect(restartGateway()).resolves.toBeUndefined();
  });

  it("exposes no reloadGateway at all — skill installs bounce nothing", async () => {
    // The module used to ship a reloadGateway() that signalled the gateway on
    // every skill install. OpenClaw reads that signal as "restart", so the
    // whole entry point is gone rather than merely neutered on Hermes.
    const mod = await load("hermes");
    expect("reloadGateway" in mod).toBe(false);
  });
});
