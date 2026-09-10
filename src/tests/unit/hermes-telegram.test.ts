import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * Hermes' Telegram surface has no machine-readable output where we need it:
 * `hermes pairing list` has no --json and `hermes gateway status` has no --json
 * (both verified against the installed CLI, v0.20.0 / 2026.8.3). The fixtures
 * below are the CLI's REAL output, captured from a ClawBox Hermes device, so a
 * change in Hermes' formatting fails here rather than in front of a user.
 */

const runHermesCliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));

// The system-scope restart goes through `sudo -n /usr/bin/systemctl restart
// hermes-gateway.service` rather than the Hermes CLI — see ensureHermesGateway.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile: execFileMock }));

/** Make the mocked execFile succeed / fail the way promisify(execFile) sees it. */
function execFileSucceeds() {
  execFileMock.mockImplementation((_bin: string, _argv: string[], _opts: unknown, cb: (e: Error | null, out?: string, err?: string) => void) => cb(null, "", ""));
}
function execFileFails(message: string) {
  execFileMock.mockImplementation((_bin: string, _argv: string[], _opts: unknown, cb: (e: Error | null) => void) => cb(new Error(message)));
}

// Captured verbatim from `hermes pairing list` with two pending requests and
// one approved user. Note the second pending row: the display name is wider
// than its 20-char column, so every field after it is shifted — column offsets
// would mis-read this row, and so would splitting the name on whitespace.
const PAIRING_LIST_OUTPUT = `
  Pending Pairing Requests (2):
  Platform     Request ID         User ID              Name                 Age
  --------     ----------         -------              ----                 ---
  telegram     a1b2c3d4e5f60718   123456789            Krasimir Kralev      2m ago
  telegram     0f1e2d3c4b5a6978   987654321012345      A Very Long Display Name Indeed 55m ago

  Approve with: hermes pairing approve <platform> <request-id>
  The code the bot DM'd the user also works if they relay it.

  Approved Users (1):
  Platform     User ID              Name
  --------     -------              ----
  telegram     555000111            Yanko
`;

// Captured after approving one request: the "no pending" branch prints a
// sentence and NO section header, so a parser keyed on the header alone must
// not fall through into the approved table.
const PAIRING_LIST_NO_PENDING = `
  No pending pairing requests.

  Approved Users (1):
  Platform     User ID              Name
  --------     -------              ----
  telegram     555000111            Yanko
`;

const PAIRING_LIST_EMPTY = "No pairing data found. No one has tried to pair yet~";

// Captured from `hermes gateway status` in each of its three states.
const GATEWAY_NO_SERVICE = `✗ Gateway is not running

To start:
  hermes gateway run      # Run in foreground
  hermes gateway install  # Install as user service
  sudo hermes gateway install --system  # Install as boot-time system service`;

const GATEWAY_SERVICE_STOPPED = `○ hermes-gateway.service - Hermes Agent Gateway - Messaging Platform Integration
     Loaded: loaded (/etc/systemd/system/hermes-gateway.service; disabled; vendor preset: enabled)
     Active: inactive (dead)
✗ System gateway service is stopped
  Run: sudo hermes gateway start --system
Configured to run as: clawbox
✓ System service starts at boot without requiring systemd linger`;

const GATEWAY_SERVICE_RUNNING = `● hermes-gateway.service - Hermes Agent Gateway - Messaging Platform Integration
     Loaded: loaded (/etc/systemd/system/hermes-gateway.service; enabled; vendor preset: enabled)
     Active: active (running) since Mon 2026-08-10 22:45:04 UTC; 21s ago
   Main PID: 86759 (hermes)
✓ System gateway service is running
Configured to run as: clawbox
✓ System service starts at boot without requiring systemd linger`;

// The user-scope spelling of the same verdict. ClawBox installs a SYSTEM unit,
// but a device someone set up by hand can have this one, and it must never be
// driven through sudo — `systemctl --user` from a system service would target
// root's session bus, not clawbox's.
const GATEWAY_USER_SERVICE_RUNNING = `● hermes-gateway.service - Hermes Agent Gateway - Messaging Platform Integration
     Loaded: loaded (/home/clawbox/.config/systemd/user/hermes-gateway.service; enabled)
     Active: active (running) since Mon 2026-08-10 22:45:04 UTC; 21s ago
   Main PID: 86759 (hermes)
✓ User gateway service is running`;

const GATEWAY_MANUAL_RUNNING = `✓ Gateway is running (PID: 4242)
  (Running manually, not as a system service)

To install as a service:
  hermes gateway install`;

describe("parseHermesPairingList", () => {
  it("reads both tables out of the real CLI output", async () => {
    const { parseHermesPairingList } = await import("@/lib/hermes-telegram");
    const { pending, approved } = parseHermesPairingList(PAIRING_LIST_OUTPUT);

    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({
      code: "a1b2c3d4e5f60718",
      id: "123456789",
      name: "Krasimir Kralev",
    });
    expect(approved).toEqual([{ id: "555000111", name: "Yanko" }]);
  });

  it("reads a row whose name overflows its column and shifts the rest", async () => {
    const { parseHermesPairingList } = await import("@/lib/hermes-telegram");
    const { pending } = parseHermesPairingList(PAIRING_LIST_OUTPUT);

    expect(pending[1]).toMatchObject({
      code: "0f1e2d3c4b5a6978",
      id: "987654321012345",
      name: "A Very Long Display Name Indeed",
    });
  });

  it("never mistakes the header, the rule or the hint lines for rows", async () => {
    const { parseHermesPairingList } = await import("@/lib/hermes-telegram");
    const { pending, approved } = parseHermesPairingList(PAIRING_LIST_OUTPUT);

    for (const entry of [...pending, ...approved]) {
      expect(entry.id).not.toMatch(/^-+$/);
      expect(entry.id).not.toBe("ID");
    }
    expect(pending.map((p) => p.code)).not.toContain("Request");
  });

  it("does not read the approved table as pending when nothing is pending", async () => {
    const { parseHermesPairingList } = await import("@/lib/hermes-telegram");
    const { pending, approved } = parseHermesPairingList(PAIRING_LIST_NO_PENDING);

    expect(pending).toEqual([]);
    expect(approved).toEqual([{ id: "555000111", name: "Yanko" }]);
  });

  it("returns nothing for the empty-store message", async () => {
    const { parseHermesPairingList } = await import("@/lib/hermes-telegram");
    expect(parseHermesPairingList(PAIRING_LIST_EMPTY)).toEqual({ pending: [], approved: [] });
  });
});

describe("parseHermesGatewayStatus", () => {
  it("reports a running system service", async () => {
    const { parseHermesGatewayStatus } = await import("@/lib/hermes-telegram");
    expect(parseHermesGatewayStatus(GATEWAY_SERVICE_RUNNING)).toEqual({
      installed: true,
      running: true,
      scope: "system",
      answered: true,
    });
  });

  it("reports an installed but stopped service", async () => {
    const { parseHermesGatewayStatus } = await import("@/lib/hermes-telegram");
    expect(parseHermesGatewayStatus(GATEWAY_SERVICE_STOPPED)).toEqual({
      installed: true,
      running: false,
      scope: "system",
      answered: true,
    });
  });

  // The no-service output never says "not installed", so this is the case a
  // phrase-matching parser gets backwards — and getting it backwards means
  // running `gateway restart`, whose fallback path starts the gateway in the
  // FOREGROUND and would hang the request that called it.
  it("reports no service when the CLI only offers install hints", async () => {
    const { parseHermesGatewayStatus } = await import("@/lib/hermes-telegram");
    expect(parseHermesGatewayStatus(GATEWAY_NO_SERVICE)).toEqual({
      installed: false,
      running: false,
      scope: null,
      answered: true,
    });
  });

  it("reports a manually-run gateway as running but not installed", async () => {
    const { parseHermesGatewayStatus } = await import("@/lib/hermes-telegram");
    expect(parseHermesGatewayStatus(GATEWAY_MANUAL_RUNNING)).toEqual({
      installed: false,
      running: true,
      scope: null,
      answered: true,
    });
  });
});

describe("approveHermesPairing", () => {
  beforeEach(() => {
    vi.resetModules();
    runHermesCliMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function cliResult(stdout: string, code = 0) {
    return { code, stdout, stderr: "" };
  }

  it("approves by request id and returns the granted user", async () => {
    runHermesCliMock.mockResolvedValue(
      cliResult("\n  Approved! User Krasimir Kralev (123456789) on telegram can now use the bot~\n"),
    );
    const { approveHermesPairing } = await import("@/lib/hermes-telegram");

    await expect(approveHermesPairing("a1b2c3d4e5f60718")).resolves.toEqual({
      userId: "123456789",
      userName: "Krasimir Kralev",
    });
    expect(runHermesCliMock.mock.calls[0][0]).toEqual([
      "pairing",
      "approve",
      "telegram",
      "a1b2c3d4e5f60718",
    ]);
  });

  it("lowercases a request id but uppercases a pairing code", async () => {
    runHermesCliMock.mockResolvedValue(
      cliResult("  Approved! User 999 on telegram can now use the bot~"),
    );
    const { approveHermesPairing } = await import("@/lib/hermes-telegram");

    await approveHermesPairing("A1B2C3D4E5F60718");
    expect(runHermesCliMock.mock.calls[0][0][3]).toBe("a1b2c3d4e5f60718");

    await approveHermesPairing("fql2a98k");
    expect(runHermesCliMock.mock.calls[1][0][3]).toBe("FQL2A98K");
  });

  // `hermes pairing approve` exits 0 for an unknown or expired token, so an
  // exit-code check would report every bad code as a success.
  it("fails on an unknown token even though the CLI exits 0", async () => {
    runHermesCliMock.mockResolvedValue(
      cliResult(
        "\n  Pairing request or code 'ZZZZZZZZ' not found or expired for platform 'telegram'.\n",
        0,
      ),
    );
    const { approveHermesPairing } = await import("@/lib/hermes-telegram");
    await expect(approveHermesPairing("ZZZZZZZZ")).rejects.toThrow(/not found or expired/i);
  });

  it("rejects a malformed token before spawning the CLI", async () => {
    const { approveHermesPairing } = await import("@/lib/hermes-telegram");
    await expect(approveHermesPairing("nope")).rejects.toThrow(/Invalid pairing code/);
    await expect(approveHermesPairing("--yolo")).rejects.toThrow(/Invalid pairing code/);
    expect(runHermesCliMock).not.toHaveBeenCalled();
  });
});

describe("revokeHermesPairing", () => {
  beforeEach(() => {
    vi.resetModules();
    runHermesCliMock.mockReset();
  });

  it("reports success from the output, not the exit code", async () => {
    runHermesCliMock.mockResolvedValue({
      code: 0,
      stdout: "\n  Revoked access for user 123456789 on telegram.\n",
      stderr: "",
    });
    const { revokeHermesPairing } = await import("@/lib/hermes-telegram");
    await expect(revokeHermesPairing("123456789")).resolves.toBe(true);
  });

  it("reports false for a user that was never approved (also exit 0)", async () => {
    runHermesCliMock.mockResolvedValue({
      code: 0,
      stdout: "\n  User 424242 not found in approved list for telegram.\n",
      stderr: "",
    });
    const { revokeHermesPairing } = await import("@/lib/hermes-telegram");
    await expect(revokeHermesPairing("424242")).resolves.toBe(false);
  });

  it("refuses a user id that could be read as a flag", async () => {
    const { revokeHermesPairing } = await import("@/lib/hermes-telegram");
    await expect(revokeHermesPairing("--system")).rejects.toThrow(/Invalid Telegram user id/);
    expect(runHermesCliMock).not.toHaveBeenCalled();
  });
});

describe("hermesTelegramRegistered", () => {
  beforeEach(() => {
    vi.resetModules();
    runHermesCliMock.mockReset();
  });

  it("is true when Hermes lists telegram as a configured platform", async () => {
    runHermesCliMock.mockResolvedValue({
      code: 0,
      stdout: '{\n  "platforms": {\n    "telegram": []\n  }\n}',
      stderr: "",
    });
    const { hermesTelegramRegistered } = await import("@/lib/hermes-telegram");
    await expect(hermesTelegramRegistered()).resolves.toBe(true);
  });

  it("is false when Hermes reports no telegram target", async () => {
    runHermesCliMock.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "hermes send: no targets found for platform 'telegram'. Configured: (none)",
    });
    const { hermesTelegramRegistered } = await import("@/lib/hermes-telegram");
    await expect(hermesTelegramRegistered()).resolves.toBe(false);
  });

  // Distinct from `false`: a Jetson that was too slow to answer must not make
  // the UI tell someone their working bot is not configured.
  it("is null when Hermes could not be asked at all", async () => {
    runHermesCliMock.mockRejectedValue(new Error("hermes timed out"));
    const { hermesTelegramRegistered } = await import("@/lib/hermes-telegram");
    await expect(hermesTelegramRegistered()).resolves.toBeNull();
  });
});

describe("setHermesTelegramToken", () => {
  beforeEach(() => {
    vi.resetModules();
    runHermesCliMock.mockReset();
  });

  it("writes the token through `hermes config set`, as argv", async () => {
    runHermesCliMock.mockResolvedValue({
      code: 0,
      stdout: "✓ Set TELEGRAM_BOT_TOKEN in /home/clawbox/.hermes/.env",
      stderr: "",
    });
    const { setHermesTelegramToken } = await import("@/lib/hermes-telegram");
    await setHermesTelegramToken("123456789:token-value");

    expect(runHermesCliMock).toHaveBeenCalledWith(
      ["config", "set", "TELEGRAM_BOT_TOKEN", "123456789:token-value"],
      expect.anything(),
    );
  });

  it("throws when Hermes rejects the write", async () => {
    runHermesCliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "nope" });
    const { setHermesTelegramToken } = await import("@/lib/hermes-telegram");
    await expect(setHermesTelegramToken("1:x")).rejects.toThrow();
  });
});

describe("ensureHermesGateway", () => {
  beforeEach(() => {
    vi.resetModules();
    runHermesCliMock.mockReset();
    execFileMock.mockReset();
    execFileSucceeds();
  });

  it("installs a boot-time system service when none exists", async () => {
    runHermesCliMock
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_NO_SERVICE, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "✓ System service started", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_SERVICE_RUNNING, stderr: "" });

    const { ensureHermesGateway } = await import("@/lib/hermes-telegram");
    await expect(ensureHermesGateway()).resolves.toMatchObject({ running: true });

    const [args, opts] = runHermesCliMock.mock.calls[1];
    expect(args).toEqual([
      "gateway",
      "install",
      "--system",
      "--run-as-user",
      "clawbox",
      "--start-now",
      "--start-on-login",
    ]);
    expect(opts.sudo).toBe(true);
  });

  // The restart used to be `sudo -n /home/clawbox/.local/bin/hermes gateway
  // restart --system`. That binary is clawbox-owned and clawbox-writable, so it
  // could never be allow-listed — the sudoers coverage checker had to EXEMPT it
  // — which meant the restart silently failed on any narrowed box. The unit is
  // root-owned and runs User=clawbox, so systemctl grants nothing new.
  it("restarts an installed system service through systemctl, not the CLI", async () => {
    runHermesCliMock
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_SERVICE_STOPPED, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_SERVICE_RUNNING, stderr: "" });

    const { ensureHermesGateway } = await import("@/lib/hermes-telegram");
    await expect(ensureHermesGateway()).resolves.toMatchObject({ running: true, applied: true });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = execFileMock.mock.calls[0];
    expect(bin).toBe("/usr/bin/sudo");
    expect(argv).toEqual(["-n", "/usr/bin/systemctl", "restart", "hermes-gateway.service"]);
    // Never sudo the clawbox-writable hermes binary again.
    for (const [, opts] of runHermesCliMock.mock.calls) {
      expect(opts?.sudo).not.toBe(true);
    }
  });

  // THE FALSE SUCCESS. `hermes gateway status` runs UNPRIVILEGED, so after a
  // refused restart it still sees the OLD process and answers "running". The
  // route then replied {restarted: true} and the owner's new token did nothing.
  it("reports applied: false when the restart is refused, even though the old process is still up", async () => {
    runHermesCliMock
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_SERVICE_RUNNING, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_SERVICE_RUNNING, stderr: "" });
    execFileFails("sudo: a password is required");

    const { ensureHermesGateway } = await import("@/lib/hermes-telegram");
    await expect(ensureHermesGateway()).resolves.toMatchObject({
      running: true,
      applied: false,
    });
  });

  // A user-scope unit must NOT be driven with sudo (systemctl --user would be
  // aimed at root's session bus), so that branch stays on the CLI — but
  // runHermesCli RESOLVES on a non-zero exit, so the code has to be checked.
  it("keeps a user-scope service on the CLI and honours its exit code", async () => {
    runHermesCliMock
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_USER_SERVICE_RUNNING, stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Failed to restart" })
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_USER_SERVICE_RUNNING, stderr: "" });

    const { ensureHermesGateway } = await import("@/lib/hermes-telegram");
    const res = await ensureHermesGateway();
    expect(res).toMatchObject({ scope: "user", running: true, applied: false });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(runHermesCliMock.mock.calls[1][0]).toEqual(["gateway", "restart"]);
    expect(runHermesCliMock.mock.calls[1][1]?.sudo).toBeUndefined();
  });

  // THE FALSE FAILURE THAT BECOMES A PRIVILEGED WRITE. A probe that could not
  // run — a `hermes gateway status` that timed out on a loaded Jetson, a wedged
  // CLI — degrades to {installed:false, running:false}, which is exactly the
  // shape of a box that has no gateway at all. Acting on it ran
  // `sudo hermes gateway install --system` over the unit of a box that already
  // had one.
  it("does not read a failed probe as 'no gateway here' and install over one", async () => {
    runHermesCliMock.mockRejectedValueOnce(new Error("hermes call timed out"));

    const { ensureHermesGateway } = await import("@/lib/hermes-telegram");
    await expect(ensureHermesGateway()).resolves.toMatchObject({ applied: false });

    // One call: the probe. No install, no restart.
    expect(runHermesCliMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // `gateway restart` with no service unit falls back to starting the gateway
  // in the foreground, which from a route handler blocks until the timeout.
  it("leaves a manually-run gateway alone rather than restarting it", async () => {
    runHermesCliMock.mockResolvedValueOnce({ code: 0, stdout: GATEWAY_MANUAL_RUNNING, stderr: "" });

    const { ensureHermesGateway } = await import("@/lib/hermes-telegram");
    await expect(ensureHermesGateway()).resolves.toMatchObject({
      installed: false,
      running: true,
    });
    expect(runHermesCliMock).toHaveBeenCalledTimes(1);
  });
});

// The pairing store is read directly (not through the CLI) for the desktop
// popup, which polls every 20 s and should not spawn a process each time.
describe("pairing store reads", () => {
  let home: string;
  let storeDir: string;
  const origHome = process.env.HERMES_HOME;
  const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);

  beforeEach(async () => {
    vi.resetModules();
    runHermesCliMock.mockReset();
    runHermesCliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
    storeDir = path.join(home, "platforms", "pairing");
    await fs.mkdir(storeDir, { recursive: true });
    process.env.HERMES_HOME = home;
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeStore(name: string, data: unknown, dir = storeDir) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), JSON.stringify(data), "utf-8");
  }

  it("reads pending requests, using the store key as the approvable token", async () => {
    await writeStore("telegram-pending.json", {
      a1b2c3d4e5f60718: {
        hash: "deadbeef",
        salt: "00112233",
        user_id: "123456789",
        user_name: "Krasimir Kralev",
        created_at: (NOW - 120_000) / 1000,
      },
    });
    const { readHermesPairingRequests } = await import("@/lib/hermes-telegram");

    expect(await readHermesPairingRequests(NOW)).toEqual([
      {
        code: "a1b2c3d4e5f60718",
        id: "123456789",
        name: "Krasimir Kralev",
        createdAt: new Date(NOW - 120_000).toISOString(),
      },
    ]);
  });

  // Codes live an hour; the CLI prunes on read, a file read has to prune itself
  // or the popup offers approvals that can no longer succeed.
  it("drops requests past the one-hour expiry", async () => {
    await writeStore("telegram-pending.json", {
      old1234567890abc: {
        hash: "h",
        salt: "s",
        user_id: "1",
        created_at: (NOW - 4_000_000) / 1000,
      },
    });
    const { readHermesPairingRequests } = await import("@/lib/hermes-telegram");
    expect(await readHermesPairingRequests(NOW)).toEqual([]);
  });

  it("skips pre-hash legacy entries, which have no approvable id", async () => {
    await writeStore("telegram-pending.json", {
      legacy: { user_id: "5", created_at: NOW / 1000 },
    });
    const { readHermesPairingRequests } = await import("@/lib/hermes-telegram");
    expect(await readHermesPairingRequests(NOW)).toEqual([]);
  });

  it("reads approved users, and merges the legacy store location", async () => {
    await writeStore("telegram-approved.json", { "555000111": { user_name: "Yanko" } });
    await writeStore(
      "telegram-approved.json",
      { "444000222": { user_name: "Legacy" } },
      path.join(home, "pairing"),
    );
    const { readHermesApprovedUsers } = await import("@/lib/hermes-telegram");

    const approved = await readHermesApprovedUsers();
    expect(approved).toEqual(
      expect.arrayContaining([
        { id: "555000111", name: "Yanko" },
        { id: "444000222", name: "Legacy" },
      ]),
    );
  });

  it("returns nothing rather than throwing on a corrupt store", async () => {
    await fs.writeFile(path.join(storeDir, "telegram-pending.json"), "{not json", "utf-8");
    const { readHermesPairingRequests } = await import("@/lib/hermes-telegram");
    expect(await readHermesPairingRequests(NOW)).toEqual([]);
  });
});

// A new bot token means the old bot's approvals must not carry over.
describe("clearHermesTelegramPairingState", () => {
  let home: string;
  let storeDir: string;
  const origHome = process.env.HERMES_HOME;

  beforeEach(async () => {
    vi.resetModules();
    runHermesCliMock.mockReset();
    runHermesCliMock.mockResolvedValue({ code: 0, stdout: "  Revoked access", stderr: "" });
    home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
    storeDir = path.join(home, "platforms", "pairing");
    await fs.mkdir(storeDir, { recursive: true });
    process.env.HERMES_HOME = home;
    await fs.writeFile(
      path.join(storeDir, "telegram-approved.json"),
      JSON.stringify({ "111": { user_name: "One" }, "222": { user_name: "Two" } }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(storeDir, "telegram-pending.json"),
      JSON.stringify({ abcdef0123456789: { hash: "h", salt: "s", user_id: "333" } }),
      "utf-8",
    );
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("revokes every approved sender and clears pending codes", async () => {
    const { clearHermesTelegramPairingState } = await import("@/lib/hermes-telegram");
    await clearHermesTelegramPairingState();

    const invoked = runHermesCliMock.mock.calls.map(([args]) => args);
    expect(invoked).toContainEqual(["pairing", "revoke", "telegram", "111"]);
    expect(invoked).toContainEqual(["pairing", "revoke", "telegram", "222"]);
    expect(invoked).toContainEqual(["pairing", "clear-pending"]);
  });

  it("leaves no store file behind", async () => {
    const { clearHermesTelegramPairingState } = await import("@/lib/hermes-telegram");
    await clearHermesTelegramPairingState();

    await expect(fs.access(path.join(storeDir, "telegram-approved.json"))).rejects.toThrow();
    await expect(fs.access(path.join(storeDir, "telegram-pending.json"))).rejects.toThrow();
  });

  // Hermes rate-limits pairing REQUESTS, not approvals, and `_rate_limits.json`
  // outlives the bot — the mechanism, and why each key goes or stays, is in
  // `isStampClearedByReset` and the comment above it.
  //
  // Left behind, the stamps leave the person whose pending request this reset
  // just cancelled in a hole neither end can see: the request is gone, so "Check
  // for requests" has nothing to show, and their next message is denied in
  // silence — the gateway returns from `_hm_offer_pairing_code` before generating
  // anything and logs one "Unauthorized user" warning, nothing else. Seen on a
  // Hermes box: the bot issued a code and stamped the limit, the save 37 s later
  // removed the pending entry, and the next two messages produced two warnings
  // and no code.
  //
  // Both dirs, because Hermes merges them on start (`_migrate_split_pairing_dirs`),
  // so a stamp left in the legacy copy comes straight back.
  it("drops every requester's stamp and this platform's lockout, in both dirs", async () => {
    const now = Date.now() / 1000;
    const limits = {
      "telegram:333": now,
      "_lockout:telegram": now + 600,
      "_failures:telegram": 3,
      // `pairing clear-pending` takes no platform argument, so this requester's
      // pending code is cancelled by the same reset: they have to be able to ask
      // again too, or the bug just moves to another channel.
      "discord:444": now,
      // Earned by mistyped codes on Discord, not by this Telegram bot.
      "_lockout:discord": now + 600,
    };
    const legacyDir = path.join(home, "pairing");
    await fs.mkdir(legacyDir, { recursive: true });
    for (const dir of [storeDir, legacyDir]) {
      await fs.writeFile(path.join(dir, "_rate_limits.json"), JSON.stringify(limits), {
        mode: 0o600,
      });
    }

    const { clearHermesTelegramPairingState } = await import("@/lib/hermes-telegram");
    await clearHermesTelegramPairingState();

    for (const dir of [storeDir, legacyDir]) {
      const file = path.join(dir, "_rate_limits.json");
      expect(Object.keys(JSON.parse(await fs.readFile(file, "utf-8")))).toEqual([
        "_lockout:discord",
      ]);
      // The file names the people who asked, so it stays 0600 as Hermes writes it.
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      // And no temp file is left beside it.
      expect((await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    }
  });

  it("leaves a store holding nothing of ours exactly as it was", async () => {
    const file = path.join(storeDir, "_rate_limits.json");
    const before = JSON.stringify({ "_lockout:discord": 1, "_failures:discord": 2 });
    await fs.writeFile(file, before, { mode: 0o600 });

    const { clearHermesTelegramPairingState } = await import("@/lib/hermes-telegram");
    await clearHermesTelegramPairingState();

    expect(await fs.readFile(file, "utf-8")).toBe(before);
  });

  // Best-effort like the rest of the reset: the token is saved right after this,
  // and a store Hermes itself reads as `{}` holds no stamp in force either — so
  // this one stays quiet.
  it("leaves a corrupt rate-limit store alone, without a word", async () => {
    const file = path.join(storeDir, "_rate_limits.json");
    await fs.writeFile(file, "{not json", "utf-8");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { clearHermesTelegramPairingState } = await import("@/lib/hermes-telegram");
    await expect(clearHermesTelegramPairingState()).resolves.toBeUndefined();
    expect(await fs.readFile(file, "utf-8")).toBe("{not json");
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  // A clear that could not happen must not pass as one: the route answers
  // `reset: true` either way, the requester stays denied in silence, and without
  // this line the service log holds nothing that explains it.
  it("says so in the log when the store cannot be written", async () => {
    const file = path.join(storeDir, "_rate_limits.json");
    await fs.writeFile(file, JSON.stringify({ "telegram:333": Date.now() / 1000 }), {
      mode: 0o600,
    });
    await fs.chmod(storeDir, 0o500);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { clearHermesTelegramPairingState } = await import("@/lib/hermes-telegram");
      await expect(clearHermesTelegramPairingState()).resolves.toBeUndefined();
      expect(logged.mock.calls.map((args) => String(args[0])).join("\n")).toContain(
        "could not be cleared",
      );
    } finally {
      logged.mockRestore();
      await fs.chmod(storeDir, 0o700);
    }
  });

  // The token is already saved when this runs, so a CLI failure must not throw
  // out of the configure route and report a failed save.
  it("still wipes the store when the CLI fails outright", async () => {
    runHermesCliMock.mockRejectedValue(new Error("hermes timed out"));
    const { clearHermesTelegramPairingState } = await import("@/lib/hermes-telegram");

    await expect(clearHermesTelegramPairingState()).resolves.toBeUndefined();
    await expect(fs.access(path.join(storeDir, "telegram-approved.json"))).rejects.toThrow();
  });
});

// ── The gateway's first-time install, and its retirement ──
//
// `hermes gateway status` output, verbatim shapes: no service, a user service,
// a system service.
const STATUS_NONE = "✗ Gateway is not running\n\nTo start:\n  hermes gateway run\n  hermes gateway install  # Install as user service\n";
const STATUS_USER_RUNNING = "✓ User gateway service is running (PID 4242)\n";
const STATUS_USER_STOPPED = "✗ User gateway service is stopped\n";
const STATUS_SYSTEM_RUNNING = "✓ System gateway service is running (PID 4242)\n";

/** Drive the CLI mock by verb: `status` answers `status`, everything else answers `code`. */
function cliAnswers(status: () => string, code = 0) {
  runHermesCliMock.mockImplementation(async (args: string[]) => {
    if (args[0] === "gateway" && args[1] === "status") return { code: 0, stdout: status(), stderr: "" };
    return { code, stdout: "", stderr: code === 0 ? "" : "refused" };
  });
}
const cliCalls = () => runHermesCliMock.mock.calls.map((c) => (c[0] as string[]).join(" "));
const cliOpts = (verb: string) =>
  runHermesCliMock.mock.calls.find((c) => (c[0] as string[]).join(" ").startsWith(verb))?.[1] as Record<string, unknown> | undefined;
const gatewayLib = () => import("@/lib/hermes-telegram");

describe("ensureHermesGateway — first-time install", () => {
  beforeEach(async () => {
    runHermesCliMock.mockReset();
    execFileMock.mockReset();
    (await gatewayLib()).invalidateHermesGatewayStatus();
  });

  it("falls back to the clawbox user's USER service when the system install is refused", async () => {
    // The sudo'd system install is deliberately ungranted: the CLI answers a
    // non-zero exit. The user service — Hermes' own default — is then installed
    // with no sudo, and reported as installed once status says so.
    let installed = false;
    runHermesCliMock.mockImplementation(async (args: string[], opts?: Record<string, unknown>) => {
      const verb = args.join(" ");
      if (verb === "gateway status") return { code: 0, stdout: installed ? STATUS_USER_RUNNING : STATUS_NONE, stderr: "" };
      if (verb.startsWith("gateway install --system")) return { code: 1, stdout: "", stderr: "sudo: a password is required" };
      if (verb === "gateway install --start-now --start-on-login") {
        expect(opts?.sudo).toBeUndefined();
        installed = true;
        return { code: 0, stdout: "✓ Gateway service installed", stderr: "" };
      }
      throw new Error(`unexpected CLI call: ${verb}`);
    });

    const res = await (await gatewayLib()).ensureHermesGateway();

    expect(res).toMatchObject({ applied: true, installed: true, running: true, scope: "user" });
    expect(cliCalls()).toEqual([
      "gateway status",
      "gateway install --system --run-as-user clawbox --start-now --start-on-login",
      "gateway install --start-now --start-on-login",
      "gateway status",
    ]);
    // A `systemctl --user` from inside a system service needs the user's bus.
    expect((cliOpts("gateway install --start-now")?.env as Record<string, string>).XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
  });

  it("does not install the user service when the system install was granted", async () => {
    let installed = false;
    runHermesCliMock.mockImplementation(async (args: string[]) => {
      const verb = args.join(" ");
      if (verb === "gateway status") return { code: 0, stdout: installed ? STATUS_SYSTEM_RUNNING : STATUS_NONE, stderr: "" };
      if (verb.startsWith("gateway install --system")) { installed = true; return { code: 0, stdout: "", stderr: "" }; }
      throw new Error(`unexpected CLI call: ${verb}`);
    });
    const res = await (await gatewayLib()).ensureHermesGateway();
    expect(res).toMatchObject({ applied: true, scope: "system" });
    expect(cliCalls().filter((c) => c.startsWith("gateway install"))).toHaveLength(1);
  });

  it("reports applied: false when neither install took", async () => {
    cliAnswers(() => STATUS_NONE, 1);
    const res = await (await gatewayLib()).ensureHermesGateway();
    expect(res).toMatchObject({ applied: false, installed: false });
    expect(cliCalls().filter((c) => c.startsWith("gateway install"))).toHaveLength(2);
  });

  it("restarts AND re-enables an installed user service, so it comes back at boot", async () => {
    // install.sh's foreign-edition teardown disables the user unit on the way
    // to OpenClaw; a later swap back must not leave it off after a reboot.
    cliAnswers(() => STATUS_USER_STOPPED);
    execFileSucceeds();
    const res = await (await gatewayLib()).ensureHermesGateway();
    expect(res.applied).toBe(true);
    expect(cliCalls()).toContain("gateway restart");
    const enable = execFileMock.mock.calls.find((c) => (c[1] as string[]).includes("enable"));
    expect(enable?.[0]).toBe("/usr/bin/systemctl");
    expect(enable?.[1]).toEqual(["--user", "enable", "hermes-gateway.service"]);
    expect((enable?.[2] as { env: Record<string, string> }).env.XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
  });

  it("never touches the user bus for a system service", async () => {
    cliAnswers(() => STATUS_SYSTEM_RUNNING);
    execFileSucceeds();
    await (await gatewayLib()).ensureHermesGateway();
    expect(execFileMock.mock.calls.some((c) => (c[1] as string[]).includes("--user"))).toBe(false);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["-n", "/usr/bin/systemctl", "restart", "hermes-gateway.service"]);
  });
});

describe("retireHermesUserGateway", () => {
  beforeEach(async () => {
    runHermesCliMock.mockReset();
    (await gatewayLib()).invalidateHermesGatewayStatus();
  });

  it("uninstalls a user-scope service through the CLI, with the user's bus", async () => {
    cliAnswers(() => STATUS_USER_RUNNING);
    expect(await (await gatewayLib()).retireHermesUserGateway()).toBe(true);
    expect(cliCalls()).toEqual(["gateway status", "gateway uninstall"]);
    expect(cliOpts("gateway uninstall")?.sudo).toBeUndefined();
    expect((cliOpts("gateway uninstall")?.env as Record<string, string>).XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
  });

  it("leaves a SYSTEM service to install.sh's teardown, and a box with none alone", async () => {
    cliAnswers(() => STATUS_SYSTEM_RUNNING);
    expect(await (await gatewayLib()).retireHermesUserGateway()).toBe(true);
    expect(cliCalls()).toEqual(["gateway status"]);
    runHermesCliMock.mockReset();
    cliAnswers(() => STATUS_NONE);
    expect(await (await gatewayLib()).retireHermesUserGateway()).toBe(true);
    expect(cliCalls()).toEqual(["gateway status"]);
  });

  it("answers false when the uninstall failed or the gateway could not be asked", async () => {
    cliAnswers(() => STATUS_USER_RUNNING, 1);
    expect(await (await gatewayLib()).retireHermesUserGateway()).toBe(false);
    runHermesCliMock.mockReset();
    runHermesCliMock.mockRejectedValue(new Error("hermes: timed out"));
    expect(await (await gatewayLib()).retireHermesUserGateway()).toBe(false);
  });
});
