import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { testEnv } from "@/tests/helpers/env";
import { repairHelpers } from "@/tests/helpers/gateway-pre-start";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// gateway-pre-start.sh installs @openclaw/deepseek-provider on a paired box
// that lacks it, PINNED to the installed core. The day OpenClaw 2026.8.2
// shipped, the unpinned spec resolved to a build declaring `pluginApi
// >=2026.8.2`; the pinned 2026.8.1 runtime refused it ("requires plugin API
// >=2026.8.2, but this OpenClaw runtime exposes 2026.8.1") and every fresh
// install parked at a gateway that never reported ready (E2E Install caught
// it). The real block is run out of the shipped script against a fake
// `openclaw` that records its argv, so the ordering is pinned by the code
// that boots the gateway and not by a copy of it.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;


/** The deepseek plugin block, verbatim, from its guard to the workspace resolver that follows it. */
function extractBlock(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf('if [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ ! -f "$OPENCLAW_HOME_DIR/extensions/deepseek/openclaw.plugin.json" ]; then');
  const end = src.indexOf("# Resolve the workspace from agents.defaults.workspace", start);
  if (start < 0 || end < 0) throw new Error("deepseek plugin block not found in gateway-pre-start.sh");
  return `${repairHelpers()}\n${src.slice(start, end)}`;
}

const BLOCK = hasBash && hasPython3 ? extractBlock() : "";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pre-start-deepseek-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RunOptions {
  /** The installed core's release as the script resolved it; "" = could not be asked. */
  effective: string;
  /** Specs (argv[3] of `plugins install`) the fake CLI refuses. */
  refuse?: string[];
  /** What the fake CLI says when it refuses a spec; `refused <spec>` otherwise. */
  refusals?: Record<string, string>;
  /** The refusal's exit status — 124 is `timeout` killing it at its ceiling. */
  refuseExit?: number;
  /** Seconds every `plugins install` takes, so a start that asks shows it. */
  installSleep?: number;
  /** Whether openclaw.json carries a deepseek provider with a key. */
  configured?: boolean;
  /** Whether the plugin is already on disk. */
  present?: boolean;
  /** Whether openclaw.json already carries `plugins.entries.deepseek.enabled: false`. */
  entryDisabled?: boolean;
  /** Whether openclaw.json carries `plugins.entries.deepseek.enabled: true`. */
  entryEnabled?: boolean;
  /** Whether a repair marker for deepseek is already on disk, and what it says. */
  marked?: { disabled: boolean } & Partial<{ reason: string; spec: string }>;
  /** Make `config set` refuse, as an unwritable config would. */
  refuseConfigSet?: boolean;
  /** Start from what the previous run left — config and records — as the next start of the same box does. */
  keepState?: boolean;
}

interface RunResult {
  installs: string[];
  /** Every `openclaw` argv, one line each. */
  calls: string[];
  stdout: string;
  stderr: string;
  ms: number;
}

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

function run(opts: RunOptions): RunResult {
  const home = path.join(dir, "openclaw-home");
  mkdirSync(home, { recursive: true });
  if (opts.present) {
    mkdirSync(path.join(home, "extensions", "deepseek"), { recursive: true });
    writeFileSync(path.join(home, "extensions", "deepseek", "openclaw.plugin.json"), "{}");
  }
  const config = path.join(dir, "openclaw.json");
  if (!opts.keepState) {
    const document: Record<string, unknown> = opts.configured === false
      ? { models: { providers: {} } }
      : { models: { providers: { deepseek: { apiKey: "sk-test", baseUrl: "https://clawbox.com/api/ai" } } } };
    if (opts.entryDisabled) document.plugins = { entries: { deepseek: { enabled: false } } };
    if (opts.entryEnabled) document.plugins = { entries: { deepseek: { enabled: true } } };
    writeFileSync(config, JSON.stringify(document));
  }
  if (opts.marked) {
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({
      deepseek: {
        id: "deepseek", stage: "install", reason: opts.marked.reason ?? "offline", atMs: 1,
        disabled: opts.marked.disabled, spec: opts.marked.spec ?? "clawhub:@openclaw/deepseek-provider@2026.8.1",
      },
    }));
  }
  const log = path.join(dir, "installs.log");
  const callsLog = path.join(dir, "calls.log");
  rmSync(log, { force: true });
  rmSync(callsLog, { force: true });
  const bin = path.join(dir, "openclaw");
  const refusalCases = Object.entries(opts.refusals ?? {})
    .map(([spec, text]) => `    ${shq(spec)}) echo ${shq(text)} >&2 ;;`);
  // Records every `plugins install <spec>` and refuses the specs it is told
  // to — a ClawHub build the runtime rejects exits non-zero the same way.
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${shq(callsLog)}`,
      // The real `config set` semantics, because the repair helpers prove their
      // write against the FILE rather than against an exit code.
      'if [ "$1" = "config" ] && [ "$2" = "set" ]; then',
      opts.refuseConfigSet ? "  exit 1" : "  :",
      '  CLAWBOX_PATH="$3" CLAWBOX_VALUE="$4" python3 - "$OPENCLAW_CONFIG" <<\'PY\'',
      "import json, os, re, sys",
      "cfg_path = sys.argv[1]",
      "with open(cfg_path) as fh:",
      "    cfg = json.load(fh)",
      "m = re.match(r'^plugins\\.entries\\[\"(.+)\"\\]\\.enabled$', os.environ['CLAWBOX_PATH'])",
      "if not m:",
      "    raise SystemExit(1)",
      "entry = cfg.setdefault('plugins', {}).setdefault('entries', {}).setdefault(m.group(1), {})",
      "entry['enabled'] = os.environ['CLAWBOX_VALUE'] == 'true'",
      "with open(cfg_path, 'w') as fh:",
      "    json.dump(cfg, fh, indent=2)",
      "PY",
      "  exit $?",
      "fi",
      `if [ "$2" = "install" ]; then echo "$3" >> "${log}";${opts.installSleep ? ` sleep ${opts.installSleep};` : ""} fi`,
      `for r in ${(opts.refuse ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      '  if [ "$3" = "$r" ]; then',
      '    case "$3" in',
      ...refusalCases,
      '    *) echo "refused $3" >&2 ;;',
      "    esac",
      `    exit ${opts.refuseExit ?? 1}`,
      "  fi",
      "done",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const started = Date.now();
  const result = spawnSync("bash", ["-c", BLOCK], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      // The prepended repair helpers write `$CLAWBOX_ROOT/data/plugin-repair.json`:
      // this case's own directory, not the run-wide root.
      CLAWBOX_ROOT: dir,
      CLAWBOX_OPENCLAW_V2: "1",
      OPENCLAW_HOME_DIR: home,
      OPENCLAW_CONFIG: config,
      OPENCLAW_BIN: bin,
      CLAWBOX_OPENCLAW_EFFECTIVE: opts.effective,
    }),
  });
  const ms = Date.now() - started;
  if (result.status !== 0) throw new Error(`block exited ${result.status}: ${result.stderr}`);
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").filter(Boolean) : []);
  return { installs: lines(log), calls: lines(callsLog), stdout: result.stdout, stderr: result.stderr ?? "", ms };
}

function markerPath(): string {
  return path.join(dir, "data", "plugin-repair.json");
}

function unavailablePath(): string {
  return path.join(dir, "data", "plugin-install-unavailable.json");
}

type UnavailableRecord = { core: string; atMs: number; specs: string[]; cause: string };

function unavailable(): Record<string, UnavailableRecord> {
  return existsSync(unavailablePath()) ? JSON.parse(readFileSync(unavailablePath(), "utf-8")) : {};
}

function writeUnavailable(record: Partial<UnavailableRecord> = {}) {
  mkdirSync(path.join(dir, "data"), { recursive: true });
  writeFileSync(unavailablePath(), JSON.stringify({
    deepseek: {
      core: "2026.9.4",
      atMs: Date.now(),
      specs: [PINNED_9_4, UNPINNED],
      cause: "openclaw plugins install exited 1: Version not found on ClawHub: @openclaw/deepseek-provider@2026.9.4.",
      ...record,
    },
  }));
}

const PINNED_9_4 = "clawhub:@openclaw/deepseek-provider@2026.9.4";
const UNPINNED = "clawhub:@openclaw/deepseek-provider";
// What OpenClaw 2026.9.4 answered on nano-lab, and what ClawHub serves: its
// catalogue has 2026.9.3 and 2026.9.5 and no 2026.9.4, and its latest build
// declares the plugin API of the release it was cut from.
const CLAWHUB_REFUSALS = {
  [PINNED_9_4]: "Version not found on ClawHub: @openclaw/deepseek-provider@2026.9.4.",
  [UNPINNED]: 'Plugin "@openclaw/deepseek-provider" requires plugin API >=2026.9.5, but this OpenClaw runtime exposes 2026.9.4.',
};
const NO_BUILD_FOR_9_4: RunOptions = {
  effective: "2026.9.4",
  refuse: [PINNED_9_4, UNPINNED],
  refusals: CLAWHUB_REFUSALS,
};
const configSets = (calls: string[]) => calls.filter((call) => call.startsWith("config set"));

function config(): { plugins?: { entries?: Record<string, { enabled?: boolean } | undefined> } } {
  return JSON.parse(readFileSync(path.join(dir, "openclaw.json"), "utf-8"));
}

function marker(): Record<string, { disabled?: boolean; reason?: string; spec?: string; stage?: string }> {
  return existsSync(markerPath()) ? JSON.parse(readFileSync(markerPath(), "utf-8")) : {};
}

describe.skipIf(!hasBash || !hasPython3)("gateway-pre-start.sh deepseek plugin install", () => {
  it("installs the build matching the installed core and stops there", () => {
    const { installs, stdout } = run({ effective: "2026.8.1" });
    expect(installs).toEqual(["clawhub:@openclaw/deepseek-provider@2026.8.1"]);
    expect(stdout).toContain("installed (clawhub:@openclaw/deepseek-provider@2026.8.1)");
  });

  it("falls back to the unpinned spec only when the pinned build is refused", () => {
    const { installs, stdout } = run({
      effective: "2026.9.1",
      refuse: ["clawhub:@openclaw/deepseek-provider@2026.9.1"],
    });
    expect(installs).toEqual([
      "clawhub:@openclaw/deepseek-provider@2026.9.1",
      "clawhub:@openclaw/deepseek-provider",
    ]);
    expect(stdout).toContain("installed (clawhub:@openclaw/deepseek-provider)");
  });

  it("warns, and keeps booting, when neither spec installs", () => {
    const { installs, stdout } = run({
      effective: "2026.8.1",
      refuse: ["clawhub:@openclaw/deepseek-provider@2026.8.1", "clawhub:@openclaw/deepseek-provider"],
    });
    expect(installs).toHaveLength(2);
    expect(stdout).toContain("WARN: could not install @openclaw/deepseek-provider");
  });

  it("goes straight to the unpinned spec when the core's release is unknown", () => {
    const { installs } = run({ effective: "" });
    expect(installs).toEqual(["clawhub:@openclaw/deepseek-provider"]);
  });

  it("installs nothing when the plugin is already on disk", () => {
    expect(run({ effective: "2026.8.1", present: true }).installs).toEqual([]);
  });

  it("installs nothing on a box with no deepseek provider configured", () => {
    expect(run({ effective: "2026.8.1", configured: false }).installs).toEqual([]);
  });
  it("switches the entry back on before it clears the badge", () => {
    // A PREVIOUS boot could not install the plugin, so it set
    // `plugins.entries.deepseek.enabled = false` and recorded the row. This
    // boot installs it — and `openclaw plugins install` deliberately leaves an
    // entry that is explicitly `false` alone, so clearing the badge on the
    // install's exit code alone left ClawBox AI switched off with nothing on
    // screen to say so. Permanently: the guard above this block stops it
    // re-running once the payload is on disk, and the managed consent loop only
    // visits entries that are already `enabled: true`.
    const { stdout } = run({ effective: "2026.8.1", entryDisabled: true, marked: { disabled: true } });
    expect(stdout).toContain("installed (clawhub:@openclaw/deepseek-provider@2026.8.1)");
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(true);
    expect(marker()).toEqual({});
  });

  it("keeps the badge when the entry cannot be switched back on", () => {
    // A clear over a plugin that is still off is the false success this whole
    // card is about — so the row stays, and the boot log says why.
    const r = run({
      effective: "2026.8.1",
      entryDisabled: true,
      marked: { disabled: true },
      refuseConfigSet: true,
    });
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
    expect(Object.keys(marker())).toEqual(["deepseek"]);
    expect(r.stderr).toContain("could not switch the deepseek plugin back on");
  });

  it("does not touch the entry for a row it did not switch off", () => {
    // `disabled: false` means ClawBox recorded a failure and changed nothing —
    // an entry the OWNER turned off must stay off.
    run({ effective: "2026.8.1", entryDisabled: true, marked: { disabled: false } });
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
    expect(marker()).toEqual({});
  });
});

// TASK-1206. The 4.1.0 box: OpenClaw 2026.9.4, and ClawHub has no
// @openclaw/deepseek-provider@2026.9.4. Every gateway start asked for it, then
// for the unpinned build the runtime refuses, waited 35–60 s, switched the
// plugin off and filed "Needs repair" — on every start, for the same two
// answers. What a start must do now is ask ONCE per core, and then not ask,
// not wait and not touch the entry.
describe.skipIf(!hasBash || !hasPython3)("gateway-pre-start.sh deepseek plugin — a core with no build of it (TASK-1206)", () => {
  it("records the registry's no, and the next start neither asks again nor waits on it", () => {
    const first = run({ ...NO_BUILD_FOR_9_4, entryEnabled: true });
    expect(first.installs).toEqual([PINNED_9_4, UNPINNED]);
    expect(unavailable().deepseek).toMatchObject({ core: "2026.9.4", specs: [PINNED_9_4, UNPINNED] });
    expect(unavailable().deepseek.cause).toContain("Version not found on ClawHub");
    expect(first.stdout).toContain("the registry has no build OpenClaw 2026.9.4 can load");
    expect(first.stdout).toMatch(/DeepSeek provider plugin install attempts took \d+ s/);
    // The first answer still boots without it, exactly as before.
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
    expect(marker().deepseek?.disabled).toBe(true);
    expect(marker().deepseek?.reason).toContain("ClawBox AI keeps working without it");

    // Ten seconds per `plugins install`: a start that asked would take twenty.
    const second = run({ ...NO_BUILD_FOR_9_4, keepState: true, installSleep: 10 });
    expect(second.installs).toEqual([]);
    expect(second.calls).toEqual([]);
    expect(second.ms).toBeLessThan(5_000);
    expect(second.stdout).toContain("DeepSeek provider plugin: no installable build for OpenClaw 2026.9.4");
    expect(second.stdout).not.toContain("Installing @openclaw/deepseek-provider");
    // No switch-on-and-off: the entry and the row are as the first start left them.
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
    expect(marker().deepseek?.disabled).toBe(true);
  });

  it("takes the refusal a 4.1.0 start filed for this core as the record, so the upgrade's own boot does not ask", () => {
    const row = {
      disabled: true,
      spec: PINNED_9_4,
      reason: "The DeepSeek provider plugin, which ClawBox AI runs on, could not be installed. The device may be offline,"
        + " or the package registry unreachable. openclaw plugins install exited 1: Version not found on ClawHub:"
        + " @openclaw/deepseek-provider@2026.9.4.",
    };
    const r = run({ ...NO_BUILD_FOR_9_4, entryDisabled: true, marked: row, installSleep: 10 });
    expect(r.installs).toEqual([]);
    expect(configSets(r.calls)).toEqual([]);
    expect(r.ms).toBeLessThan(5_000);
    expect(r.stdout).toContain("taken from the repair row an earlier start filed");
    expect(unavailable().deepseek).toMatchObject({ core: "2026.9.4", specs: [PINNED_9_4] });
    expect(unavailable().deepseek.cause).toMatch(/^openclaw plugins install exited 1: Version not found on ClawHub/);
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
  });

  it("adopts nothing from a row that names another core, or a failure that was not the registry's answer", () => {
    const offline = run({
      ...NO_BUILD_FOR_9_4,
      entryDisabled: true,
      refuse: [],
      marked: { disabled: true, spec: PINNED_9_4, reason: "The device may be offline. openclaw plugins install exited 1: getaddrinfo EAI_AGAIN clawhub.ai" },
    });
    expect(offline.installs).toEqual([PINNED_9_4]);

    rmSync(unavailablePath(), { force: true });
    const olderCore = run({
      ...NO_BUILD_FOR_9_4,
      entryDisabled: true,
      refuse: [],
      marked: { disabled: true, spec: "clawhub:@openclaw/deepseek-provider@2026.9.3", reason: "openclaw plugins install exited 1: Version not found on ClawHub" },
    });
    expect(olderCore.installs).toEqual([PINNED_9_4]);
  });

  it("does not record a failure that says nothing about the package, so the next start asks again", () => {
    const first = run({
      effective: "2026.9.4",
      refuse: [PINNED_9_4, UNPINNED],
      refusals: { [PINNED_9_4]: "Error: clawhub registry answered 503 Service Unavailable", [UNPINNED]: CLAWHUB_REFUSALS[UNPINNED] },
    });
    expect(first.installs).toHaveLength(2);
    expect(unavailable()).toEqual({});
    expect(first.stdout).toContain("WARN: could not install @openclaw/deepseek-provider");
    expect(run({ ...NO_BUILD_FOR_9_4, keepState: true, refuse: [] }).installs).toEqual([PINNED_9_4]);
  });

  it("never records an install killed at its deadline, whatever it printed first", () => {
    run({ ...NO_BUILD_FOR_9_4, refuseExit: 124 });
    expect(unavailable()).toEqual({});
  });

  it("asks again as soon as the core changes", () => {
    writeUnavailable();
    const r = run({ effective: "2026.9.5" });
    expect(r.installs).toEqual(["clawhub:@openclaw/deepseek-provider@2026.9.5"]);
    // …and the plugin that installed takes the stale answer with it.
    expect(unavailable()).toEqual({});
  });

  it("asks again once the answer is a week old", () => {
    writeUnavailable({ atMs: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    expect(run({ effective: "2026.9.4" }).installs).toEqual([PINNED_9_4]);
  });

  it("switches off an entry something turned back on, without asking the registry", () => {
    // The gateway must not start with a plugin that is not there switched on;
    // the move is the one the refusal itself made, and it asks nothing.
    writeUnavailable();
    const r = run({ ...NO_BUILD_FOR_9_4, entryEnabled: true });
    expect(r.installs).toEqual([]);
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
    expect(marker().deepseek).toMatchObject({ stage: "install", disabled: true, spec: PINNED_9_4 });
  });
});
