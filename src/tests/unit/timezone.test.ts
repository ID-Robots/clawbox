import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as childProcess from "child_process";

/**
 * The system timezone model (src/lib/timezone.ts, TASK-514).
 *
 * Same shape as system-profile.test.ts: the child process is mocked, because
 * what is under test is the CONTRACT between the library and the root-owned
 * helper — which argv is sent, which of the three modes goes through sudo and
 * which do not, what happens when the installed copy is missing or the script
 * prints something that is not a status object.
 *
 * The argv assertion is the load-bearing one. scripts/check-sudoers-coverage.sh
 * declares this exact command line and matches the sudoers grant against it, so
 * a change here that nobody noticed would either break the grant (a password
 * prompt nobody can answer) or widen it.
 */

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  // execFile only: the last describe in this file runs the real script through
  // the real spawnSync, which is the point of it.
  return { ...actual, execFile: vi.fn() };
});

const REPO = path.resolve(__dirname, "../../..");

/** Queue of (cmd, argv) -> stdout, matched on the joined command line. */
let responses: { match: string; stdout?: string; error?: Error }[] = [];
const calls: { cmd: string; argv: string[] }[] = [];

function installExecFileMock(mock: typeof childProcess.execFile) {
  vi.mocked(mock).mockImplementation(((
    cmd: string,
    argv: string[],
    _opts: object,
    cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push({ cmd, argv });
    const line = `${cmd} ${argv.join(" ")}`;
    const hit = responses.find((r) => line.includes(r.match));
    if (cb) {
      if (hit?.error) cb(hit.error, { stdout: "", stderr: "" });
      else cb(null, { stdout: hit?.stdout ?? "", stderr: "" });
    }
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

const UTC_JSON = JSON.stringify({
  supported: true, timezone: "Etc/UTC", localTime: "2026-09-03 10:11:38",
  utcOffset: "+0000", ntpSynchronized: true,
});
const SOFIA_JSON = JSON.stringify({
  supported: true, timezone: "Europe/Sofia", localTime: "2026-09-03 13:11:38",
  utcOffset: "+0300", ntpSynchronized: true,
});

let libexec: string;
let tz: typeof import("@/lib/timezone");

/**
 * Re-import the module with whatever CLAWBOX_LIBEXEC_DIR is set to right now —
 * the path resolves at load — and re-arm the freshly created execFile mock so a
 * call made by the fresh graph is still recorded and still answers its callback.
 */
async function loadFresh(): Promise<typeof import("@/lib/timezone")> {
  vi.resetModules();
  const cp = await import("child_process");
  installExecFileMock(cp.execFile);
  return await import("@/lib/timezone");
}

beforeAll(async () => {
  libexec = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-libexec-"));
  fs.writeFileSync(path.join(libexec, "clawbox-timezone.sh"), "#!/bin/sh\n", { mode: 0o755 });
  process.env.CLAWBOX_LIBEXEC_DIR = libexec;
  vi.resetModules();
  tz = await import("@/lib/timezone");
});

afterAll(() => {
  delete process.env.CLAWBOX_LIBEXEC_DIR;
  fs.rmSync(libexec, { recursive: true, force: true });
});

beforeEach(() => {
  responses = [];
  calls.length = 0;
  installExecFileMock(childProcess.execFile);
});

/**
 * Everything a zone name must never be. Shared with the route test and with the
 * root-owned copy of the gate at the bottom of this file — the three have to
 * agree, because only the last of them is a privilege boundary.
 */
const JUNK_ZONES = [
  "../../etc",
  "/etc/passwd",
  "Europe/Sofia; id",
  "Europe/Sofia\u0000",
  "",
  "e".repeat(200),
  "europe/sofia ",
  "Europe/Sofia/",
];

describe("isValidTimezoneName", () => {
  it("accepts a plain IANA zone name, however deep or oddly spelled", () => {
    for (const good of ["Europe/Sofia", "UTC", "America/Argentina/ComodRivadavia", "Etc/GMT+3"]) {
      expect(tz.isValidTimezoneName(good), good).toBe(true);
    }
  });

  it("refuses anything that could be a path, a second argument or a novel", () => {
    for (const bad of JUNK_ZONES) {
      expect(tz.isValidTimezoneName(bad), JSON.stringify(bad)).toBe(false);
    }
    // A name one character over the ceiling, and everything that is not a string.
    expect(tz.isValidTimezoneName("A".repeat(65))).toBe(false);
    for (const bad of [123, true, null, undefined, ["Europe/Sofia"], {}]) {
      expect(tz.isValidTimezoneName(bad), String(bad)).toBe(false);
    }
  });
});

describe("setTimezone", () => {
  it("spawns exactly the command line the sudoers grant is matched against", async () => {
    responses = [{ match: "--set", stdout: SOFIA_JSON }];
    await tz.setTimezone("Europe/Sofia");
    // Byte for byte: scripts/check-sudoers-coverage.sh declares this argv.
    expect(calls).toEqual([
      {
        cmd: "/usr/bin/sudo",
        argv: ["-n", path.join(libexec, "clawbox-timezone.sh"), "--set", "Europe/Sofia"],
      },
    ]);
  });

  it("returns the state read back from the box, not the zone it was asked for", async () => {
    responses = [{ match: "--set", stdout: SOFIA_JSON }];
    expect(await tz.setTimezone("Europe/Sofia")).toEqual({
      supported: true, timezone: "Europe/Sofia", localTime: "2026-09-03 13:11:38",
      utcOffset: "+0300", ntpSynchronized: true,
    });
  });

  it("refuses an invalid zone before a shell is involved at all", async () => {
    for (const bad of JUNK_ZONES) {
      await expect(tz.setTimezone(bad), JSON.stringify(bad)).rejects.toThrow(/Invalid timezone/);
    }
    expect(calls).toEqual([]);
  });

  it("throws TimezoneUnavailableError when the root-owned copy is missing", async () => {
    process.env.CLAWBOX_LIBEXEC_DIR = path.join(libexec, "nope");
    try {
      const fresh = await loadFresh();
      await expect(fresh.setTimezone("Europe/Sofia")).rejects.toBeInstanceOf(fresh.TimezoneUnavailableError);
      // The repo copy is never accepted for the privileged mode: it is
      // clawbox-writable, so a grant naming it could never be safe.
      expect(calls).toEqual([]);
    } finally {
      process.env.CLAWBOX_LIBEXEC_DIR = libexec;
      vi.resetModules();
    }
  });
});

describe("readTimezone", () => {
  it("runs --check with no sudo at all", async () => {
    responses = [{ match: "--check", stdout: UTC_JSON }];
    const status = await tz.readTimezone();
    expect(status).toMatchObject({ supported: true, timezone: "Etc/UTC", utcOffset: "+0000" });
    expect(calls[0].cmd).toBe(path.join(libexec, "clawbox-timezone.sh"));
    expect(calls[0].argv).toEqual(["--check"]);
    // The split is the whole point: one action needs a privilege, reading does
    // not, so the sudo surface stays at exactly one command line.
    expect(calls.some((c) => c.cmd === "sudo" || c.cmd === "/usr/bin/sudo")).toBe(false);
  });

  it("takes the LAST JSON object, so --set's own status parses too", async () => {
    responses = [{ match: "--check", stdout: `Local time: whatever\n${UTC_JSON}\n${SOFIA_JSON}\n` }];
    expect((await tz.readTimezone()).timezone).toBe("Europe/Sofia");
  });

  it("fails loudly when the helper printed no status object", async () => {
    responses = [{ match: "--check", stdout: "Segmentation fault\n" }];
    await expect(tz.readTimezone()).rejects.toThrow(/no status output/);
  });

  it("falls back to the fields' defaults for a half-written status", async () => {
    responses = [{ match: "--check", stdout: "{}" }];
    expect(await tz.readTimezone()).toEqual({
      supported: false, timezone: tz.DEFAULT_TIMEZONE, localTime: "",
      utcOffset: "", ntpSynchronized: false,
    });
  });

  it("falls back to the repo copy so a dev machine still shows a zone", async () => {
    const previousRoot = process.env.CLAWBOX_ROOT;
    process.env.CLAWBOX_LIBEXEC_DIR = path.join(libexec, "nope");
    process.env.CLAWBOX_ROOT = REPO;
    try {
      const fresh = await loadFresh();
      responses = [{ match: "--check", stdout: UTC_JSON }];
      expect((await fresh.readTimezone()).timezone).toBe("Etc/UTC");
      expect(calls[0].cmd).toBe(path.join(REPO, "scripts", "clawbox-timezone.sh"));
      expect(calls.some((c) => c.cmd === "sudo" || c.cmd === "/usr/bin/sudo")).toBe(false);
    } finally {
      process.env.CLAWBOX_LIBEXEC_DIR = libexec;
      if (previousRoot === undefined) delete process.env.CLAWBOX_ROOT;
      else process.env.CLAWBOX_ROOT = previousRoot;
      vi.resetModules();
    }
  });
});

describe("listTimezones", () => {
  it("runs --list with no sudo and keeps only well-formed names", async () => {
    responses = [{
      match: "--list",
      stdout: "Europe/Sofia\n  UTC  \n\nzone.tab\n../../etc\nAmerica/Argentina/ComodRivadavia\n",
    }];
    expect(await tz.listTimezones()).toEqual([
      "Europe/Sofia", "UTC", "America/Argentina/ComodRivadavia",
    ]);
    expect(calls[0].cmd).toBe(path.join(libexec, "clawbox-timezone.sh"));
    expect(calls[0].argv).toEqual(["--list"]);
    expect(calls.some((c) => c.cmd === "sudo" || c.cmd === "/usr/bin/sudo")).toBe(false);
  });
});

/**
 * The gate that actually holds.
 *
 * src/lib/timezone.ts turns junk into a 400 before a shell exists, but a caller
 * that is not the web server never passes through it — sudo runs THIS script
 * with whatever argv it was handed. So the same table is pushed at the real
 * file.
 *
 * Only refusals are exercised. A --set with a VALID zone would change this
 * machine's clock.
 */
const SCRIPT = path.join(REPO, "scripts", "clawbox-timezone.sh");
const BASH = "/bin/bash";
const CAN_RUN = fs.existsSync(SCRIPT) && fs.existsSync(BASH);
const d = CAN_RUN ? describe : describe.skip;

function runScript(args: string[]): { status: number; stdout: string } {
  try {
    const r = childProcess.spawnSync(BASH, [SCRIPT, ...args], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "" };
  } catch {
    // Node refuses to spawn an argument containing a NUL byte at all, so the
    // zone never reaches the shell. That is the same "not applied".
    return { status: -1, stdout: "" };
  }
}

function liveZone(): string {
  const { stdout } = runScript(["--check"]);
  const line = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  return line ? String((JSON.parse(line) as { timezone?: unknown }).timezone ?? "") : "";
}

d("scripts/clawbox-timezone.sh", () => {
  it("refuses every junk zone and leaves the clock where it was", () => {
    const before = liveZone();
    expect(before).not.toBe("");

    for (const bad of JUNK_ZONES) {
      const { status, stdout } = runScript(["--set", bad]);
      expect(status, JSON.stringify(bad)).not.toBe(0);
      // print_status is only reached after timedatectl succeeded, so a status
      // object in stdout would mean the zone was applied.
      expect(stdout, JSON.stringify(bad)).not.toContain("{");
    }

    expect(liveZone()).toBe(before);
  });

  it("refuses --set without a zone, and any mode it does not implement", () => {
    expect(runScript(["--set"]).status).not.toBe(0);
    expect(runScript(["--set", "Europe/Sofia", "extra"]).status).not.toBe(0);
    expect(runScript(["--enable"]).status).not.toBe(0);
    expect(runScript([]).status).not.toBe(0);
  });

  it("answers --check with a status object and changes nothing", () => {
    const { status, stdout } = runScript(["--check"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout.trim().split("\n").pop()!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ["localTime", "ntpSynchronized", "supported", "timezone", "utcOffset"],
    );
    expect(typeof parsed.timezone).toBe("string");
  });
});

/**
 * Found on the device, not in review: POSTing "Europe/Nowhere" answered 500
 * with `Command failed: /usr/bin/sudo -n /usr/local/libexec/clawbox/...` in the
 * `error` field. Wrong status — a zone the tz database does not have is the
 * caller's mistake — and the box's sudo command line in a string the UI shows.
 * The exit codes below are the contract with scripts/clawbox-timezone.sh.
 */
describe("a well-formed zone the box does not have", () => {
  const refusal = () => Object.assign(
    new Error(
      "Command failed: /usr/bin/sudo -n /usr/local/libexec/clawbox/clawbox-timezone.sh --set Europe/Nowhere",
    ),
    { code: 3, stderr: "unknown timezone: Europe/Nowhere\n", stdout: "" },
  );

  it("is an InvalidTimezoneError, so the route can answer 400 rather than 500", async () => {
    responses = [{ match: "--set Europe/Nowhere", error: refusal() }];
    // Shape-valid, so isValidTimezoneName lets it through — only the helper,
    // which owns the tz database, can refuse it.
    expect(tz.isValidTimezoneName("Europe/Nowhere")).toBe(true);
    await expect(tz.setTimezone("Europe/Nowhere")).rejects.toBeInstanceOf(tz.InvalidTimezoneError);
  });

  it("carries the helper's own sentence and never the sudo command line", async () => {
    responses = [{ match: "--set Europe/Nowhere", error: refusal() }];
    await expect(tz.setTimezone("Europe/Nowhere")).rejects.toThrow("unknown timezone: Europe/Nowhere");
    responses = [{ match: "--set Europe/Nowhere", error: refusal() }];
    await expect(tz.setTimezone("Europe/Nowhere")).rejects.not.toThrow(/sudo|libexec/);
  });

  it("maps exit 4 to TimezoneUnavailableError, so a box with no timedatectl is a 503", async () => {
    responses = [{
      match: "--set Europe/Sofia",
      error: Object.assign(new Error("Command failed"), {
        code: 4, stderr: "timedatectl is not available on this system\n", stdout: "",
      }),
    }];
    await expect(tz.setTimezone("Europe/Sofia")).rejects.toBeInstanceOf(tz.TimezoneUnavailableError);
  });

  it("keeps any other failure a plain Error, so the route still answers 500", async () => {
    responses = [{
      match: "--set Europe/Sofia",
      error: Object.assign(new Error("Command failed"), {
        code: 5, stderr: "timedatectl set-timezone failed for Europe/Sofia\n", stdout: "",
      }),
    }];
    const err = await tz.setTimezone("Europe/Sofia").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(tz.InvalidTimezoneError);
    expect(err).not.toBeInstanceOf(tz.TimezoneUnavailableError);
  });
});
