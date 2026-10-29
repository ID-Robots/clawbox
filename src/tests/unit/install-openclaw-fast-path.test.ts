import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The fast path of `step_openclaw_install`.
 *
 * The full path stops the gateway, runs `openclaw doctor --fix`, force-reinstalls
 * every external plugin and starts the gateway again — minutes of downtime on an
 * update that, most of the time, does not move the pin. The fast path returns
 * before the gateway is touched, and only when ALL of these hold:
 *   1. the core answers the target;
 *   2. the ClawBox-managed plugins are at the version the refresh would install,
 *      and the core's plugin list reports nothing broken, orphaned or waiting
 *      for consent;
 *   3. the marker records a full path that FINISHED for this target;
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
  while (boxes.length) rmSync(boxes.pop()!, { recursive: true, force: true });
});

function makeBox(opts: { core?: string; marker?: string | null } = {}): Box {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-fast-path-"));
  boxes.push(dir);
  const write = (rel: string, text: string, mode?: number) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, mode === undefined ? undefined : { mode });
  };
  // The pin, read from the mirror's config/openclaw-target.txt as on the box.
  write("src/config/openclaw-target.txt", `${TARGET}\n`);
  // The managed core, answering --version the way the real launcher does.
  write("npm-global/bin/openclaw", `#!/bin/sh\necho 'OpenClaw ${opts.core ?? TARGET} (abc1234)'\n`, 0o755);
  write("npm-global/lib/node_modules/openclaw/package.json", JSON.stringify({ name: "openclaw", version: opts.core ?? TARGET }));
  // The checkout clawbox-email-directives is copied out of.
  write("checkout/scripts/openclaw-plugins/clawbox-email-directives/package.json",
    JSON.stringify({ name: "clawbox-email-directives", version: "1.0.0" }));
  mkdirSync(path.join(dir, "checkout/data"), { recursive: true });
  const marker = opts.marker === undefined ? TARGET : opts.marker;
  if (marker !== null) write("openclaw-refresh", `target=${marker}\nfinished=2026-10-28T10:00:00Z\n`);

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
      if (pkg) writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
      return root;
    },
  };
  // What a current OpenClaw box carries: the four ClawBox plugins from npm and
  // ClawHub at the pin, ClawBox's own plugin from the checkout, a plugin the
  // owner installed at whatever version he chose, and a bundled one.
  const npm = (name: string) => box.payload(`npm/projects/${name.replace("/", "-")}/node_modules/${name}`, { name, version: TARGET });
  box.plugins = [
    { id: "codex", origin: "global", status: "loaded", rootDir: npm("@openclaw/codex"), dependencyStatus: { requiredInstalled: true } },
    { id: "discord", origin: "global", status: "loaded", rootDir: npm("@openclaw/discord") },
    { id: "whatsapp", origin: "global", status: "disabled", rootDir: npm("@openclaw/whatsapp") },
    { id: "deepseek", origin: "global", status: "loaded", rootDir: box.payload("extensions/deepseek", { name: "@openclaw/deepseek-provider", version: TARGET }) },
    { id: "clawbox-email-directives", origin: "global", status: "loaded", rootDir: box.payload("extensions/clawbox-email-directives", { name: "clawbox-email-directives", version: "1.0.0" }) },
    { id: "owner-plugin", origin: "global", status: "loaded", rootDir: box.payload("npm/projects/owner/node_modules/owner-plugin", { name: "owner-plugin", version: "0.3.1" }) },
    { id: "a2a", origin: "bundled", status: "loaded" },
  ];
  box.publish();
  return box;
}

// The account switch and the OpenClaw CLI. `plugins list` answers with the
// box's plugins.json; npm leaves a launcher for the version it was asked for
// in the prefix it was handed, as the staged install expects.
const AS_CLAWBOX = `as_clawbox() {
  while [ "\${1:-}" = "-H" ]; do shift; done
  # The plugin-list reader, run as the account whose files it opens.
  if [ "\${1:-}" = python3 ]; then event VERDICT_AS_CLAWBOX; "$@"; return; fi
  case "$*" in
    *"plugins list"*)
      event PLUGINS_LIST
      [ "\${LIST_FAILS:-0}" = 1 ] && return 1
      cat "$BOX/plugins.json"
      return 0 ;;
    *"plugins install"*)
      local a prev="" spec=""
      for a in "$@"; do [ "$prev" = install ] && spec="$a"; prev="$a"; done
      event "PLUGIN_INSTALL $spec"
      return 0 ;;
    *"doctor --fix"*)
      event DOCTOR
      if [ "\${DOCTOR_FAILS:-0}" = 1 ]; then echo "startup migrations did not complete"; return 1; fi
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
      printf '#!/bin/sh\\necho "OpenClaw %s (def5678)"\\n' "$want" > "$prefix/bin/openclaw"
      chmod 755 "$prefix/bin/openclaw"
      return 0 ;;
    *) echo "UNEXPECTED as_clawbox $*" >&2; return 99 ;;
  esac
}`;

function program(box: Box, entry: string): string {
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
    "flush_core_to_disk() { :; }",
    // Suites of their own: install-openclaw-migration-preflight.test.ts and
    // install-migration-stop.test.ts.
    "openclaw_migration_disk_preflight() { return 0; }",
    'openclaw_record_migration_verdict() { event "VERDICT $1"; }',
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
    shellFunction("openclaw_version_is_v2"),
    shellFunction("openclaw_is_v2"),
    shellFunction("openclaw_migration_complete"),
    shellFunction("recover_parked_openclaw_core"),
    shellFunction("promote_staged_openclaw_core"),
    shellFunction("openclaw_refresh_fast_path_check"),
    shellFunction("openclaw_refresh_marker_clear"),
    shellFunction("openclaw_refresh_marker_write"),
    shellFunction("step_openclaw_install"),
    shellFunction("step_openclaw_install_fast"),
    "step_openclaw_patch() { event PATCH; }",
    "step_openclaw_config() { event CONFIG; }",
    "step_openclaw_tts() { event TTS; }",
    shellFunction("step_openclaw_setup"),
    entry,
  ].join("\n");
}

function run(box: Box, entry = "step_openclaw_install", env: Record<string, string> = {}) {
  const eventsFile = path.join(box.dir, "events");
  rmSync(eventsFile, { force: true });
  const r = spawnSync("bash", ["-c", program(box, entry)], {
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
  };
}

type Run = ReturnType<typeof run>;

/** The one line the step prints about its path, with the reason in it. */
function pathLine(r: Run): string {
  return r.stdout.split("\n").find((line) => line.trim().startsWith("OpenClaw refresh:"))?.trim() ?? "";
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

function expectFullPath(r: Run, why: string | RegExp, { refreshes = true } = {}) {
  expect(r.status, r.stderr).toBe(0);
  const line = pathLine(r);
  expect(line).toMatch(/^OpenClaw refresh: full path \(/);
  if (typeof why === "string") expect(line).toContain(why);
  else expect(line).toMatch(why);
  expect(r.events).toContain("STOP");
  expect(r.events).toContain("DOCTOR");
  expect(r.events.some((e) => e.startsWith("PLUGIN_INSTALL"))).toBe(refreshes);
  // The full path finished, so it records the target it finished for.
  expect(r.marker).toMatch(new RegExp(`^target=${TARGET.replace(/\./g, "\\.")}\\n`));
}

describe.skipIf(!hasPython3)("step_openclaw_install: the fast path", () => {
  it("has the python3 the shipped check parses the plugin list with", () => {
    expect(hasPython3).toBe(true);
  });

  it("leaves the gateway running when the core, plugins, marker and gateway are all current", () => {
    const r = run(makeBox());
    expectFastPath(r);
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
    expectFullPath(first, `no full refresh has finished for ${TARGET}; the last on record is none`);
    expect(first.events).toContain("START clawbox-gateway.service");
    expect(first.events).toContain("PLUGIN_INSTALL @openclaw/codex@" + TARGET);
    const second = run(box);
    expectFastPath(second);
  });

  it("still takes the full path, unchanged, when the pin moved", () => {
    const r = run(makeBox({ core: OLDER }));
    expectFullPath(r, `the core on the box answers ${OLDER}, not ${TARGET}`);
    expect(r.events).toContain("NPM");
    // Not a single fast-path question was asked of a core that is not current.
    expect(r.events.indexOf("PLUGINS_LIST")).toBeGreaterThan(r.events.indexOf("DOCTOR"));
  });

  describe("every fact the fast path rests on, missing one at a time", () => {
    it("the marker names another target", () => {
      expectFullPath(run(makeBox({ marker: OLDER })), `the last on record is ${OLDER}`);
    });

    it("the gateway is stopped", () => {
      expectFullPath(run(makeBox(), "step_openclaw_install", { GW_ACTIVE: "inactive", GW_SUB: "dead" }),
        "the gateway is inactive/dead, not active/running");
    });

    it("the gateway is in its pre-start or a crash loop", () => {
      expectFullPath(run(makeBox(), "step_openclaw_install", { GW_ACTIVE: "activating", GW_SUB: "auto-restart" }),
        "the gateway is activating/auto-restart");
    });

    it("the gateway runs but never bound its port", () => {
      expectFullPath(run(makeBox(), "step_openclaw_install", { GW_LISTENING: "0" }),
        "the gateway is running but not listening on port 18789");
    });

    it("a ClawBox plugin from npm is not at the pin", () => {
      const box = makeBox();
      box.plugins[0].rootDir = box.payload("npm/projects/old/node_modules/@openclaw/codex", { name: "@openclaw/codex", version: OLDER });
      box.publish();
      expectFullPath(run(box), `plugin codex is at ${OLDER}, the refresh would install ${TARGET}`);
    });

    it("a channel plugin the owner switched on is not at the pin", () => {
      const box = makeBox();
      box.plugins[2].rootDir = box.payload("npm/projects/wa/node_modules/@openclaw/whatsapp", { name: "@openclaw/whatsapp", version: "2026.9.4" });
      box.publish();
      expectFullPath(run(box), `plugin whatsapp is at 2026.9.4, the refresh would install ${TARGET}`);
    });

    it("the DeepSeek provider from ClawHub is not at the pin", () => {
      const box = makeBox();
      box.plugins[3].rootDir = box.payload("extensions/deepseek-old", { name: "@openclaw/deepseek-provider", version: OLDER });
      box.publish();
      expectFullPath(run(box), `plugin deepseek is at ${OLDER}`);
    });

    it("ClawBox's own plugin differs from the copy in the checkout", () => {
      const box = makeBox();
      box.plugins[4].rootDir = box.payload("extensions/email-old", { name: "clawbox-email-directives", version: "0.9.0" });
      box.publish();
      expectFullPath(run(box), "plugin clawbox-email-directives is at 0.9.0, the refresh would install 1.0.0");
    });

    it("a ClawBox plugin id is served by some other package", () => {
      const box = makeBox();
      box.plugins[1].rootDir = box.payload("npm/projects/x/node_modules/discord-fork", { name: "discord-fork", version: TARGET });
      box.publish();
      expectFullPath(run(box), "plugin discord comes from discord-fork, not a package ClawBox pins");
    });

    it("a ClawBox plugin has no readable package.json", () => {
      const box = makeBox();
      box.plugins[0].rootDir = box.payload("npm/projects/empty/node_modules/@openclaw/codex", null);
      box.publish();
      expectFullPath(run(box), "plugin codex has no readable package.json");
    });

    it("a plugin was orphaned by an earlier core (listed with no payload)", () => {
      const box = makeBox();
      delete box.plugins[5].rootDir;
      box.publish();
      expectFullPath(run(box), "plugin owner-plugin has no payload on record");
    });

    it("a plugin payload is gone from disk", () => {
      const box = makeBox();
      box.plugins[1].rootDir = path.join(box.dir, "state/npm/projects/gone/node_modules/@openclaw/discord");
      box.publish();
      expectFullPath(run(box), "plugin discord payload is gone");
    });

    it("a plugin reports an error", () => {
      const box = makeBox();
      box.plugins[5].status = "error";
      box.publish();
      expectFullPath(run(box), "plugin owner-plugin is in an error state");
    });

    it("a ClawBox plugin is missing a required dependency", () => {
      const box = makeBox();
      box.plugins[0].dependencyStatus = { requiredInstalled: false };
      box.publish();
      expectFullPath(run(box), "plugin codex is missing a required dependency");
    });

    it("the core reports a plugin waiting for capability consent", () => {
      const box = makeBox();
      box.diagnostics = [{ level: "warn", pluginId: "discord", message: 'Plugin "discord" requires capability consent; disable and re-enable it to review the new surface.' }];
      box.publish();
      expectFullPath(run(box), /the core reports for discord: Plugin "discord" requires capability consent/);
    });

    it("the core reports a plugin payload it could not verify, on the plugin's own entry", () => {
      const box = makeBox();
      box.plugins[0].diagnostics = [{ pluginId: "codex", message: 'Plugin "codex": configured plugin payload verification failed (missing): gone' }];
      box.publish();
      expectFullPath(run(box), "payload verification failed");
    });

    it("a plugin repair is still open on record", () => {
      const box = makeBox();
      writeFileSync(path.join(box.dir, "checkout/data/plugin-repair.json"), JSON.stringify({ discord: { id: "discord", disabled: true } }));
      expectFullPath(run(box), "a plugin repair is still open (discord)");
    });

    it("the plugin repairs on record cannot be read", () => {
      const box = makeBox();
      writeFileSync(path.join(box.dir, "checkout/data/plugin-repair.json"), "{not json");
      expectFullPath(run(box), "the plugin repairs on record");
    });

    it("the core's plugin list is not JSON", () => {
      // The refresh then has nothing to reinstall, as before this change; the
      // CLI failing outright is the fast-only suite's case below.
      const box = makeBox();
      writeFileSync(path.join(box.dir, "plugins.json"), "Error: state database is locked\n");
      expectFullPath(run(box), "the core plugin list could not be read", { refreshes: false });
    });

    it("the core's plugin list is not the shape it should be", () => {
      const box = makeBox();
      writeFileSync(path.join(box.dir, "plugins.json"), JSON.stringify({ items: [] }));
      expectFullPath(run(box), "the core plugin list carries no plugins array", { refreshes: false });
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
    expectFullPath(r, "CLAWBOX_FORCE_OPENCLAW_REFRESH=1 asks for it");
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

describe.skipIf(!hasPython3)("step_openclaw_install_fast: the updater's first ask", () => {
  it("takes the fast path when everything is current", () => {
    expectFastPath(run(makeBox(), "step_openclaw_install_fast"));
  });

  for (const [name, opts, env] of [
    ["the pin moved", { core: OLDER }, {}],
    ["no finished refresh is on record", { marker: null }, {}],
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
