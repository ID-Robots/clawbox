import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describeRefresh } from "../../../e2e-install/helpers/openclaw-plugin-migration";

/**
 * The fast path of `step_openclaw_install`.
 *
 * The full path stops the gateway, runs `openclaw doctor --fix`, reinstalls the
 * external plugins doctor left behind and starts the gateway again — minutes of
 * downtime on an update that, most of the time, does not move the pin. The fast path returns
 * before the gateway is touched, and only when ALL of these hold:
 *   1. the core answers the target;
 *   2. the ClawBox-managed plugins are at the version the refresh would install,
 *      and the core's plugin list reports nothing broken, orphaned or waiting
 *      for consent;
 *   3. the marker records a full path that FINISHED for this target, and — on
 *      OpenClaw 2, where the full path runs `doctor --fix` — doctor's own record
 *      (data/openclaw-migration-status.json) says its last run for this core
 *      completed and no database is behind the core's schema;
 *   4. the gateway is active, running and listening.
 * Any doubt is the full path, unchanged. This suite drives the shipped step —
 * the check, the marker, the step itself and its fast-only twin — over a box
 * built on disk, and only systemd, the account switch and the OpenClaw CLI are
 * stood in for.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const source = readFileSync("install.sh", "utf8");
const TARGET = "2026.10.7";
const OLDER = "2026.10.3";
/** A pre-OpenClaw-2 pin (the documented rollback override): no doctor runs. */
const V1 = "2026.7.1";

/**
 * data/openclaw-migration-status.json as `record-doctor` and the gateway's
 * pre-start leave it on a box whose last full path completed for `core`.
 */
function doctorRecord(core: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    updatedAt: "2026-10-28T10:05:00Z",
    source: "gateway-pre-start",
    core,
    databases: { total: 2, behind: 0, newer: 0 },
    doctor: { core, verdict: "complete", at: "2026-10-28T09:58:00Z" },
    preflight: null,
    state: "ok",
    reason: null,
    requiredBytes: null,
    freeBytes: null,
    ...over,
  };
}

function shellFunction(name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return source.slice(start + 1, source.indexOf("\n}", start) + 2);
}

function assignment(name: string): string {
  const m = new RegExp(`^${name}=.*$`, "m").exec(source);
  if (!m) throw new Error(`Missing ${name}`);
  return m[0];
}

const hasPython3 = spawnSync("python3", ["--version"]).status === 0;

interface Plugin {
  id: string;
  origin?: string;
  status?: string;
  rootDir?: string;
  source?: string;
  error?: string;
  dependencyStatus?: { requiredInstalled: boolean };
  diagnostics?: unknown[];
}

interface Box {
  dir: string;
  plugins: Plugin[];
  diagnostics: unknown[];
  /** Write the plugin list the stand-in CLI answers with. */
  publish(): void;
  /** A payload directory with a package.json, or none when `pkg` is null. */
  payload(rel: string, pkg: Record<string, unknown> | null): string;
}

const boxes: string[] = [];
afterEach(() => {
  while (boxes.length) {
    const dir = boxes.pop()!;
    // The child a stand-in CLI left behind (INSTALL_LEAVES_CHILD), ended
    // whatever the case asserted. Never pid 0 or 1: 0 is this process group.
    const straggler = path.join(dir, "straggler");
    const pid = existsSync(straggler) ? Number(readFileSync(straggler, "utf8")) : 0;
    if (Number.isInteger(pid) && pid > 1) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeBox(opts: {
  /** The pin; the core, the marker, the record and the @openclaw plugins follow it unless set. */
  target?: string;
  core?: string;
  marker?: string | null;
  /** Doctor's record: an object, raw text, or null for no file at all. */
  record?: Record<string, unknown> | string | null;
  /** The version of the @openclaw payloads on disk; the pin unless set. */
  pluginVersion?: string;
} = {}): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-fast-path-"));
  boxes.push(dir);
  const write = (rel: string, text: string, mode?: number) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, mode === undefined ? undefined : { mode });
  };
  const target = opts.target ?? TARGET;
  // The pin, read from the mirror's config/openclaw-target.txt as on the box.
  write("src/config/openclaw-target.txt", `${target}\n`);
  // Sourced by every launcher here, live or staged: who ran it, which one, with what.
  write("said-who", `[ -n "\${AS_SERVICE_USER:-}" ] && who=service || who=root\necho "$who $0 $*" >> "${dir}/launcher-runs"\n`);
  // The managed core, answering --version the way the real launcher does.
  write("npm-global/bin/openclaw", `#!/bin/sh\n. "${dir}/said-who"\necho 'OpenClaw ${opts.core ?? target} (abc1234)'\n`, 0o755);
  write("npm-global/lib/node_modules/openclaw/package.json", JSON.stringify({ name: "openclaw", version: opts.core ?? target }));
  // The checkout clawbox-email-directives is copied out of.
  write("checkout/scripts/openclaw-plugins/clawbox-email-directives/package.json",
    JSON.stringify({ name: "clawbox-email-directives", version: "1.0.0" }));
  mkdirSync(path.join(dir, "checkout/data"), { recursive: true });
  const marker = opts.marker === undefined ? target : opts.marker;
  if (marker !== null) write("openclaw-refresh", `target=${marker}\nfinished=2026-10-28T10:00:00Z\n`);
  const record = opts.record === undefined ? doctorRecord(target) : opts.record;
  if (record !== null) {
    write("checkout/data/openclaw-migration-status.json", typeof record === "string" ? record : JSON.stringify(record));
  }

  const box: Box = {
    dir,
    plugins: [],
    diagnostics: [],
    publish() {
      write("plugins.json", JSON.stringify({ plugins: box.plugins, diagnostics: box.diagnostics }));
    },
    payload(rel, pkg) {
      const root = path.join(dir, "state", rel);
      mkdirSync(root, { recursive: true });
      // An @openclaw payload as npm publishes it: a TypeScript source entry
      // with its built runtime peer declared, and only the built file present.
      if (!pkg) return root;
      const published = typeof pkg.name === "string" && pkg.name.startsWith("@openclaw/") && !("openclaw" in pkg);
      writeFileSync(path.join(root, "package.json"), JSON.stringify(
        published ? { ...pkg, openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] } } : pkg));
      if (published) {
        mkdirSync(path.join(root, "dist"), { recursive: true });
        writeFileSync(path.join(root, "dist/index.js"), "export default {};\n");
      }
      return root;
    },
  };
  // What a current OpenClaw box carries: the four ClawBox plugins from npm and
  // ClawHub at the pin, ClawBox's own plugin from the checkout, a plugin the
  // owner installed at whatever version he chose, and a bundled one.
  const pluginVersion = opts.pluginVersion ?? target;
  const npm = (name: string) => box.payload(`npm/projects/${name.replace("/", "-")}/node_modules/${name}`, { name, version: pluginVersion });
  box.plugins = [
    { id: "codex", origin: "global", status: "loaded", rootDir: npm("@openclaw/codex"), dependencyStatus: { requiredInstalled: true } },
    { id: "discord", origin: "global", status: "loaded", rootDir: npm("@openclaw/discord") },
    { id: "whatsapp", origin: "global", status: "disabled", rootDir: npm("@openclaw/whatsapp") },
    { id: "deepseek", origin: "global", status: "loaded", rootDir: box.payload("extensions/deepseek", { name: "@openclaw/deepseek-provider", version: pluginVersion }) },
    { id: "clawbox-email-directives", origin: "global", status: "loaded", rootDir: box.payload("extensions/clawbox-email-directives", { name: "clawbox-email-directives", version: "1.0.0" }) },
    { id: "owner-plugin", origin: "global", status: "loaded", rootDir: box.payload("npm/projects/owner/node_modules/owner-plugin", { name: "owner-plugin", version: "0.3.1" }) },
    { id: "a2a", origin: "bundled", status: "loaded" },
  ];
  box.publish();
  return box;
}

// The account switch and the OpenClaw CLI. `plugins list` answers with the
// box's plugins.json; npm leaves a launcher for the version it was asked for
// in the prefix it was handed, as the staged install expects. A plugin install
// logs its spec (PLUGIN_INSTALL) and its argv from the spec on
// (PLUGIN_INSTALL_ARGS), and a clock laid on any call, which the installers may
// not lay, as PLUGIN_INSTALL_BOUND; INSTALL_FAILS names specs the CLI refuses,
// with exit INSTALL_RC (1 unless set), saying INSTALL_SAYS (nothing when it is
// empty). INSTALL_LEAVES_CHILD names specs whose install answers but leaves a
// child holding its output, its pid in $BOX/straggler.
const AS_CLAWBOX = `as_clawbox() {
  while [ "\${1:-}" = "-H" ]; do shift; done
  local bound=""
  if [ "\${1:-}" = timeout ]; then
    shift
    [ "\${1:-}" != -k ] || shift 2
    bound="$1"
    shift
  fi
  # The plugin-list reader, run as the account whose files it opens.
  if [ "\${1:-}" = python3 ]; then event VERDICT_AS_CLAWBOX; "$@"; return; fi
  # The staging prefix, emptied, made and removed by the account that owns it.
  case "\${1:-}" in rm|mkdir) command "$@"; return ;; esac
  case "$*" in
    *"plugins list"*)
      event PLUGINS_LIST
      [ "\${LIST_FAILS:-0}" = 1 ] && return 1
      cat "$BOX/plugins.json"
      return 0 ;;
    *"plugins install"*)
      local a seen="" spec="" args=""
      for a in "$@"; do
        if [ -n "$seen" ]; then args="\${args:+$args }$a"; [ -n "$spec" ] || spec="$a"; fi
        [ "$a" != install ] || seen=1
      done
      event "PLUGIN_INSTALL $spec"
      event "PLUGIN_INSTALL_ARGS $args"
      [ -z "$bound" ] || event "PLUGIN_INSTALL_BOUND $bound"
      # sleep itself, not a subshell, as a real CLI leaves a process of its
      # own: it holds the call's stdout and stderr, never the run's own pipes.
      case " \${INSTALL_LEAVES_CHILD:-} " in *" $spec "*) sleep 600 & echo "$!" > "$BOX/straggler" ;; esac
      case " \${INSTALL_FAILS:-} " in *" $spec "*)
        local says="\${INSTALL_SAYS-example failure cause}"
        [ -z "$says" ] || printf '%s\\n' "$says" >&2
        return "\${INSTALL_RC:-1}" ;;
      esac
      return 0 ;;
    *"doctor --fix"*)
      event DOCTOR
      if [ "\${DOCTOR_FAILS:-0}" = 1 ]; then echo "startup migrations did not complete"; return 1; fi
      # Doctor's migration, where a case asks for one (DOCTOR_MIGRATES=<db>:<schema>).
      if [ -n "\${DOCTOR_MIGRATES:-}" ]; then
        python3 -c 'import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA user_version=%d" % int(sys.argv[2])); c.commit()' \\
          "\${DOCTOR_MIGRATES%:*}" "\${DOCTOR_MIGRATES##*:}"
      fi
      return 0 ;;
    *"npm install"*)
      event NPM
      local prefix="" want="" b before=""
      for b in "$@"; do
        [ "$before" = --prefix ] && prefix="$b"
        case "$b" in openclaw@*) want="\${b#openclaw@}" ;; esac
        before="$b"
      done
      mkdir -p "$prefix/bin" "$prefix/lib/node_modules/openclaw"
      printf '#!/bin/sh\\n. "%s"\\necho "OpenClaw %s (def5678)"\\n' "$BOX/said-who" "$want" > "$prefix/bin/openclaw"
      chmod 755 "$prefix/bin/openclaw"
      return 0 ;;
    *) echo "UNEXPECTED as_clawbox $*" >&2; return 99 ;;
  esac
}`;

function program(box: Box, entry: string, lift: string[] = []): string {
  return [
    // Production dispatches this step with errexit ON; so does the suite.
    "set -euo pipefail",
    `BOX=${JSON.stringify(box.dir)}`,
    'event() { printf "%s\\n" "$*" >> "$BOX/events"; }',
    `CLAWBOX_USER=${JSON.stringify(process.env.USER ?? "clawbox")}`,
    'CLAWBOX_HOME="$BOX"',
    'SRC_DIR="$BOX/src"',
    'PROJECT_DIR="$BOX/checkout"',
    'NPM_PREFIX="$BOX/npm-global"',
    'OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"',
    'OPENCLAW_REFRESH_MARKER="$BOX/openclaw-refresh"',
    assignment("OPENCLAW_VERSION"),
    assignment("OPENCLAW_SERVICE_REPAIR_POLICY"),
    'CLAWBOX_EDITION="${EDITION:-openclaw}"',
    'is_hermes_edition() { [ "$CLAWBOX_EDITION" = hermes ]; }',
    'has_openclaw_harness() { [ "$CLAWBOX_EDITION" = openclaw ] || [ "$CLAWBOX_EDITION" = dual ]; }',
    // The guards that run before the decision on both paths, logged so a case
    // can see they still ran on the fast one.
    "ensure_clawbox_bashrc_path() { event BASHRC; }",
    "ensure_openclaw_node_engine() { event NODE_ENGINE; }",
    "remove_shadowing_system_openclaw() { event SHADOW_CLEANUP; }",
    "chown() { :; }",
    shellFunction("hand_over_home_path"),
    "flush_core_to_disk() { :; }",
    // Suites of their own: install-openclaw-migration-preflight.test.ts and
    // install-migration-stop.test.ts.
    "openclaw_migration_disk_preflight() { return 0; }",
    // `record-doctor` as the fast path sees it: the verdict, for the live core,
    // and the databases measured again — every one migrated when doctor
    // completed (openclaw-db-maintenance.test.ts covers the real helper).
    `openclaw_record_migration_verdict() {
  event "VERDICT $1"
  local core state=ok
  core="$("$OPENCLAW_BIN" --version | awk '{print $2}')"
  [ "$1" = complete ] || state=degraded
  printf '{"core":"%s","state":"%s","reason":null,"databases":{"total":2,"behind":0,"newer":0},"doctor":{"core":"%s","verdict":"%s"}}\\n' \\
    "$core" "$state" "$core" "$1" > "$PROJECT_DIR/data/openclaw-migration-status.json"
}`,
    "stop_openclaw_gateways_for_migration() { event STOP; }",
    // systemd's view of the gateway, set per case.
    `systemctl() {
  case "$1" in
    show) printf 'ActiveState=%s\\nSubState=%s\\n' "\${GW_ACTIVE:-active}" "\${GW_SUB:-running}" ;;
    start) event "START $2" ;;
    *) event "SYSTEMCTL $*" ;;
  esac
}`,
    'gateway_port_listening() { [ "${GW_LISTENING:-1}" = 1 ]; }',
    AS_CLAWBOX,
    // `runuser -u <account> -- env HOME=… cmd…`: cmd… as this user, marked as
    // the service account's run only when -u names it: a switch to root must
    // still read as root.
    'runuser() { local who=""; [ "${1:-}" = "-u" ] && [ "${2:-}" = "$CLAWBOX_USER" ] && who=1; '
      + 'shift 2; [ "${1:-}" = "--" ] && shift; AS_SERVICE_USER=$who "$@"; }',
    shellFunction("openclaw_version_is_v2"),
    shellFunction("openclaw_is_v2"),
    shellFunction("openclaw_migration_complete"),
    shellFunction("recover_parked_openclaw_core"),
    shellFunction("promote_staged_openclaw_core"),
    shellFunction("openclaw_refresh_fast_path_check"),
    shellFunction("openclaw_refresh_marker_clear"),
    shellFunction("openclaw_refresh_marker_write"),
    shellFunction("clawbox_plugin_cli_cause"),
    shellFunction("step_openclaw_install"),
    shellFunction("step_openclaw_install_fast"),
    "step_openclaw_patch() { event PATCH; }",
    "step_openclaw_config() { event CONFIG; }",
    "step_openclaw_tts() { event TTS; }",
    shellFunction("step_openclaw_setup"),
    // Shipped functions a case runs for real in place of the stand-ins above.
    ...lift.map(shellFunction),
    entry,
  ].join("\n");
}

function run(box: Box, entry = "step_openclaw_install", env: Record<string, string> = {}, lift: string[] = []) {
  const eventsFile = path.join(box.dir, "events");
  const runsFile = path.join(box.dir, "launcher-runs");
  rmSync(eventsFile, { force: true });
  rmSync(runsFile, { force: true });
  const r = spawnSync("bash", ["-c", program(box, entry, lift)], {
    encoding: "utf-8",
    timeout: 25_000,
    env: { ...process.env, CLAWBOX_FORCE_OPENCLAW_REFRESH: "", ...env },
  });
  const markerFile = path.join(box.dir, "openclaw-refresh");
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    events: existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").trim().split("\n") : [],
    marker: existsSync(markerFile) ? readFileSync(markerFile, "utf8") : null,
    /** Every launcher run, in order: `<root|service> <launcher> <args>`. */
    launcherRuns: existsSync(runsFile) ? readFileSync(runsFile, "utf8").trim().split("\n") : [],
  };
}

type Run = ReturnType<typeof run>;

/** The one line the step prints about its path, with the reason in it. */
function pathLine(r: Run): string {
  return r.stdout.split("\n").find((line) => line.trim().startsWith("OpenClaw refresh:"))?.trim() ?? "";
}

/** Every line the updater (OPENCLAW_FAST_PATH_LINE in updater.ts) would read as the fast path taken. */
function fastPathLines(r: Run): string[] {
  return r.stdout.split("\n").filter((line) => /^OpenClaw refresh: fast path\b/.test(line.trim()));
}

const hasMkfifo = spawnSync("mkfifo", ["--version"]).status === 0;

/** A real SQLite database at `userVersion`, the schema position the helper reads. */
function sqliteAt(file: string, userVersion: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync("python3", ["-c", [
    "import sqlite3, sys",
    "c = sqlite3.connect(sys.argv[1])",
    "c.execute('CREATE TABLE t(x)')",
    "c.execute('PRAGMA user_version=%d' % int(sys.argv[2]))",
    "c.commit()",
  ].join("\n"), file, String(userVersion)], { encoding: "utf-8" });
  expect(r.status, r.stderr).toBe(0);
}

function expectFastPath(r: Run) {
  expect(r.status, r.stderr).toBe(0);
  expect(pathLine(r)).toMatch(/^OpenClaw refresh: fast path \(/);
  // Nothing that touches the gateway or the payloads ran.
  for (const e of ["STOP", "DOCTOR", "NPM", "START clawbox-gateway.service"]) expect(r.events).not.toContain(e);
  expect(r.events.some((e) => e.startsWith("PLUGIN_INSTALL"))).toBe(false);
  // …while the guards ahead of the decision did, and the second-core cleanup
  // the full path also runs.
  expect(r.events.slice(0, 2)).toEqual(["BASHRC", "NODE_ENGINE"]);
  expect(r.events).toContain("SHADOW_CLEANUP");
}

/** The specs the step asked the CLI to install, in order. */
function installs(r: Run): string[] {
  return r.events.filter((e) => e.startsWith("PLUGIN_INSTALL ")).map((e) => e.slice("PLUGIN_INSTALL ".length));
}

/**
 * The full path, finished. `refreshes` says whether any plugin is reinstalled:
 * doctor has already moved the official plugins to the release, so a box whose
 * payloads sit at the pin has none to reinstall.
 */
function expectFullPath(r: Run, why: string | RegExp, { refreshes }: { refreshes: boolean }) {
  expect(r.status, r.stderr).toBe(0);
  const line = pathLine(r);
  expect(line).toMatch(/^OpenClaw refresh: full path \(/);
  if (typeof why === "string") expect(line).toContain(why);
  else expect(line).toMatch(why);
  expect(r.events).toContain("STOP");
  expect(r.events).toContain("DOCTOR");
  expect(installs(r).length > 0).toBe(refreshes);
  // The full path finished, so it records the target it finished for.
  expect(r.marker).toMatch(new RegExp(`^target=${TARGET.replace(/\./g, "\\.")}\\n`));
}

/**
 * The full path over a plugin list the refresh cannot read: nothing is
 * reinstalled, the owner is told, no finished refresh is recorded (so the next
 * update takes this path again), and the gateway is started all the same.
 */
function expectUnreadList(r: Run, said: string) {
  expect(r.status, r.stderr).toBe(0);
  expect(r.events).toContain("DOCTOR");
  expect(installs(r)).toEqual([]);
  expect(r.stdout.split("\n").filter((l) => l.startsWith("CLAWBOX-WARN["))).toEqual([
    `CLAWBOX-WARN[openclaw-plugin-refresh-skipped]: the OpenClaw plugin list could not be read (${said}); plugins were not refreshed in this update`,
  ]);
  expect(r.marker).toBeNull();
  expect(r.events.at(-1)).toBe("START clawbox-gateway.service");
}

describe.skipIf(!hasPython3)("step_openclaw_install: the fast path", () => {
  it("has the python3 the shipped check parses the plugin list with", () => {
    expect(hasPython3).toBe(true);
  });

  it("leaves the gateway running when the core, plugins, marker and gateway are all current", () => {
    const box = makeBox();
    const r = run(box);
    expectFastPath(r);
    // The core is asked its version as the service account, whose npm prefix
    // it sits in — the only launcher run on this path, and never root's.
    expect(r.launcherRuns).toEqual([`service ${box.dir}/npm-global/bin/openclaw --version`]);
    expect(r.stdout).toContain(`  Installed: OpenClaw ${TARGET} (abc1234), Target: ${TARGET}\n`);
    expect(r.stdout).toContain(`OpenClaw core is already at ${TARGET}; skipping npm install`);
    expect(pathLine(r)).toContain(`all at ${TARGET}, and the gateway is serving`);
    // The plugin list is asked once, by the check — not by a refresh.
    expect(r.events.filter((e) => e === "PLUGINS_LIST")).toHaveLength(1);
    // …and read as the clawbox account, never as root: every path the reader
    // opens (payload roots the CLI names, data/, the checkout) is that
    // account's to write.
    expect(r.events).toContain("VERDICT_AS_CLAWBOX");
  });

  it("takes the full path on the first update and the fast path on the second", () => {
    // A box whose last full refresh is not on record (every box before this
    // change): the first run does everything and records it, the second
    // finds nothing to do.
    const box = makeBox({ marker: null });
    const first = run(box);
    expectFullPath(first, `no full refresh has finished for ${TARGET}; the last on record is none`, { refreshes: false });
    expect(first.events).toContain("START clawbox-gateway.service");
    // Doctor has already put the official plugins at the release: the refresh
    // after it says so and reinstalls none of them.
    expect(first.stdout).toContain(`    - @openclaw/codex@${TARGET} (already at ${TARGET})\n`);
    const second = run(box);
    expectFastPath(second);
  });

  it("still takes the full path, unchanged, when the pin moved", () => {
    const box = makeBox({ core: OLDER });
    const r = run(box);
    expectFullPath(r, `the core on the box answers ${OLDER}, not ${TARGET}`, { refreshes: false });
    expect(r.events).toContain("NPM");
    expect(r.stdout).toContain(`  Installed: OpenClaw ${OLDER} (abc1234), Target: ${TARGET}\n`);
    // This step's two questions — the live core's version, then the staged
    // core's gate — go to the service account. Later runs are not this step's:
    // the plugin refresh's generation check and this suite's record-doctor.
    const prefix = `${box.dir}/npm-global`;
    expect(r.launcherRuns[0]).toBe(`service ${prefix}/bin/openclaw --version`);
    expect(r.launcherRuns.filter((l) => l.includes("/.openclaw-stage/")))
      .toEqual([`service ${prefix}/.openclaw-stage/bin/openclaw --version`]);
    // Not a single fast-path question was asked of a core that is not current.
    expect(r.events.indexOf("PLUGINS_LIST")).toBeGreaterThan(r.events.indexOf("DOCTOR"));
  });

  describe("every fact the fast path rests on, missing one at a time", () => {
    it("the marker names another target", () => {
      expectFullPath(run(makeBox({ marker: OLDER })), `the last on record is ${OLDER}`, { refreshes: false });
    });

    it("the gateway is stopped", () => {
      expectFullPath(run(makeBox(), "step_openclaw_install", { GW_ACTIVE: "inactive", GW_SUB: "dead" }),
        "the gateway is inactive/dead, not active/running", { refreshes: false });
    });

    it("the gateway is in its pre-start or a crash loop", () => {
      expectFullPath(run(makeBox(), "step_openclaw_install", { GW_ACTIVE: "activating", GW_SUB: "auto-restart" }),
        "the gateway is activating/auto-restart", { refreshes: false });
    });

    it("the gateway runs but never bound its port", () => {
      expectFullPath(run(makeBox(), "step_openclaw_install", { GW_LISTENING: "0" }),
        "the gateway is running but not listening on port 18789", { refreshes: false });
    });

    it("a ClawBox plugin from npm is not at the pin", () => {
      const box = makeBox();
      box.plugins[0].rootDir = box.payload("npm/projects/old/node_modules/@openclaw/codex", { name: "@openclaw/codex", version: OLDER });
      box.publish();
      expectFullPath(run(box), `plugin codex is at ${OLDER}, the refresh would install ${TARGET}`, { refreshes: true });
    });

    it("a ClawBox plugin from npm is a republish of the pin, not the pin", () => {
      // Only a correction pin's base counts as the pin; the refresh then pins it.
      const box = makeBox();
      box.plugins[0].rootDir = box.payload("npm/projects/re/node_modules/@openclaw/codex", { name: "@openclaw/codex", version: `${TARGET}-1` });
      box.publish();
      const r = run(box);
      expectFullPath(r, `plugin codex is at ${TARGET}-1, the refresh would install ${TARGET}`, { refreshes: true });
      expect(installs(r)).toEqual([`@openclaw/codex@${TARGET}`]);
    });

    it("a channel plugin the owner switched on is not at the pin", () => {
      const box = makeBox();
      box.plugins[2].rootDir = box.payload("npm/projects/wa/node_modules/@openclaw/whatsapp", { name: "@openclaw/whatsapp", version: "2026.9.4" });
      box.publish();
      expectFullPath(run(box), `plugin whatsapp is at 2026.9.4, the refresh would install ${TARGET}`, { refreshes: true });
    });

    it("the DeepSeek provider from ClawHub is not at the pin", () => {
      const box = makeBox();
      box.plugins[3].rootDir = box.payload("extensions/deepseek-old", { name: "@openclaw/deepseek-provider", version: OLDER });
      box.publish();
      expectFullPath(run(box), `plugin deepseek is at ${OLDER}`, { refreshes: true });
    });

    it("ClawBox's own plugin differs from the copy in the checkout", () => {
      const box = makeBox();
      box.plugins[4].rootDir = box.payload("extensions/email-old", { name: "clawbox-email-directives", version: "0.9.0" });
      box.publish();
      expectFullPath(run(box), "plugin clawbox-email-directives is at 0.9.0, the refresh would install 1.0.0", { refreshes: false });
    });

    it("a ClawBox plugin id is served by some other package", () => {
      const box = makeBox();
      box.plugins[1].rootDir = box.payload("npm/projects/x/node_modules/discord-fork", { name: "discord-fork", version: TARGET });
      box.publish();
      const r = run(box);
      expectFullPath(r, "plugin discord comes from discord-fork, not a package ClawBox pins", { refreshes: true });
      // Not left as the owner's: the fast path refuses a ClawBox id from another
      // package, so leaving it would keep every later update on the full path.
      expect(installs(r)).toEqual([`@openclaw/discord@${TARGET}`]);
    });

    it("a ClawBox plugin has no readable package.json", () => {
      const box = makeBox();
      box.plugins[0].rootDir = box.payload("npm/projects/empty/node_modules/@openclaw/codex", null);
      box.publish();
      expectFullPath(run(box), "plugin codex has no readable package.json", { refreshes: true });
    });

    it("a plugin was orphaned by an earlier core (listed with no payload)", () => {
      const box = makeBox();
      delete box.plugins[5].rootDir;
      box.publish();
      expectFullPath(run(box), "plugin owner-plugin has no payload on record", { refreshes: true });
    });

    it("a plugin payload is gone from disk", () => {
      const box = makeBox();
      box.plugins[1].rootDir = path.join(box.dir, "state/npm/projects/gone/node_modules/@openclaw/discord");
      box.publish();
      expectFullPath(run(box), "plugin discord payload is gone", { refreshes: true });
    });

    it("a plugin reports an error", () => {
      const box = makeBox();
      box.plugins[5].status = "error";
      box.publish();
      expectFullPath(run(box), "plugin owner-plugin is in an error state", { refreshes: false });
    });

    it("a ClawBox plugin is missing a required dependency", () => {
      const box = makeBox();
      box.plugins[0].dependencyStatus = { requiredInstalled: false };
      box.publish();
      expectFullPath(run(box), "plugin codex is missing a required dependency", { refreshes: true });
    });

    it("the core reports a plugin waiting for capability consent", () => {
      const box = makeBox();
      box.diagnostics = [{ level: "warn", pluginId: "discord", message: 'Plugin "discord" requires capability consent; disable and re-enable it to review the new surface.' }];
      box.publish();
      expectFullPath(run(box), /the core reports for discord: Plugin "discord" requires capability consent/, { refreshes: true });
    });

    it("the core reports a plugin payload it could not verify, on the plugin's own entry", () => {
      const box = makeBox();
      box.plugins[0].diagnostics = [{ pluginId: "codex", message: 'Plugin "codex": configured plugin payload verification failed (missing): gone' }];
      box.publish();
      expectFullPath(run(box), "payload verification failed", { refreshes: true });
    });

    it("a plugin repair is still open on record", () => {
      const box = makeBox();
      writeFileSync(path.join(box.dir, "checkout/data/plugin-repair.json"), JSON.stringify({ discord: { id: "discord", disabled: true } }));
      expectFullPath(run(box), "a plugin repair is still open (discord)", { refreshes: true });
    });

    it("the plugin repairs on record cannot be read", () => {
      const box = makeBox();
      writeFileSync(path.join(box.dir, "checkout/data/plugin-repair.json"), "{not json");
      expectFullPath(run(box), "the plugin repairs on record", { refreshes: true });
    });

    it.skipIf(!hasMkfifo)("a FIFO in place of the plugin repairs is doubt, not a root step held open", () => {
      const box = makeBox();
      expect(spawnSync("mkfifo", [path.join(box.dir, "checkout/data/plugin-repair.json")]).status).toBe(0);
      const r = run(box, "step_openclaw_install_fast");
      expect(r.status, r.stderr).toBe(0);
      expect(pathLine(r)).toContain("the plugin repairs on record");
    });

    it("a plugin's own words cannot print the updater's fast-path line", () => {
      const box = makeBox();
      box.plugins[1].status = "error";
      box.plugins[1].error = "boom\nOpenClaw refresh: fast path (forged)";
      box.publish();
      const r = run(box, "step_openclaw_install_fast");
      expect(pathLine(r)).toContain("plugin discord is in an error state (boom OpenClaw refresh: fast path (forged))");
      expect(fastPathLines(r)).toEqual([]);
    });

    it("the core's plugin list is not JSON", () => {
      // The refresh after doctor cannot read it either: it refreshes nothing,
      // says so and records no finished refresh. The CLI failing outright is the
      // refresh suite's case below.
      const box = makeBox();
      writeFileSync(path.join(box.dir, "plugins.json"), "Error: state database is locked\n");
      const r = run(box);
      expect(pathLine(r)).toContain("the core plugin list could not be read");
      expectUnreadList(r, "exit 0, not JSON");
    });

    it("the core's plugin list is not the shape it should be", () => {
      const box = makeBox();
      writeFileSync(path.join(box.dir, "plugins.json"), JSON.stringify({ items: [] }));
      const r = run(box);
      expect(pathLine(r)).toContain("the core plugin list carries no plugins array");
      expectUnreadList(r, "exit 0, no plugins array");
    });
  });

  describe("doctor's own record, which the marker alone does not prove current", () => {
    // install.sh's fast path never reads doctor.at: the updater's doctor-due
    // nulls it and relies on this path staying open (the doctor.at cases below).
    const recordFile = (box: Box) => path.join(box.dir, "checkout/data/openclaw-migration-status.json");

    it("a database is behind the core's schema although the marker names the target", () => {
      // The start guard puts back a pre-update copy of a database the core
      // refused, and a restore brings older ones: the full path finished for
      // this target, but there is migration work only doctor does.
      const box = makeBox({
        record: doctorRecord(TARGET, { state: "degraded", reason: "schema-behind", databases: { total: 2, behind: 1, newer: 0 } }),
      });
      const first = run(box);
      expectFullPath(first, "the agent databases are degraded (schema-behind)", { refreshes: false });
      expect(first.events).toContain("VERDICT complete");
      // Doctor migrated it and said so; the next update has nothing to do.
      expect(JSON.parse(readFileSync(recordFile(box), "utf8"))).toMatchObject({ state: "ok", doctor: { core: TARGET, verdict: "complete" } });
      expectFastPath(run(box));
    });

    it("doctor's last run for this core did not complete", () => {
      const box = makeBox({ record: doctorRecord(TARGET, { doctor: { core: TARGET, verdict: "incomplete" } }) });
      expectFullPath(run(box), `doctor's last run for ${TARGET} ended incomplete`, { refreshes: false });
    });

    it("doctor's last recorded run was for another core", () => {
      const box = makeBox({ record: doctorRecord(TARGET, { doctor: { core: OLDER, verdict: "complete" } }) });
      expectFullPath(run(box), `doctor's last recorded run was for ${OLDER}, not ${TARGET}`, { refreshes: false });
    });

    it("the databases were last measured against another core", () => {
      const box = makeBox({ record: doctorRecord(TARGET, { core: OLDER }) });
      expectFullPath(run(box), `the agent databases were last measured against ${OLDER}, not ${TARGET}`, { refreshes: false });
    });

    it("a migration is blocked for want of disk", () => {
      const box = makeBox({ record: doctorRecord(TARGET, { state: "blocked", reason: "insufficient-disk" }) });
      expectFullPath(run(box), "the agent databases are blocked (insufficient-disk)", { refreshes: false });
    });

    it("no record is on file: the first update takes the full path, the second the fast one", () => {
      // A box whose last full path ran before doctor's verdict was recorded.
      const box = makeBox({ record: null });
      expectFullPath(run(box), "no record of doctor's migration is on file", { refreshes: false });
      expectFastPath(run(box));
    });

    it("the record cannot be read", () => {
      expectFullPath(run(makeBox({ record: "{not json" })), "the record of doctor's migration could not be read", { refreshes: false });
    });

    it("the record is not an object", () => {
      expectFullPath(run(makeBox({ record: "[]" })), "the record of doctor's migration could not be read", { refreshes: false });
    });

    const DAY_MS = 24 * 60 * 60 * 1000;
    const doctorRunAt = (at: unknown) => makeBox({ record: doctorRecord(TARGET, { doctor: { core: TARGET, verdict: "complete", at } }) });
    const DOCTOR_TIMES: [string, unknown][] = [
      // What doctor-due writes; the same input as a record with no time, which
      // the cases above already take the fast path on. Listed to say so.
      ["null", null],
      ["31 days old", new Date(Date.now() - 31 * DAY_MS).toISOString()],
      ["a day in the future", new Date(Date.now() + DAY_MS).toISOString()],
      ["not a date", "not a date"],
      ["not a string", 0],
    ];

    it.each(DOCTOR_TIMES)("keeps the fast path whatever doctor.at holds: %s", (_what, at) => {
      expectFastPath(run(doctorRunAt(at)));
    });

    // The cases above bite: the shipped check with the updater's own gate on
    // doctor.at put in (doctorRecordRefusal: a UTC time, not later than now, at
    // most 30 days old) sends every one of them to the full path, and a fresh
    // time still to the fast one. Double quotes only: the program is a
    // single-quoted bash string.
    const AT_GATE_WHY = "doctor recorded run has no time in the last 30 days";
    const AT_GATE = [
      "import datetime",
      "try:",
      '    ran = datetime.datetime.fromisoformat(run.get("at").replace("Z", "+00:00"))',
      "except Exception:",
      "    ran = None",
      "now = datetime.datetime.now(datetime.timezone.utc)",
      "if ran is None or ran.tzinfo is None or ran > now or now - ran > datetime.timedelta(days=30):",
      `    doubt("${AT_GATE_WHY}")`,
      "",
    ].join("\n");
    const INJECTION_POINT = '\nif run.get("core") != target:\n';
    function checkReadingDoctorAt(): string {
      const shipped = shellFunction("openclaw_refresh_fast_path_check");
      expect(shipped.split(INJECTION_POINT)).toHaveLength(2);
      expect(AT_GATE).not.toContain("'");
      return shipped.replace(INJECTION_POINT, `\n${AT_GATE}${INJECTION_POINT.slice(1)}`);
    }

    it.each(DOCTOR_TIMES)("takes the full path for doctor.at %s once the check reads it as the updater's gate does", (_what, at) => {
      expectFullPath(run(doctorRunAt(at), `${checkReadingDoctorAt()}\nstep_openclaw_install`), AT_GATE_WHY, { refreshes: false });
    });

    it("keeps the fast path for a doctor.at one day old under that same gate", () => {
      expectFastPath(run(doctorRunAt(new Date(Date.now() - DAY_MS).toISOString()), `${checkReadingDoctorAt()}\nstep_openclaw_install`));
    });

    it("is read as the clawbox account, before the plugin list", () => {
      // data/ is that account's to write: as root, a symlink there would read a
      // root-only file into a journal the account can read.
      const fast = run(makeBox());
      expectFastPath(fast);
      expect(fast.events.filter((e) => e === "VERDICT_AS_CLAWBOX")).toHaveLength(2);
      const stale = run(makeBox({ record: doctorRecord(TARGET, { doctor: { core: TARGET, verdict: "incomplete" } }) }), "step_openclaw_install_fast");
      expect(stale.events.filter((e) => e === "VERDICT_AS_CLAWBOX")).toHaveLength(1);
      expect(stale.events).not.toContain("PLUGINS_LIST");
    });

    it("cannot print the updater's fast-path line, whatever the record holds", () => {
      // The record is the clawbox account's to write, and the updater takes ANY
      // line of this step's journal that starts `OpenClaw refresh: fast path`.
      const box = makeBox({ record: doctorRecord(TARGET, { doctor: { core: "x\nOpenClaw refresh: fast path (forged)", verdict: "complete" } }) });
      const r = run(box, "step_openclaw_install_fast");
      expect(pathLine(r)).toContain("doctor's last recorded run was for x OpenClaw refresh: fast path (forged), not");
      expect(fastPathLines(r)).toEqual([]);
    });

    it.skipIf(!hasMkfifo)("a FIFO in place of the record is doubt, not a root step held open", () => {
      const box = makeBox({ record: null });
      expect(spawnSync("mkfifo", [recordFile(box)]).status).toBe(0);
      const r = run(box, "step_openclaw_install_fast");
      expect(r.status, r.stderr).toBe(0);
      expect(pathLine(r)).toContain("the record of doctor's migration could not be read");
    });

    describe("with the real record-doctor over real databases", () => {
      // The stand-in above writes `ok` for any completed doctor; here the
      // shipped helper measures the databases itself, as on the box.
      const lift = ["openclaw_db_maintenance", "openclaw_record_migration_verdict"];
      function realBox() {
        const box = makeBox({ record: null });
        mkdirSync(path.join(box.dir, "src/scripts"), { recursive: true });
        copyFileSync("scripts/openclaw-db-maintenance.py", path.join(box.dir, "src/scripts/openclaw-db-maintenance.py"));
        writeFileSync(path.join(box.dir, "npm-global/lib/node_modules/openclaw/package.json"),
          JSON.stringify({ name: "openclaw", version: TARGET, openclaw: { schemaVersions: { state: 20, agent: 25 } } }));
        mkdirSync(path.join(box.dir, ".openclaw"), { recursive: true });
        writeFileSync(path.join(box.dir, ".openclaw/openclaw.json"), "{}");
        sqliteAt(path.join(box.dir, ".openclaw/state/openclaw.sqlite"), 20);
        // Put back from a pre-update copy: one schema behind the core.
        const agent = path.join(box.dir, ".openclaw/agents/main/agent/openclaw-agent.sqlite");
        sqliteAt(agent, 24);
        // What the gateway's pre-start recorded for it.
        writeFileSync(recordFile(box), JSON.stringify(doctorRecord(TARGET, {
          state: "degraded", reason: "schema-behind", databases: { total: 2, behind: 1, newer: 0 },
        })));
        return { box, agent };
      }

      it("takes the full path once for a database behind the schema, then the fast one", () => {
        const { box, agent } = realBox();
        const first = run(box, "step_openclaw_install", { DOCTOR_MIGRATES: `${agent}:25` }, lift);
        expectFullPath(first, "the agent databases are degraded (schema-behind)", { refreshes: false });
        expect(JSON.parse(readFileSync(recordFile(box), "utf8"))).toMatchObject({
          source: "install", core: TARGET, state: "ok", databases: { total: 2, behind: 0 }, doctor: { core: TARGET, verdict: "complete" },
        });
        expectFastPath(run(box, "step_openclaw_install", {}, lift));
      });

      it("keeps taking the full path while doctor leaves the database behind", () => {
        const { box } = realBox();
        expectFullPath(run(box, "step_openclaw_install", {}, lift), "the agent databases are degraded (schema-behind)", { refreshes: false });
        expect(JSON.parse(readFileSync(recordFile(box), "utf8"))).toMatchObject({ state: "degraded", reason: "schema-behind" });
        expectFullPath(run(box, "step_openclaw_install", {}, lift), "the agent databases are degraded (schema-behind)", { refreshes: false });
      });
    });

    it("is not asked of an OpenClaw 1 pin, whose full path runs no doctor", () => {
      // The documented rollback override: nothing would ever write the record.
      const r = run(makeBox({ target: V1, record: null }));
      expectFastPath(r);
      expect(pathLine(r)).toContain(`all at ${V1}`);
    });
  });

  it("does not version-check plugins the owner installed, or bundled ones", () => {
    // The core did not move, so the refresh has nothing to line them up with;
    // a broken one is still doubt (see the cases above).
    const box = makeBox();
    box.plugins[5].rootDir = box.payload("npm/projects/owner2/node_modules/owner-plugin", { name: "owner-plugin", version: "9.9.9" });
    box.publish();
    expectFastPath(run(box));
  });

  it("is forced to the full path by CLAWBOX_FORCE_OPENCLAW_REFRESH=1", () => {
    const r = run(makeBox(), "step_openclaw_install", { CLAWBOX_FORCE_OPENCLAW_REFRESH: "1" });
    expectFullPath(r, "CLAWBOX_FORCE_OPENCLAW_REFRESH=1 asks for it", { refreshes: false });
    expect(r.events).toContain("START clawbox-gateway.service");
  });

  it("drops the marker when a full path does not finish", () => {
    // The gateway is down, so this is the full path; doctor then fails. The
    // marker that named this very target must not survive the attempt.
    const r = run(makeBox(), "step_openclaw_install", { GW_ACTIVE: "failed", GW_SUB: "failed", DOCTOR_FAILS: "1" });
    expect(r.status).toBe(1);
    expect(pathLine(r)).toContain("the gateway is failed/failed");
    expect(r.marker).toBeNull();
    expect(r.events).not.toContain("START clawbox-gateway.service");
  });

  it("is never taken inside the composite openclaw_setup step, whose config writes expect a stopped gateway", () => {
    const r = run(makeBox(), "step_openclaw_setup");
    expect(r.status, r.stderr).toBe(0);
    expect(pathLine(r)).toContain("the composite openclaw_setup step configures OpenClaw next");
    expect(r.events).toContain("STOP");
    // One restart, after the whole composite step — as before.
    expect(r.events.slice(-4)).toEqual(["PATCH", "CONFIG", "TTS", "START clawbox-gateway.service"]);
  });

  it("is never taken on a box that runs no OpenClaw gateway yet, and starts none", () => {
    const r = run(makeBox(), "step_openclaw_install", { EDITION: "unselected" });
    expect(r.status, r.stderr).toBe(0);
    expect(pathLine(r)).toContain("this box runs no OpenClaw gateway (edition unselected)");
    expect(r.events).not.toContain("START clawbox-gateway.service");
  });

  it("leaves the Hermes edition skip where it was: before any of it", () => {
    const r = run(makeBox(), "step_openclaw_install", { EDITION: "hermes" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("[hermes edition] skipping OpenClaw npm install");
    expect(pathLine(r)).toBe("");
    expect(r.events).toEqual([]);
  });
});

/**
 * The plugin refresh after doctor, on the full path. The pinned core's `doctor
 * --fix` already moves the active official plugins to its release and leaves
 * third-party ones alone (docs/cli/doctor/checks.md), so the refresh reinstalls
 * only what is left behind: an official plugin below the release, or one the
 * core or a repair record has doubts about, and any orphan.
 */
describe.skipIf(!hasPython3)("step_openclaw_install: the plugin refresh after doctor", () => {
  /** An @openclaw plugin from npm, as doctor or an earlier refresh leaves it. */
  function official(box: Box, name: string, version: string, over: Partial<Plugin> = {}) {
    const pkg = `@openclaw/${name}`;
    box.plugins.push({
      id: name,
      origin: "global",
      status: "loaded",
      rootDir: box.payload(`npm/projects/openclaw-${name}/node_modules/${pkg}`, { name: pkg, version }),
      ...over,
    });
  }

  /** The anchored warnings the updater raises as cards, as printed. */
  function cards(r: Run): string[] {
    return r.stdout.split("\n").filter((l) => /^CLAWBOX-WARN\[/.test(l.trim())).map((l) => l.trim());
  }

  /**
   * The step's lines as the upgrade spec reads them off the journal, so its
   * reader (describeRefresh) is held to the words this file prints.
   */
  const journal = (r: Run) => r.stdout.split("\n").map((message, atUs) => ({ atUs, message }));

  /** A box crossing a pin whose doctor left codex and one more official plugin below it, and discord orphaned. */
  function leftBehind(): Box {
    const box = makeBox({ core: OLDER });
    box.plugins[0].rootDir = box.payload("npm/projects/old/node_modules/@openclaw/codex", { name: "@openclaw/codex", version: OLDER });
    delete box.plugins[1].rootDir;
    official(box, "example", OLDER);
    box.publish();
    return box;
  }

  it("reinstalls only the plugins the core update left behind, pinned, with no clock on them", () => {
    const r = run(leftBehind());
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r).sort()).toEqual([`@openclaw/codex@${TARGET}`, `@openclaw/discord@${TARGET}`, `@openclaw/example@${TARGET}`]);
    expect(r.stdout).toContain(`    - @openclaw/whatsapp@${TARGET} (already at ${TARGET})\n`);
    expect(r.stdout).toContain(`    - @openclaw/deepseek-provider@${TARGET} (already at ${TARGET})\n`);
    // Consent for the plugins ClawBox installs, and only those.
    expect(r.events).toContain(`PLUGIN_INSTALL_ARGS @openclaw/codex@${TARGET} --force --accept-capabilities`);
    expect(r.events).toContain(`PLUGIN_INSTALL_ARGS @openclaw/example@${TARGET} --force`);
    // No clock: a slow reinstall takes longer, it is never cut off for it
    // (install-no-time-limits.test.ts holds the whole file to that).
    expect(r.events.filter((e) => e.startsWith("PLUGIN_INSTALL_BOUND "))).toEqual([]);
    // Each one says how it ended: the row above is printed before the CLI runs.
    expect(r.stdout).toContain([
      `    - @openclaw/example@${TARGET}`,
      "      (not a ClawBox-managed plugin: refreshed without accepting new capabilities)",
      "      updated\n",
    ].join("\n"));
    expect(describeRefresh(journal(r))).toBe(`codex reinstalled: @openclaw/codex@${TARGET}; `
      + "7 rows: 2 already at the release, 3 reinstalled, 0 failed, 0 with no outcome printed");
    expect(cards(r)).toEqual([]);
    expect(r.marker).toMatch(new RegExp(`^target=${TARGET.replace(/\./g, "\\.")}\\n`));
    expect(r.events.at(-1)).toBe("START clawbox-gateway.service");
  });

  it("reads a correction release's plugins at its base release, and nothing else as one", () => {
    // Version-bound plugins follow the base cohort of a correction release
    // (docs/install/updating.md): X.Y.Z-1 runs plugins at X.Y.Z.
    const correction = `${TARGET}-1`;
    const r = run(makeBox({ target: correction, core: OLDER, pluginVersion: TARGET }));
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual([]);
    expect(r.stdout).toContain(`    - @openclaw/codex@${TARGET} (already at ${correction})\n`);
    // A pre-release is not a correction: its plugins are not taken as current.
    const pre = `${TARGET}-beta.1`;
    const beta = run(makeBox({ target: pre, core: OLDER, pluginVersion: TARGET }));
    expect(beta.status, beta.stderr).toBe(0);
    expect(installs(beta)).toContain(`@openclaw/codex@${pre}`);
  });

  it("leaves a correction release's managed plugins where the next update's fast path accepts them", () => {
    // Doctor puts them at the base cohort (docs/install/updating.md); the
    // refresh leaves them there and records the full path, and the fast path
    // must then take that base as the pin's, or every update stops the gateway.
    const box = makeBox({ target: `${TARGET}-1`, core: OLDER, pluginVersion: TARGET });
    const full = run(box);
    expect(full.status, full.stderr).toBe(0);
    expect(installs(full)).toEqual([]);
    expect(full.marker).toMatch(new RegExp(`^target=${TARGET.replace(/\./g, "\\.")}-1\\n`));
    expectFastPath(run(box, "step_openclaw_install_fast"));
  });

  it.each([
    ["is missing", (root: string) => rmSync(path.join(root, "dist/index.js"))],
    ["is empty", (root: string) => writeFileSync(path.join(root, "dist/index.js"), "")],
    // A declared runtime entry is the one the core loads: no fallback to a peer.
    ["is a declared runtime entry that is missing, though a built file sits beside the source", (root: string) => {
      rmSync(path.join(root, "dist/index.js"));
      writeFileSync(path.join(root, "index.js"), "export default {};\n");
    }],
  ])("reinstalls a plugin at the release whose entry file %s", (_what, spoil) => {
    // A package.json at the release says nothing of the code beside it: a
    // power cut or a kill mid-replacement can leave the one without the other.
    const box = makeBox({ core: OLDER });
    spoil(box.plugins[1].rootDir!);
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual([`@openclaw/discord@${TARGET}`]);
  });

  it("takes a package as npm publishes it for current: its declared runtime entry, built", () => {
    const box = makeBox({ core: OLDER });
    const root = box.plugins[0].rootDir!;
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).openclaw)
      .toEqual({ extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] });
    expect(existsSync(path.join(root, "index.ts"))).toBe(false);
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual([]);
    expect(r.stdout).toContain(`    - @openclaw/codex@${TARGET} (already at ${TARGET})\n`);
  });

  it.each([
    ["a NUL", "./dist/index\u0000.js"],
    ["a lone surrogate", "./dist/\ud800.js"],
  ])("reinstalls a plugin whose entry holds %s, and handles every other plugin as usual", (_what, entry) => {
    // JSON carries either; a path holding one cannot be asked of the disk, and
    // the reader must say so of that plugin, not die before its last line.
    const box = makeBox({ core: OLDER });
    writeFileSync(path.join(box.plugins[1].rootDir!, "package.json"), JSON.stringify(
      { name: "@openclaw/discord", version: TARGET, openclaw: { extensions: ["./index.ts"], runtimeExtensions: [entry] } }));
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual([`@openclaw/discord@${TARGET}`]);
    expect(r.stdout).toContain(`    - @openclaw/codex@${TARGET} (already at ${TARGET})\n`);
    expect(r.stdout).toContain("    - owner-plugin (not an OpenClaw or ClawBox plugin: left as installed, as OpenClaw's own update does)\n");
    // The reader finished: no warning that the list could not be read, and the refresh is recorded.
    expect(cards(r)).toEqual([]);
    expect(r.marker).toMatch(new RegExp(`^target=${TARGET.replace(/\./g, "\\.")}\\n`));
  });

  it("finds a TypeScript entry by its built peer, as the core loads an installed package", () => {
    const box = makeBox({ core: OLDER });
    const root = box.payload("npm/projects/ts/node_modules/@openclaw/example",
      { name: "@openclaw/example", version: TARGET, openclaw: { extensions: ["./src/index.ts"] } });
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist/index.js"), "export default {};\n");
    box.plugins.push({ id: "example", origin: "global", status: "loaded", rootDir: root });
    box.publish();
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual([]);
    expect(r.stdout).toContain(`    - @openclaw/example@${TARGET} (already at ${TARGET})\n`);
  });

  it("judges the first built peer the core would load, not a later one", () => {
    // dist/ first, then beside the source (docs/plugins/sdk-entrypoints/
    // package-entries.md): an empty dist/index.js is what the core loads, and a
    // filled src/index.js beside the source must not vouch for it.
    const box = makeBox({ core: OLDER });
    const root = box.payload("npm/projects/ts/node_modules/@openclaw/example",
      { name: "@openclaw/example", version: TARGET, openclaw: { extensions: ["./src/index.ts"] } });
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist/index.js"), "");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/index.js"), "export default {};\n");
    box.plugins.push({ id: "example", origin: "global", status: "loaded", rootDir: root });
    box.publish();
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual([`@openclaw/example@${TARGET}`]);
  });

  it.each([
    // The core's own lists (listBuiltRuntimeEntryCandidates): at each location
    // .mts tries .mjs, .js, .cjs and .cts tries .cjs, .js, .mjs, the source
    // extension read in any case.
    ["an .mts entry whose .js the core reaches, empty, before a filled .mjs beside the source",
      "./src/index.mts", { "dist/index.js": "", "src/index.mjs": "export default {};\n" }, true],
    ["an .mts entry built to .js, an empty .cjs after it", "./src/index.mts",
      { "dist/index.js": "export default {};\n", "dist/index.cjs": "" }, false],
    ["a .cts entry built to .js, an empty .mjs after it", "./src/index.cts",
      { "dist/index.js": "export default {};\n", "dist/index.mjs": "" }, false],
    ["an .MTS entry built to .mjs", "./src/index.MTS", { "dist/index.mjs": "export default {};\n" }, false],
  ])("judges %s by the peer the core would load", (_what, entry, files: Record<string, string>, reinstalled) => {
    const box = makeBox({ core: OLDER });
    const root = box.payload("npm/projects/ts/node_modules/@openclaw/example",
      { name: "@openclaw/example", version: TARGET, openclaw: { extensions: [entry] } });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    box.plugins.push({ id: "example", origin: "global", status: "loaded", rootDir: root });
    box.publish();
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual(reinstalled ? [`@openclaw/example@${TARGET}`] : []);
  });

  it("raises one card for a plugin ClawBox did not install that the core reports broken, and leaves it", () => {
    // The fast path refuses any plugin in an error state, so until it is fixed
    // every update takes the full path: the owner must be told why.
    const box = makeBox({ core: OLDER });
    box.plugins[5].status = "error";
    box.plugins[5].error = "boom";
    box.publish();
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual([]);
    expect(cards(r)).toEqual([
      "CLAWBOX-WARN[openclaw-owner-plugin-error]: 1 plugin(s) that ClawBox did not install report an error in OpenClaw: owner-plugin. ClawBox leaves them as installed; until they are fixed or removed, every update stops the assistant to refresh OpenClaw in full.",
    ]);
  });

  it("holds the plugins ClawBox manages to the version the fast path accepts", () => {
    // A republished X.Y.Z-1 under an X.Y.Z pin is the same release, and left
    // for any other official plugin; the fast path refuses it for a managed
    // one, so leaving that would keep every later update on the full path.
    const box = makeBox({ core: OLDER });
    box.plugins[0].rootDir = box.payload("npm/projects/republished/node_modules/@openclaw/codex", { name: "@openclaw/codex", version: `${TARGET}-1` });
    official(box, "example", `${TARGET}-1`);
    box.publish();
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual([`@openclaw/codex@${TARGET}`]);
    expect(r.stdout).toContain(`    - @openclaw/example@${TARGET}-1 (already at ${TARGET})\n`);
  });

  it("still reinstalls a plugin at the release that the core or a repair record doubts", () => {
    const box = makeBox({ core: OLDER });
    box.plugins[0].dependencyStatus = { requiredInstalled: false };
    box.diagnostics = [{ level: "warn", pluginId: "discord", message: 'Plugin "discord" requires capability consent; disable and re-enable it to review the new surface.' }];
    writeFileSync(path.join(box.dir, "checkout/data/plugin-repair.json"), JSON.stringify({ whatsapp: { id: "whatsapp", disabled: true } }));
    official(box, "example", TARGET, { status: "error", error: "boom" });
    box.publish();
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    // Exactly these: a doubt about one plugin reinstalls that one, not its neighbours.
    expect(installs(r).sort()).toEqual([
      `@openclaw/codex@${TARGET}`, `@openclaw/discord@${TARGET}`, `@openclaw/example@${TARGET}`, `@openclaw/whatsapp@${TARGET}`,
    ]);
  });

  it.each([
    ["a problem the core ties to no plugin", (box: Box) => { box.diagnostics = [{ level: "error", message: "registry unreadable" }]; },
      "the core reports a problem it ties to no plugin"],
    ["a repair record it cannot read", (box: Box) => { writeFileSync(path.join(box.dir, "checkout/data/plugin-repair.json"), "{not json"); },
      "the plugin repairs on record could not be read"],
  ])("reinstalls every official plugin over %s, and says why", (_what, spoil, why) => {
    const box = makeBox({ core: OLDER });
    spoil(box);
    box.publish();
    const r = run(box);
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r).sort()).toEqual([`@openclaw/codex@${TARGET}`, `@openclaw/discord@${TARGET}`, "deepseek", `@openclaw/whatsapp@${TARGET}`].sort());
    expect(r.stdout).toContain(`    (${why}, so every official plugin is reinstalled)\n`);
  });

  it("leaves ClawBox's own plugins and the owner's plugins as installed", () => {
    const r = run(makeBox({ core: OLDER }));
    expect(r.status, r.stderr).toBe(0);
    expect(installs(r)).toEqual([]);
    expect(r.stdout).toContain("    - clawbox-email-directives (ClawBox's own plugin: the gateway start installs it from the checkout)\n");
    expect(r.stdout).toContain("    - owner-plugin (not an OpenClaw or ClawBox plugin: left as installed, as OpenClaw's own update does)\n");
  });

  describe("a plugin list it cannot read", () => {
    it("the CLI fails: no reinstall, a warning, no finished refresh, and the gateway is started", () => {
      // Under errexit and pipefail this ended the step right after a completed
      // migration, with the gateway stopped.
      expectUnreadList(run(makeBox({ core: OLDER }), "step_openclaw_install", { LIST_FAILS: "1" }), "exit 1");
    });

    it("inside the composite setup step: the gateway is started once, at its end", () => {
      const r = run(makeBox(), "step_openclaw_setup", { LIST_FAILS: "1" });
      expect(r.status, r.stderr).toBe(0);
      expect(installs(r)).toEqual([]);
      expect(r.marker).toBeNull();
      expect(r.events.slice(-4)).toEqual(["PATCH", "CONFIG", "TTS", "START clawbox-gateway.service"]);
    });

    it("on a box that runs no OpenClaw gateway yet: none is started", () => {
      const r = run(makeBox({ core: OLDER }), "step_openclaw_install", { LIST_FAILS: "1", EDITION: "unselected" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.events).not.toContain("START clawbox-gateway.service");
    });
  });

  it("names a failed reinstall, its cause and what retries it, and raises one card", () => {
    const box = leftBehind();
    // 137 is a SIGKILL from anywhere (the kernel's OOM killer among them): with
    // no clock of its own, the step reports it as the exit it was.
    const r = run(box, "step_openclaw_install", { INSTALL_FAILS: `@openclaw/example@${TARGET} @openclaw/codex@${TARGET}`, INSTALL_RC: "137" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain([
      `    - @openclaw/example@${TARGET}`,
      "      (not a ClawBox-managed plugin: refreshed without accepting new capabilities)",
      "      WARN: not updated (non-fatal; the next update that moves OpenClaw retries it). The OpenClaw plugin install exited 137: example failure cause\n",
    ].join("\n"));
    expect(r.stdout).toContain([
      `    - @openclaw/codex@${TARGET}`,
      "      WARN: not updated (non-fatal; gateway-pre-start retries it). The OpenClaw plugin install exited 137: example failure cause\n",
    ].join("\n"));
    expect(r.stdout).not.toContain("will retry on next boot");
    expect(r.stdout).not.toMatch(/deadline|killed at/);
    expect(describeRefresh(journal(r))).toBe(`codex failed: @openclaw/codex@${TARGET}; `
      + "7 rows: 2 already at the release, 1 reinstalled, 2 failed, 0 with no outcome printed");
    expect(cards(r)).toEqual([
      `CLAWBOX-WARN[openclaw-plugin-refresh]: 2 plugin(s) were not updated to OpenClaw ${TARGET}: codex, example. The next update that moves OpenClaw tries them again.`,
    ]);
    // A failed reinstall is not a failed refresh: the full path finished.
    expect(r.marker).toMatch(new RegExp(`^target=${TARGET.replace(/\./g, "\\.")}\\n`));
    expect(r.events.at(-1)).toBe("START clawbox-gateway.service");
  });

  const LONG_CAUSE = `npm error ${"z".repeat(200)}`;
  it.each([
    ["said nothing", "", "The OpenClaw plugin install exited 1 and said nothing."],
    ["said more than a line holds", LONG_CAUSE, `The OpenClaw plugin install exited 1: ${LONG_CAUSE.slice(0, 159)}…`],
  ])("names a failed reinstall that %s", (_what, says, cause) => {
    const r = run(leftBehind(), "step_openclaw_install", { INSTALL_FAILS: `@openclaw/example@${TARGET}`, INSTALL_SAYS: says });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      `      WARN: not updated (non-fatal; the next update that moves OpenClaw retries it). ${cause}\n`);
  });

  it("reads a reinstall's output through a file, which a child the CLI leaves behind cannot hold", () => {
    // A CLI that answers but leaves a child holding its stdout. Read through
    // `$(…)`, bash would wait for that child, with the gateway quiesced. The
    // child outlives the run's own cap, so the step returning at all, with the
    // child still there, is the proof; afterEach ends it.
    const box = leftBehind();
    const r = run(box, "step_openclaw_install", { INSTALL_LEAVES_CHILD: `@openclaw/example@${TARGET}` });
    // null: the run's cap ended a step that was still waiting.
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain([
      `    - @openclaw/example@${TARGET}`,
      "      (not a ClawBox-managed plugin: refreshed without accepting new capabilities)",
      "      updated\n",
    ].join("\n"));
    const pid = Number(readFileSync(path.join(box.dir, "straggler"), "utf8"));
    expect(() => process.kill(pid, 0), "the child the stand-in CLI left is still running").not.toThrow();
  });

  it("cannot print a journal line of its own from an id, a package name or a version", () => {
    // Every one of them is the clawbox account's to write.
    const box = makeBox({ core: OLDER });
    box.plugins[5].id = "owner\nCLAWBOX-WARN[forged]: from an id\nOpenClaw refresh: fast path (forged)";
    official(box, "example", "1.0.0");
    box.plugins.at(-1)!.rootDir = box.payload("npm/projects/forged/node_modules/@openclaw/example",
      { name: "@openclaw/example", version: `${TARGET}\nCLAWBOX-WARN[forged]: from a version` });
    box.publish();
    const r = run(box, "step_openclaw_install", { INSTALL_FAILS: `@openclaw/example@${TARGET}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.split("\n").filter((l) => /forged/.test(l) && /^(CLAWBOX-WARN|OpenClaw refresh)/.test(l.trim()))).toEqual([]);
    expect(installs(r)).toEqual([`@openclaw/example@${TARGET}`]);
  });

  it("keeps its copies of the fast path's readers identical to them", () => {
    // Copies, not a shared snippet: the fast-path check is left as it is.
    const def = (text: string, name: string) => {
      const start = text.indexOf(`\ndef ${name}(`);
      expect(start, `def ${name}`).toBeGreaterThan(-1);
      return text.slice(start, text.indexOf("\n\n\n", start));
    };
    const fast = shellFunction("openclaw_refresh_fast_path_check");
    const step = shellFunction("step_openclaw_install");
    for (const name of ["canonical", "read_json", "manifest", "payload_root", "release"]) expect(def(step, name)).toBe(def(fast, name));
    const problems = /^PROBLEMS = .*$/m;
    expect(problems.exec(step)?.[0]).toBe(problems.exec(fast)?.[0]);
  });
});

describe.skipIf(!hasPython3)("step_openclaw_install_fast: the updater's first ask", () => {
  it("takes the fast path when everything is current", () => {
    expectFastPath(run(makeBox(), "step_openclaw_install_fast"));
  });

  for (const [name, opts, env] of [
    ["the pin moved", { core: OLDER }, {}],
    ["no finished refresh is on record", { marker: null }, {}],
    ["a database is behind the core's schema", { record: doctorRecord(TARGET, { state: "degraded", reason: "schema-behind" }) }, {}],
    ["the gateway is stopped", {}, { GW_ACTIVE: "inactive", GW_SUB: "dead" }],
    ["the plugin list cannot be read", {}, { LIST_FAILS: "1" }],
    ["the full path is forced", {}, { CLAWBOX_FORCE_OPENCLAW_REFRESH: "1" }],
  ] as const) {
    it(`changes nothing when ${name}, and says the full path is needed`, () => {
      const box = makeBox(opts);
      const before = existsSync(path.join(box.dir, "openclaw-refresh"))
        ? readFileSync(path.join(box.dir, "openclaw-refresh"), "utf8")
        : null;
      const r = run(box, "step_openclaw_install_fast", env);
      expect(r.status, r.stderr).toBe(0);
      expect(pathLine(r)).toMatch(/^OpenClaw refresh: full path needed \(.+\) — nothing changed here/);
      for (const e of ["STOP", "DOCTOR", "NPM", "SHADOW_CLEANUP", "START clawbox-gateway.service"]) expect(r.events).not.toContain(e);
      expect(r.events.some((e) => e.startsWith("PLUGIN_INSTALL"))).toBe(false);
      // The record is the full step's to drop, not this one's.
      expect(r.marker).toBe(before);
    });
  }

  it("asks the plugin list only once the cheaper facts hold", () => {
    const r = run(makeBox({ core: OLDER }), "step_openclaw_install_fast");
    expect(r.events).not.toContain("PLUGINS_LIST");
  });
});
