import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Install-time and unit-file invariants for TASK-456 (observability).
 *
 * Each block below pins a behaviour that was measured wrong on a shipped device:
 *   - the journal was volatile, so every reboot destroyed the whole log
 *   - a clean SIGTERM stop was recorded as `Failed with result 'exit-code'`
 *   - production-server.js had no signal handling at all
 *   - run-tunnel.sh's pipeline returned 143 on a user-requested stop
 *
 * They are file-content assertions because the thing being fixed IS a file the
 * installer copies to /etc — there is no runtime seam to test instead.
 */

const REPO = process.cwd();
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf-8");

const INSTALL_SH = read("install.sh");
const SETUP_UNIT = read("config/clawbox-setup.service");
const TUNNEL_UNIT = read("config/clawbox-tunnel.service");
const JOURNALD_CONF = read("config/journald-clawbox.conf");
const RUN_TUNNEL_SH = read("scripts/run-tunnel.sh");
const PRODUCTION_SERVER = read("production-server.js");

/** Value of a systemd `Key=` directive, ignoring commented-out lines. */
function directive(unit: string, key: string): string | null {
  for (const line of unit.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith(`${key}=`)) return trimmed.slice(key.length + 1).trim();
  }
  return null;
}

function extractShellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end);
}

describe("a clean stop is not reported as a failure", () => {
  // Measured on the box: `systemctl show clawbox-setup.service -p SuccessExitStatus`
  // was empty, KillSignal was 15, and the journal already held
  //   Main process exited, code=exited, status=143/n/a
  //   Failed with result 'exit-code'.
  // for both units — so `systemctl status` showed red after every normal
  // restart, and the Remote Access panel rendered that as a red alert.
  it.each([
    ["clawbox-setup.service", SETUP_UNIT],
    ["clawbox-tunnel.service", TUNNEL_UNIT],
  ])("%s accepts a SIGTERM exit as success", (_name, unit) => {
    const value = directive(unit, "SuccessExitStatus");
    expect(value).not.toBeNull();
    expect(value).toContain("143");
  });

  it("production-server.js handles SIGTERM and exits 0", () => {
    expect(PRODUCTION_SERVER).toContain('process.on("SIGTERM"');
    expect(PRODUCTION_SERVER).toContain('process.on("SIGINT"');
    // Closing the listeners is the point; a bare process.exit would drop
    // in-flight responses on every deploy.
    expect(PRODUCTION_SERVER).toMatch(/server\.close\(done\)/);
    expect(PRODUCTION_SERVER).toContain("SHUTDOWN_GRACE_MS");
  });

  it("run-tunnel.sh returns 0 when it was asked to stop", () => {
    // `set -o pipefail` + cloudflared killed by SIGTERM = pipeline status 143.
    expect(RUN_TUNNEL_SH).toContain("PIPESTATUS[0]");
    expect(RUN_TUNNEL_SH).toMatch(/SIGNALLED.*=.*"1".*\|\|.*143.*\|\|.*130/s);
    expect(RUN_TUNNEL_SH).toContain("trap on_signal INT TERM");
  });
});

describe("the journal survives a reboot", () => {
  // Measured on the box: /var/log/journal did not exist, journald.conf held
  // nothing but its `[Journal]` header (so Storage=auto -> volatile), and 72 MB
  // of journal was sitting in /run/log/journal (tmpfs), charged to RAM and
  // destroyed on every reboot.
  it("the drop-in sets persistent storage", () => {
    expect(directive(JOURNALD_CONF, "Storage")).toBe("persistent");
  });

  it("the drop-in bounds both the disk and the tmpfs journal", () => {
    // Unbounded logs on a Jetson's eMMC is a flash-wear problem, and the
    // volatile half is what ate 72 MB of RAM.
    expect(directive(JOURNALD_CONF, "SystemMaxUse")).toBe("200M");
    expect(directive(JOURNALD_CONF, "RuntimeMaxUse")).toBe("64M");
    expect(directive(JOURNALD_CONF, "SystemKeepFree")).toBeTruthy();
  });

  it("the drop-in states an explicit rate limit", () => {
    // Port 80 is reachable from the LAN, the open setup AP and the public
    // tunnel, and the web tier now writes a line per request: 200 unauth
    // requests were measured completing in 0.80 s.
    expect(directive(JOURNALD_CONF, "RateLimitIntervalSec")).toBeTruthy();
    expect(directive(JOURNALD_CONF, "RateLimitBurst")).toBeTruthy();
  });

  it("install.sh installs the drop-in and creates /var/log/journal", () => {
    const step = extractShellFunction(INSTALL_SH, "step_persistent_journal");
    expect(step).toContain("config/journald-clawbox.conf");
    expect(step).toContain("/etc/systemd/journald.conf.d");
    // Storage=persistent only creates the directory on journald's NEXT start,
    // and systemd-tmpfiles is what applies the systemd-journal ACL.
    expect(step).toContain("mkdir -p /var/log/journal");
    expect(step).toContain("systemd-tmpfiles --create --prefix /var/log/journal");
    // Restart, not reload: Storage= is only read at start.
    expect(step).toContain("systemctl restart systemd-journald");
  });

  it("the step runs on fresh installs, in-app updates and by hand", () => {
    // Without the post_update call this would be fresh-install-only and every
    // already-shipped box would keep losing its log on each reboot.
    expect(extractShellFunction(INSTALL_SH, "step_system_config")).toContain(
      "step_persistent_journal",
    );
    expect(extractShellFunction(INSTALL_SH, "step_post_update")).toContain(
      "step_persistent_journal",
    );
    const dispatch = INSTALL_SH.slice(
      INSTALL_SH.indexOf("DISPATCH_STEPS=("),
      INSTALL_SH.indexOf("\n)", INSTALL_SH.indexOf("DISPATCH_STEPS=(")),
    );
    expect(dispatch).toContain("persistent_journal");
  });
});

describe("the web tier logs requests", () => {
  it("production-server.js attaches the access log to the listening server", () => {
    expect(PRODUCTION_SERVER).toContain('require("./scripts/access-log.js")');
    expect(PRODUCTION_SERVER).toContain("attachAccessLog(this)");
  });
});

describe("published tunnel URLs are recorded", () => {
  it("run-tunnel.sh appends every captured URL to a bounded history file", () => {
    // `tunnel.url` is erased by cleanup() on every stop, so it can only answer
    // "what is the URL right now" — never "which hostnames has this box ever
    // been reachable on", which is the question a stray still-serving
    // quick-tunnel URL raises.
    expect(RUN_TUNNEL_SH).toContain('TUNNEL_URL_LOG="$TUNNEL_DIR/tunnel-url.log"');
    expect(RUN_TUNNEL_SH).toContain("TUNNEL_URL_LOG_MAX");
    expect(RUN_TUNNEL_SH).toMatch(/date -u \+%Y-%m-%dT%H:%M:%SZ/);
    // cleanup() must NOT delete the history — that is the whole point.
    expect(extractShellFunction(RUN_TUNNEL_SH, "cleanup")).not.toContain("TUNNEL_URL_LOG");
  });
});
