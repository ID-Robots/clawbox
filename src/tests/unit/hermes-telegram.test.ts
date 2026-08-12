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
    });
  });

  it("reports an installed but stopped service", async () => {
    const { parseHermesGatewayStatus } = await import("@/lib/hermes-telegram");
    expect(parseHermesGatewayStatus(GATEWAY_SERVICE_STOPPED)).toEqual({
      installed: true,
      running: false,
      scope: "system",
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
    });
  });

  it("reports a manually-run gateway as running but not installed", async () => {
    const { parseHermesGatewayStatus } = await import("@/lib/hermes-telegram");
    expect(parseHermesGatewayStatus(GATEWAY_MANUAL_RUNNING)).toEqual({
      installed: false,
      running: true,
      scope: null,
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

  it("restarts an installed system service as root instead of reinstalling", async () => {
    runHermesCliMock
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_SERVICE_STOPPED, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "✓ System service restarted", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: GATEWAY_SERVICE_RUNNING, stderr: "" });

    const { ensureHermesGateway } = await import("@/lib/hermes-telegram");
    await ensureHermesGateway();

    const [args, opts] = runHermesCliMock.mock.calls[1];
    expect(args).toEqual(["gateway", "restart", "--system"]);
    expect(opts.sudo).toBe(true);
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

  // The token is already saved when this runs, so a CLI failure must not throw
  // out of the configure route and report a failed save.
  it("still wipes the store when the CLI fails outright", async () => {
    runHermesCliMock.mockRejectedValue(new Error("hermes timed out"));
    const { clearHermesTelegramPairingState } = await import("@/lib/hermes-telegram");

    await expect(clearHermesTelegramPairingState()).resolves.toBeUndefined();
    await expect(fs.access(path.join(storeDir, "telegram-approved.json"))).rejects.toThrow();
  });
});
