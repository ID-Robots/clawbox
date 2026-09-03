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
 *   - it must say nothing at all when the scanner is installed (no false
 *     failure), or the warning is noise within a week.
 *
 * `yaml-block-edit` is NOT mocked: the config values come out of real YAML text,
 * so a test cannot pass because a fixture handed the module the answer.
 */

const HOME = "/home/clawbox";
const HERMES_HOME = `${HOME}/.hermes`;
const CONFIG = `${HERMES_HOME}/config.yaml`;
const SCANNER = `${HERMES_HOME}/bin/tirith`;
const MARKER = `${HERMES_HOME}/.tirith-install-failed`;
/** The FIRST entry of the agent's own PATH (its unit file), not this process's. */
const AGENT_PATH_SCANNER = `${HOME}/.local/bin/tirith`;

/** Executable regular files. */
let executables = new Set<string>();
/** Regular files that exist but are not executable. */
let plainFiles = new Set<string>();
/** Paths that stat as directories. */
let directories = new Set<string>();
/** mtime for the install-failure marker, or null when there is no marker. */
let markerMtimeMs: number | null = null;
/** Contents of the install-failure marker (upstream stores a reason tag). */
let markerReason = "";
/** ~/.hermes/config.yaml, or null for "no such file", or an Error to throw. */
let configText: string | null | Error = "";

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

const stat = vi.fn(async (p: string) => {
  if (p === MARKER) {
    if (markerMtimeMs === null) throw enoent();
    return { mtimeMs: markerMtimeMs, isFile: () => true };
  }
  if (directories.has(p)) return { mtimeMs: 0, isFile: () => false };
  if (executables.has(p) || plainFiles.has(p)) return { mtimeMs: 0, isFile: () => true };
  throw enoent();
});
const access = vi.fn(async (p: string) => {
  if (!executables.has(p)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
});
const readFile = vi.fn(async (p: string) => {
  if (p === CONFIG) {
    if (configText === null) throw enoent();
    if (configText instanceof Error) throw configText;
    return configText;
  }
  if (p === MARKER) {
    if (markerMtimeMs === null) throw enoent();
    return markerReason;
  }
  throw enoent();
});
vi.mock("fs/promises", () => ({
  default: {
    stat: (p: string) => stat(p),
    access: (p: string) => access(p),
    readFile: (p: string) => readFile(p),
  },
}));

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
vi.mock("@/lib/hermes-config-yaml", () => ({ hermesConfigPath: () => CONFIG }));

async function readStatus() {
  const { readShellScanStatus } = await import("@/lib/hermes-shell-scan");
  return readShellScanStatus();
}

/** The shipped config's security block, as it really appears in config.yaml. */
const securityYaml = (body: string) => `agent:\n  name: hermes\n\nsecurity:\n${body}`;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  executables = new Set<string>();
  plainFiles = new Set<string>();
  directories = new Set<string>();
  markerMtimeMs = null;
  markerReason = "";
  configText = "";
  envFile = {};
  vi.stubEnv("HOME", HOME);
  // Deliberately NOT the agent's PATH. Nothing in this module may read it.
  vi.stubEnv("PATH", "/nowhere/bin");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readShellScanStatus — the scanner is missing", () => {
  it("reports scanning OFF, and that the scanner is not installed", async () => {
    const status = await readStatus();

    expect(status.state).toBe("off");
    expect(status.reason).toBe("not-installed");
    // Upstream's default: the command still runs, just unscanned. The card
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
    expect(Date.parse(status.retrySuppressedUntil!)).toBeGreaterThan(Date.now());
  });

  it("does not report a retry suppression once the marker has aged out", async () => {
    markerMtimeMs = Date.now() - 25 * 60 * 60 * 1000;

    expect((await readStatus()).retrySuppressedUntil).toBeNull();
  });

  it("does not claim a 24 h wait for the one reason upstream clears early", async () => {
    // A `cosign_missing` marker is dropped as soon as cosign is on PATH, and
    // the download is retried on the next command — telling the owner to wait
    // a day for that would be a false failure.
    markerMtimeMs = Date.now() - 60_000;
    markerReason = "cosign_missing";

    expect((await readStatus()).retrySuppressedUntil).toBeNull();
  });

  it("says the agent blocks commands instead when the box is set to fail closed", async () => {
    // `security.tirith_fail_open: false` is upstream's own deny-until-ready
    // mode. The consequence for the owner is the opposite one — commands stop
    // working — so the two cases must not share a sentence.
    configText = securityYaml("  tirith_fail_open: false\n");

    const status = await readStatus();

    expect(status.state).toBe("off");
    expect(status.failOpen).toBe(false);
  });

  it("does not mistake a directory named tirith for the scanner", async () => {
    directories.add(SCANNER);

    expect((await readStatus()).state).toBe("off");
  });

  it("does not mistake a present-but-not-executable file for the scanner", async () => {
    // A truncated or wrong-mode download is not a scanner the agent can spawn.
    plainFiles.add(SCANNER);

    expect((await readStatus()).state).toBe("off");
  });
});

describe("readShellScanStatus — the scanner is installed", () => {
  it("reports it as on and says nothing is wrong", async () => {
    // The false-failure half: a box that is online with the scanner installed
    // must not be warned at.
    executables.add(SCANNER);

    const status = await readStatus();

    expect(status.state).toBe("on");
    expect(status.reason).toBe("ok");
    expect(status.scannerPath).toBe(SCANNER);
    expect(status.retrySuppressedUntil).toBeNull();
  });

  it("looks on the AGENT's PATH, not the web server's", async () => {
    // The agent's unit pins PATH=~/.local/bin:/usr/local/bin:/usr/bin:/bin; the
    // web server's unit sets none and inherits systemd's default, which has no
    // ~/.local/bin. Reading process.env.PATH here would paint a warning on a
    // box whose agent resolves the scanner perfectly well.
    executables.add(AGENT_PATH_SCANNER);

    expect((await readStatus()).scannerPath).toBe(AGENT_PATH_SCANNER);
  });

  it("finds a scanner at an explicitly configured absolute path", async () => {
    configText = securityYaml('  tirith_path: "/opt/tirith/tirith"\n');
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

  it("does not satisfy an explicitly configured name from the agent's download directory", async () => {
    // Upstream splits on the VALUE, not the shape: anything but the bare
    // "tirith" is explicit and authoritative, and the explicit branch never
    // looks in $HERMES_HOME/bin. A leftover binary of that name there means the
    // agent is NOT scanning, so reporting "on" would be a false success.
    configText = securityYaml('  tirith_path: "tirith-v2"\n');
    executables.add(`${HERMES_HOME}/bin/tirith-v2`);

    const status = await readStatus();

    expect(status.state).toBe("off");
    expect(status.reason).toBe("not-installed");
  });
});

describe("readShellScanStatus — turned off on purpose, and not knowable", () => {
  it("distinguishes 'switched off in the config' from 'never downloaded'", async () => {
    configText = securityYaml("  tirith_enabled: false\n");
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

  it("applies upstream's defaults when the box has no config.yaml at all", async () => {
    // A box before its first boot. Upstream swallows the missing file and uses
    // its defaults, so this is an answer, not an "unknown".
    configText = null;
    executables.add(SCANNER);

    expect((await readStatus()).state).toBe("on");
  });

  it("answers 'unknown', never 'on', when the agent's config could not be read", async () => {
    // An unreadable config.yaml (EACCES after a root-owned write, EIO on a
    // failing eMMC) could be hiding `tirith_enabled: false` or a path this box
    // does not have. Falling back to the defaults there would assert a setting
    // nobody read — the exact false success this surface exists to prevent.
    executables.add(SCANNER);
    configText = Object.assign(new Error("EACCES"), { code: "EACCES" });

    const status = await readStatus();

    expect(status.state).toBe("unknown");
    expect(status.reason).toBe("config-unreadable");
  });

  it("still answers 'off' when the .env settles it and only config.yaml is unreadable", async () => {
    // TIRITH_ENABLED=0 is decisive on its own. Under-reporting a known-bad
    // state as "unknown" is the same failure as over-reporting a good one.
    configText = Object.assign(new Error("EACCES"), { code: "EACCES" });
    envFile = { TIRITH_ENABLED: "0" };
    executables.add(SCANNER);

    const status = await readStatus();

    expect(status.state).toBe("off");
    expect(status.reason).toBe("disabled-by-config");
  });

  it("answers 'unknown' when ~/.hermes/.env cannot be read", async () => {
    // An unreadable .env could be hiding a TIRITH_* override either way.
    executables.add(SCANNER);
    envFile = Object.assign(new Error("EACCES"), { code: "EACCES" });

    expect((await readStatus()).state).toBe("unknown");
  });
});
