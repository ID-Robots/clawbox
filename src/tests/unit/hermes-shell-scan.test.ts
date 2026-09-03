import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pre-exec shell scanning is the one security control on a Hermes box that can
 * be OFF while nothing anywhere says so.
 *
 * The agent runs every shell command past `tirith` first, but tirith is not
 * shipped — the agent downloads it from a GitHub release into
 * `~/.hermes/bin/tirith` in a background thread, and until that finishes it
 * runs commands unscanned (upstream's default is fail-open). The only trace is
 * one `logger.warning` per process. A factory-reset box used to land exactly
 * there: the wipe took the binary, the box rebooted into AP mode with no
 * internet to re-download it, and the dashboard reported nothing.
 *
 * So this module has to get both halves right:
 *   - it must SAY the scanner is off, and why (no false success);
 *   - it must say nothing at all when the scanner is ready (no false failure),
 *     or the warning is noise within a week.
 */

const HERMES_HOME = "/home/clawbox/.hermes";
const SCANNER = `${HERMES_HOME}/bin/tirith`;
const MARKER = `${HERMES_HOME}/.tirith-install-failed`;

/** Paths that exist as executable regular files, per test. */
let executables = new Set<string>();
/** mtime for the install-failure marker, or null when there is no marker. */
let markerMtimeMs: number | null = null;

const stat = vi.fn(async (p: string) => {
  if (p === MARKER) {
    if (markerMtimeMs === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { mtimeMs: markerMtimeMs, isFile: () => true };
  }
  if (!executables.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return { mtimeMs: 0, isFile: () => true };
});
const access = vi.fn(async (p: string) => {
  if (!executables.has(p)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
});
vi.mock("fs/promises", () => ({ default: { stat: (p: string) => stat(p), access: (p: string) => access(p) } }));

/** ~/.hermes/.env contents (the TIRITH_* overrides live here), or a throw. */
let envFile: Record<string, string> | Error = {};
const readHermesEnv = vi.fn(async () => {
  if (envFile instanceof Error) throw envFile;
  return envFile;
});
vi.mock("@/lib/hermes-env", () => ({
  readHermesEnv: () => readHermesEnv(),
  hermesHome: () => HERMES_HOME,
}));

/** What `hermes config get <key>` answers; "" is an unset key. */
let configValues: Record<string, string> = {};
/** Keys whose read FAILED (a wedged or missing `hermes`), not answered. */
let pendingKeys = new Set<string>();
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGetMany: async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, configValues[k] ?? ""])),
  hermesConfigReadPending: (key: string) => pendingKeys.has(key),
}));

async function readStatus() {
  const { readShellScanStatus } = await import("@/lib/hermes-shell-scan");
  return readShellScanStatus();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  executables = new Set<string>();
  markerMtimeMs = null;
  envFile = {};
  configValues = {};
  pendingKeys = new Set<string>();
  // Nothing named tirith on this process's PATH, so ~/.hermes/bin decides.
  vi.stubEnv("PATH", "/nowhere/bin");
  vi.stubEnv("HOME", "/home/clawbox");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readShellScanStatus — the scanner is missing", () => {
  it("reports scanning OFF, and that the scanner is not installed", async () => {
    const status = await readStatus();

    expect(status.state).toBe("off");
    expect(status.reason).toBe("not-installed");
    // Upstream's default: the command still runs, just unscanned. The dashboard
    // needs this to word the warning honestly.
    expect(status.failOpen).toBe(true);
    expect(status.scannerPath).toBeNull();
  });

  it("reports the 24 h retry suppression that keeps a box unscanned after it is back online", async () => {
    // Upstream writes ~/.hermes/.tirith-install-failed when a download fails
    // and then skips the network retry for 24 hours — so plugging the box in
    // does not fix it straight away, and the owner has to be told that.
    markerMtimeMs = Date.now() - 60_000;

    const status = await readStatus();

    expect(status.state).toBe("off");
    expect(status.retrySuppressedUntil).not.toBeNull();
    expect(Date.parse(status.retrySuppressedUntil!)).toBeGreaterThan(Date.now());
  });

  it("does not report a retry suppression once the marker has aged out", async () => {
    markerMtimeMs = Date.now() - 25 * 60 * 60 * 1000;

    expect((await readStatus()).retrySuppressedUntil).toBeNull();
  });

  it("says the agent blocks commands instead when the box is set to fail closed", async () => {
    // `security.tirith_fail_open: false` is upstream's own deny-until-ready
    // mode. The consequence for the owner is the opposite one — commands stop
    // working — so the two cases must not share a sentence.
    configValues["security.tirith_fail_open"] = "false";

    const status = await readStatus();

    expect(status.state).toBe("off");
    expect(status.failOpen).toBe(false);
  });
});

describe("readShellScanStatus — the scanner is ready", () => {
  it("reports scanning ON and says nothing is wrong", async () => {
    // The false-failure half: a box that is online with the scanner installed
    // must not be warned at.
    executables.add(SCANNER);

    const status = await readStatus();

    expect(status.state).toBe("on");
    expect(status.reason).toBe("ok");
    expect(status.scannerPath).toBe(SCANNER);
    expect(status.retrySuppressedUntil).toBeNull();
  });

  it("finds a scanner at an explicitly configured path", async () => {
    configValues["security.tirith_path"] = "/opt/tirith/tirith";
    executables.add("/opt/tirith/tirith");

    expect((await readStatus()).scannerPath).toBe("/opt/tirith/tirith");
  });

  it("honours the TIRITH_BIN env override, which is not called TIRITH_PATH", async () => {
    // Upstream's asymmetry: the config key is `tirith_path`, the env var is
    // `TIRITH_BIN`. Reading the wrong name would report a missing scanner on a
    // box that has one.
    envFile = { TIRITH_BIN: "/opt/custom/scan" };
    executables.add("/opt/custom/scan");

    expect((await readStatus()).scannerPath).toBe("/opt/custom/scan");
  });
});

describe("readShellScanStatus — turned off on purpose, and not knowable", () => {
  it("distinguishes 'switched off in the config' from 'never downloaded'", async () => {
    configValues["security.tirith_enabled"] = "false";
    executables.add(SCANNER);

    const status = await readStatus();

    expect(status.state).toBe("off");
    expect(status.reason).toBe("disabled-by-config");
  });

  it("treats TIRITH_ENABLED the way upstream's _env_bool does", async () => {
    // Anything that is not 1/true/yes is false upstream — including "on".
    envFile = { TIRITH_ENABLED: "on" };
    executables.add(SCANNER);

    expect((await readStatus()).reason).toBe("disabled-by-config");
  });

  it("answers 'unknown', never 'on', when the agent's config could not be read", async () => {
    // A wedged or missing `hermes` leaves the cache holding a failed READ, not
    // an answer. Falling back to the defaults there would report a scanner that
    // is enabled and present on a box nobody has actually asked — the exact
    // false success this whole surface exists to prevent.
    executables.add(SCANNER);
    pendingKeys.add("security.tirith_enabled");

    const status = await readStatus();

    expect(status.state).toBe("unknown");
    expect(status.reason).toBe("config-unreadable");
  });

  it("answers 'unknown' when ~/.hermes/.env cannot be read", async () => {
    // An unreadable .env could be hiding a TIRITH_* override either way.
    executables.add(SCANNER);
    envFile = Object.assign(new Error("EACCES"), { code: "EACCES" });

    expect((await readStatus()).state).toBe("unknown");
  });
});
