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
/** False models a fifo/directory where config.yaml should be. */
let configIsRegularFile = true;
/** Overrides the reported size, for the too-large guard. */
let configSize: number | null = null;

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

const stat = vi.fn(async (p: string) => {
  if (directories.has(p)) return { mtimeMs: 0, isFile: () => false };
  if (executables.has(p) || plainFiles.has(p)) return { mtimeMs: 0, isFile: () => true };
  throw enoent();
});
/**
 * The marker is read through ONE descriptor — its age and its reason together
 * decide what the owner is told, and reading them by name twice is a TOCTOU
 * (CodeQL js/file-system-race). The mock mirrors that: no `stat(MARKER)` path
 * exists, so a regression back to stat-then-read fails here.
 */
const open = vi.fn(async (p: string) => {
  if (p === CONFIG) {
    if (configText === null) throw enoent();
    if (configText instanceof Error) throw configText;
    const text = configText;
    return {
      stat: async () => ({ mtimeMs: 0, size: configSize ?? text.length, isFile: () => configIsRegularFile }),
      readFile: async () => text,
      close: async () => {},
    };
  }
  if (p !== MARKER || markerMtimeMs === null) throw enoent();
  const mtimeMs = markerMtimeMs;
  return {
    stat: async () => ({ mtimeMs, size: markerReason.length, isFile: () => true }),
    readFile: async () => markerReason,
    close: async () => {},
  };
});
const access = vi.fn(async (p: string) => {
  if (!executables.has(p)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
});
/**
 * `fs.readFile` is deliberately ABSENT from this mock. config.yaml and the
 * marker are both read through one descriptor opened O_NONBLOCK — a fifo
 * planted in either path by the agent (which runs as the same user) would
 * otherwise park the status route forever — so a regression to a plain
 * path-based read fails here with "not a function" instead of passing quietly.
 */
vi.mock("fs/promises", () => ({
  default: {
    stat: (p: string) => stat(p),
    access: (p: string) => access(p),
    open: (p: string) => open(p),
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
  configIsRegularFile = true;
  configSize = null;
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
    executables.add("/usr/bin/cosign");

    expect((await readStatus()).retrySuppressedUntil).toBeNull();
  });

  it("keeps the 24 h claim for a cosign_missing marker when cosign is not installed", async () => {
    // Upstream drops that marker only once cosign is actually on PATH; without
    // it the suppression stands like any other, and telling the owner to plug
    // the box in would be a false failure.
    markerMtimeMs = Date.now() - 60_000;
    markerReason = "cosign_missing";

    expect((await readStatus()).retrySuppressedUntil).not.toBeNull();
  });

  it("does not promise a download retry for an explicitly configured path", async () => {
    // Upstream never auto-downloads on the explicit branch, so a stale marker
    // from an earlier default-path era must not produce "will retry after…".
    configText = securityYaml('  tirith_path: "/opt/tirith/tirith"\n');
    markerMtimeMs = Date.now() - 60_000;

    const status = await readStatus();

    expect(status.reason).toBe("not-installed");
    expect(status.retrySuppressedUntil).toBeNull();
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

/**
 * Upstream never parses these keys as booleans. `_load_security_config` hands
 * the YAML value through untouched and the call sites apply plain Python
 * truthiness — `if not cfg["tirith_enabled"]` skips scanning outright, and
 * `if fail_open` decides between allowing and BLOCKING. So every value Python
 * calls false has to read as false here, including the shapes a truncated write
 * or a hand edit actually produces. Reading them as "unset" and substituting a
 * default is how a security control ends up reported as on while the agent is
 * not scanning at all.
 */
describe("readShellScanStatus — a present-but-falsy setting is not an unset one", () => {
  const FALSY = ["null", "~", '""', "0", "[]", "{}"];

  for (const value of FALSY) {
    it(`reads tirith_enabled: ${value} as OFF, not as the default ON`, async () => {
      configText = securityYaml(`  tirith_enabled: ${value}\n`);
      executables.add(SCANNER);

      const status = await readStatus();

      expect(status.state).toBe("off");
      expect(status.reason).toBe("disabled-by-config");
    });

    it(`reads tirith_fail_open: ${value} as fail-CLOSED, not as the default fail-open`, async () => {
      // The two outcomes are opposites: fail-open runs the command unchecked,
      // fail-closed refuses to run it. Getting this backwards tells the owner
      // his commands are running while the agent is blocking every one.
      configText = securityYaml(`  tirith_fail_open: ${value}\n`);

      expect((await readStatus()).failOpen).toBe(false);
    });
  }

  it("reads a key written with no value at all as OFF", async () => {
    // `tirith_enabled:` — a truncated write or a templated blank. YAML reads it
    // as null, which Python calls false; `getYamlPath` alone cannot tell it
    // apart from an absent key.
    configText = securityYaml("  tirith_enabled:\n");
    executables.add(SCANNER);

    expect((await readStatus()).reason).toBe("disabled-by-config");
  });

  it("keeps upstream's default when the key really is absent", async () => {
    // The other side of the same coin: no key at all still means enabled.
    configText = securityYaml("  redact_secrets: true\n");
    executables.add(SCANNER);

    expect((await readStatus()).state).toBe("on");
  });

  it("treats an unrecognised word as TRUE, the way Python does", async () => {
    // `if not "maybe"` is false in Python — a non-empty string is truthy.
    configText = securityYaml("  tirith_enabled: maybe\n");
    executables.add(SCANNER);

    expect((await readStatus()).state).toBe("on");
  });
});

describe("readShellScanStatus — config.yaml is read the hardened way", () => {
  it("refuses a config.yaml that is not a regular file instead of hanging on it", async () => {
    // The agent runs as the same user and can write ~/.hermes. A fifo planted
    // where config.yaml belongs would park a plain read in open(2) with no
    // writer, and this read sits inside the status route's Promise.all — the
    // request would never settle and the card would hang empty forever.
    configIsRegularFile = false;
    executables.add(SCANNER);

    expect((await readStatus()).state).toBe("unknown");
  });

  it("refuses a config.yaml far too large to be one", async () => {
    configSize = 8 * 1024 * 1024;
    executables.add(SCANNER);

    expect((await readStatus()).state).toBe("unknown");
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
