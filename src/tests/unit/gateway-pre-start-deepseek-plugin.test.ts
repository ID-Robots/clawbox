import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { testEnv } from "@/tests/helpers/env";
import { inspectAllJson, repairHelpers, sliceScript } from "@/tests/helpers/gateway-pre-start";

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
//
// TASK-1302: ClawHub has no 2026.9.4 build — the one the 4.1 core needs — and
// the unpinned fallback resolves 2026.9.6, which that runtime refuses; npm has
// the build. So the same pinned build is asked of npm between the two, and an
// npm payload on disk counts as installed.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;


/** Where the plugin's payload lives (TASK-1302): the helpers the guard and the xhigh patch share. */
function payloadHelpers(): string {
  return sliceScript(
    "# ── Where the DeepSeek provider plugin's payload lives ",
    "# Patch the installed openclaw deepseek plugin JSON",
  );
}

/** The deepseek plugin block, verbatim, from its guard to the workspace resolver that follows it. */
function extractBlock(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf('if [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && ! clawbox_deepseek_plugin_on_disk "$OPENCLAW_HOME_DIR"; then');
  const end = src.indexOf("# Resolve the workspace from agents.defaults.workspace", start);
  if (start < 0 || end < 0) throw new Error("deepseek plugin block not found in gateway-pre-start.sh");
  return `${repairHelpers()}\n${payloadHelpers()}\n${src.slice(start, end)}`;
}

const BLOCK = hasBash && hasPython3 ? extractBlock() : "";

/** The xhigh reasoning-effort patch, verbatim, with the helper it lists payloads through. */
const XHIGH_BLOCK = hasBash && hasPython3
  ? `${payloadHelpers()}\n${sliceScript("# Patch the installed openclaw deepseek plugin JSON", "# Reconciliation, second half")}`
  : "";

const PINNED = (release: string) => `clawhub:@openclaw/deepseek-provider@${release}`;
const NPM_PINNED = (release: string) => `npm:@openclaw/deepseek-provider@${release}`;
const UNPINNED = "clawhub:@openclaw/deepseek-provider";

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
  /** Specs the fake CLI lets run into `timeout`'s deadline (exit 124). */
  hang?: string[];
  /** The line the fake CLI prints on stderr when it refuses a spec; `refused <spec>` by default. */
  refusal?: string;
  /** Whether openclaw.json carries a deepseek provider with a key. */
  configured?: boolean;
  /** Whether the plugin is already on disk from ClawHub (`extensions/deepseek/`). */
  present?: boolean;
  /** An npm payload already on disk, and the version its package.json declares. */
  npmPayload?: { version: string; flat?: boolean };
  /** Whether openclaw.json already carries `plugins.entries.deepseek.enabled: false`. */
  entryDisabled?: boolean;
  /** Whether openclaw.json already carries `plugins.entries.deepseek.enabled: true`. */
  entryEnabled?: boolean;
  /** Whether a repair marker for deepseek is already on disk, and what it says. */
  marked?: { disabled: boolean; reason?: string; spec?: string; atMs?: number };
  /** Make `config set` refuse, as an unwritable config would. */
  refuseConfigSet?: boolean;
  /**
   * What `plugins enable` answers: it switches the entry on and exits 0 unless
   * given a refusal, which it prints and exits 1 on — AFTER switching the entry
   * on, as the real verb does (it writes the entry before it loads anything).
   */
  enableRefusal?: string;
  /** What `plugins inspect --all --json` prints; nothing by default. */
  inspectAll?: string;
}

/** Where the 2026.9.4 CLI put an npm install of the plugin, measured against a scratch state directory. */
function npmPayloadDir(home: string, flat = false): string {
  return flat
    ? path.join(home, "npm", "node_modules", "@openclaw", "deepseek-provider")
    : path.join(home, "npm", "projects", "openclaw-deepseek-provider-2481ed984b", "node_modules", "@openclaw", "deepseek-provider");
}

function run(opts: RunOptions): { installs: string[]; argv: string[]; calls: string[]; stdout: string; stderr: string } {
  const home = path.join(dir, "openclaw-home");
  mkdirSync(home, { recursive: true });
  if (opts.present) {
    mkdirSync(path.join(home, "extensions", "deepseek"), { recursive: true });
    writeFileSync(path.join(home, "extensions", "deepseek", "openclaw.plugin.json"), "{}");
  }
  if (opts.npmPayload) {
    const payload = npmPayloadDir(home, opts.npmPayload.flat);
    mkdirSync(payload, { recursive: true });
    writeFileSync(path.join(payload, "openclaw.plugin.json"), "{}");
    writeFileSync(
      path.join(payload, "package.json"),
      JSON.stringify({ name: "@openclaw/deepseek-provider", version: opts.npmPayload.version }),
    );
  }
  const config = path.join(dir, "openclaw.json");
  const document: Record<string, unknown> = opts.configured === false
    ? { models: { providers: {} } }
    : { models: { providers: { deepseek: { apiKey: "sk-test", baseUrl: "https://clawbox.com/api/ai" } } } };
  if (opts.entryDisabled) document.plugins = { entries: { deepseek: { enabled: false } } };
  if (opts.entryEnabled) document.plugins = { entries: { deepseek: { enabled: true } } };
  writeFileSync(config, JSON.stringify(document));
  if (opts.marked) {
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({
      deepseek: {
        id: "deepseek", stage: "install", reason: opts.marked.reason ?? "offline", atMs: opts.marked.atMs ?? 1,
        disabled: opts.marked.disabled, spec: opts.marked.spec ?? "clawhub:@openclaw/deepseek-provider@2026.8.1",
      },
    }));
  }
  const log = path.join(dir, "installs.log");
  const argvLog = path.join(dir, "argv.log");
  const callsLog = path.join(dir, "calls.log");
  const bin = path.join(dir, "openclaw");
  // Records every `plugins install <spec>` and refuses the specs it is told
  // to — a ClawHub build the runtime rejects exits non-zero the same way.
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${callsLog}"`,
      // `plugins enable` switches the entry on through the same writer, then
      // refuses if told to — the real verb writes the entry first.
      'if [ "$1" = "plugins" ] && [ "$2" = "enable" ]; then',
      '  "$0" config set "plugins.entries[\\"$3\\"].enabled" true --strict-json || exit 1',
      ...(opts.enableRefusal ? [`  echo '${opts.enableRefusal}' >&2`, "  exit 1"] : ["  exit 0"]),
      "fi",
      'if [ "$1" = "plugins" ] && [ "$2" = "inspect" ] && [ "$3" = "--all" ]; then',
      `  printf '%s' '${opts.inspectAll ?? ""}'`,
      "  exit 0",
      "fi",
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
      `if [ "$2" = "install" ]; then echo "$3" >> "${log}"; echo "$*" >> "${argvLog}"; fi`,
      `for r in ${(opts.hang ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      '  if [ "$3" = "$r" ]; then echo "Resolving $3..."; exit 124; fi',
      "done",
      `for r in ${(opts.refuse ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      `  if [ "$3" = "$r" ]; then echo ${opts.refusal ? `'${opts.refusal}'` : '"refused $3"'} >&2; exit 1; fi`,
      "done",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
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
  if (result.status !== 0) throw new Error(`block exited ${result.status}: ${result.stderr}`);
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").filter(Boolean) : []);
  return {
    installs: lines(log), argv: lines(argvLog), calls: lines(callsLog), stdout: result.stdout, stderr: result.stderr ?? "",
  };
}

function markerPath(): string {
  return path.join(dir, "data", "plugin-repair.json");
}

function config(): { plugins?: { entries?: Record<string, { enabled?: boolean } | undefined> } } {
  return JSON.parse(readFileSync(path.join(dir, "openclaw.json"), "utf-8"));
}

function marker(): Record<string, { disabled?: boolean; reason?: string; spec?: string }> {
  return existsSync(markerPath()) ? JSON.parse(readFileSync(markerPath(), "utf-8")) : {};
}

describe.skipIf(!hasBash || !hasPython3)("gateway-pre-start.sh deepseek plugin install", () => {
  it("installs the build matching the installed core and stops there", () => {
    const { installs, stdout } = run({ effective: "2026.8.1" });
    expect(installs).toEqual(["clawhub:@openclaw/deepseek-provider@2026.8.1"]);
    expect(stdout).toContain("installed (clawhub:@openclaw/deepseek-provider@2026.8.1)");
  });

  it("asks npm for the core's own build when ClawHub does not have it (TASK-1302)", () => {
    // The 4.1 box: ClawHub answers "Version not found" for 2026.9.4, npm has it.
    const { installs, argv, stdout } = run({
      effective: "2026.9.4",
      refuse: [PINNED("2026.9.4")],
      refusal: "Version not found on ClawHub: @openclaw/deepseek-provider@2026.9.4.",
      entryDisabled: true,
      marked: { disabled: true },
    });
    expect(installs).toEqual([PINNED("2026.9.4"), NPM_PINNED("2026.9.4")]);
    // `--force` is the CLI's consent to a non-ClawHub source.
    expect(argv[1]).toBe(`plugins install ${NPM_PINNED("2026.9.4")} --force --accept-capabilities`);
    expect(argv[0]).toBe(`plugins install ${PINNED("2026.9.4")} --accept-capabilities`);
    expect(stdout).toContain(`installed (${NPM_PINNED("2026.9.4")})`);
    // …and the "Repair needed" row goes, with the entry back on.
    expect(marker()).toEqual({});
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(true);
  });

  it("falls back to the unpinned spec only when neither registry has the core's build", () => {
    const { installs, stdout } = run({
      effective: "2026.9.1",
      refuse: [PINNED("2026.9.1"), NPM_PINNED("2026.9.1")],
    });
    expect(installs).toEqual([PINNED("2026.9.1"), NPM_PINNED("2026.9.1"), UNPINNED]);
    expect(stdout).toContain(`installed (${UNPINNED})`);
  });

  it("warns, and keeps booting, when no spec installs — naming the LAST refusal, not the first", () => {
    const { installs, stdout } = run({
      effective: "2026.9.4",
      refuse: [PINNED("2026.9.4"), NPM_PINNED("2026.9.4"), UNPINNED],
    });
    expect(installs).toEqual([PINNED("2026.9.4"), NPM_PINNED("2026.9.4"), UNPINNED]);
    expect(stdout).toContain("WARN: could not install @openclaw/deepseek-provider");
    const row = marker().deepseek;
    expect(row?.reason).toMatch(/openclaw plugins install exited 1: refused clawhub:@openclaw\/deepseek-provider$/);
    expect(row?.spec).toBe(PINNED("2026.9.4"));
  });

  it("does not wait on a ClawHub that timed out twice, but still asks npm", () => {
    // A blocking ExecStartPre: a ClawHub that let the pinned spec run into its
    // deadline is not asked again for the unpinned one.
    const { installs, stdout } = run({
      effective: "2026.9.4",
      hang: [PINNED("2026.9.4")],
      refuse: [NPM_PINNED("2026.9.4")],
    });
    expect(installs).toEqual([PINNED("2026.9.4"), NPM_PINNED("2026.9.4")]);
    expect(marker().deepseek?.reason).toContain(`exited 1: refused ${NPM_PINNED("2026.9.4")}`);
    expect(stdout).toContain("WARN: could not install @openclaw/deepseek-provider");
  });

  it("installs from npm once ClawHub timed out on the pinned build", () => {
    const { installs } = run({ effective: "2026.9.4", hang: [PINNED("2026.9.4")] });
    expect(installs).toEqual([PINNED("2026.9.4"), NPM_PINNED("2026.9.4")]);
    expect(marker()).toEqual({});
  });

  it("goes straight to the unpinned spec when the core's release is unknown", () => {
    const { installs } = run({ effective: "" });
    expect(installs).toEqual(["clawhub:@openclaw/deepseek-provider"]);
  });

  it("installs nothing when the plugin is already on disk", () => {
    expect(run({ effective: "2026.8.1", present: true }).installs).toEqual([]);
  });

  it("installs nothing when npm already put the core's own build on disk (TASK-1302)", () => {
    // Looking only at `extensions/deepseek/` read this payload as missing on
    // every boot, and the reinstall refused ("plugin already exists").
    expect(run({ effective: "2026.9.4", npmPayload: { version: "2026.9.4" } }).installs).toEqual([]);
    expect(run({ effective: "2026.9.4", npmPayload: { version: "2026.9.4", flat: true } }).installs).toEqual([]);
    expect(run({ effective: "2026.9.4", npmPayload: { version: "2026.9.4-1" } }).installs).toEqual([]);
  });

  it("reinstalls over an npm payload an older core left behind", () => {
    // Keyed to the core generation, so the new core cannot reach it (TASK-602).
    const { installs } = run({
      effective: "2026.9.5",
      npmPayload: { version: "2026.9.4" },
      refuse: [PINNED("2026.9.5")],
    });
    expect(installs).toEqual([PINNED("2026.9.5"), NPM_PINNED("2026.9.5")]);
  });

  it("takes any npm payload as installed when the core's release is unknown", () => {
    expect(run({ effective: "", npmPayload: { version: "2026.9.4" } }).installs).toEqual([]);
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
    // …and the row says what is wrong NOW, not the install refusal this boot
    // has just got past (TASK-1302). Still ClawBox's switch-off.
    expect(marker().deepseek?.reason).toBe(
      "The DeepSeek provider plugin, which ClawBox AI runs on, is installed "
        + `(${PINNED("2026.8.1")}) but could not be switched on.`,
    );
    expect(marker().deepseek?.disabled).toBe(true);
  });

  it("switches ClawBox AI's plugin on for its row even when the row says ClawBox never switched it off (TASK-1302)", () => {
    // The board's TEST 2 at boot. The row a 4.1 boot filed says `disabled:
    // false` — there was no entry to switch off yet — while the entry is an
    // explicit `false`: what `openclaw plugins uninstall deepseek` leaves
    // behind (measured, 2026.9.4). This used to clear the row over the entry
    // it left off — ClawBox AI dead, with nothing on screen to say so.
    const { stdout } = run({ effective: "2026.8.1", entryDisabled: true, marked: { disabled: false } });
    expect(stdout).toContain("Switched the deepseek plugin back on after repairing it");
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(true);
    expect(marker()).toEqual({});
  });

  it("leaves an entry the owner switched off his when no row asks for the plugin", () => {
    const { stdout, installs } = run({ effective: "2026.8.1", entryDisabled: true });
    expect(installs).toEqual([PINNED("2026.8.1")]);
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
    expect(marker()).toEqual({});
    expect(stdout).toContain("no repair record asks for it; leaving it as the owner set it");
  });
});

// TASK-1302, hardware validation: the state a Retry's install left on the
// board — the npm payload of the running core on disk, the entry still an
// explicit `false`, and the row still open. The install block's guard sees the
// payload and skips, the consent loop visits only entries that are already on,
// and the re-attempt block only rows that say `disabled: true`: the gateway
// restart the install itself triggered came up with ClawBox AI off and the row
// still reading "Version not found on ClawHub".
describe.skipIf(!hasBash || !hasPython3)("gateway-pre-start.sh deepseek — payload on disk, entry off, row open", () => {
  const VERSION_NOT_FOUND_ROW = {
    disabled: false,
    atMs: 1790685915162,
    spec: PINNED("2026.9.4"),
    reason: "The DeepSeek provider plugin, which ClawBox AI runs on, could not be installed. The device may be offline, "
      + "or the package registry unreachable. openclaw plugins install exited 1: Version not found on ClawHub: "
      + "@openclaw/deepseek-provider@2026.9.4.",
  };
  const CONSENTED = inspectAllJson([{ id: "deepseek" }]);
  const boardState = {
    effective: "2026.9.4",
    npmPayload: { version: "2026.9.4" },
    entryDisabled: true,
    marked: VERSION_NOT_FOUND_ROW,
  };

  it("switches it on with its capabilities accepted, proves it, and clears the row — without reinstalling", () => {
    const { installs, calls, stdout } = run({ ...boardState, inspectAll: CONSENTED });
    expect(installs).toEqual([]);
    expect(calls).toContain("plugins enable deepseek --accept-capabilities");
    // Proven against a report taken AFTER the write.
    expect(calls.indexOf("plugins inspect --all --json")).toBeGreaterThan(calls.indexOf("plugins enable deepseek --accept-capabilities"));
    expect(stdout).toContain("deepseek plugin switched on and its capabilities accepted");
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(true);
    expect(marker()).toEqual({});
  });

  it("puts it back off and files what is wrong NOW when the core refuses the switch-on", () => {
    const { stderr } = run({
      ...boardState,
      enableRefusal: "Error: plugin deepseek failed to register: state schema 18 is newer than this OpenClaw supports",
    });
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
    const row = marker().deepseek;
    expect(row?.reason).toBe(
      "The DeepSeek provider plugin, which ClawBox AI runs on, is installed but could not be switched on. "
        + "openclaw plugins enable exited 1: Error: plugin deepseek failed to register: state schema 18 is newer "
        + "than this OpenClaw supports",
    );
    expect(row?.reason).not.toContain("Version not found");
    // The switch-off is ClawBox's now: the verb had switched the entry on.
    expect(row?.disabled).toBe(true);
    expect((row as { stage?: string })?.stage).toBe("consent");
    // The spec the row carried is kept for the Retry.
    expect(row?.spec).toBe(PINNED("2026.9.4"));
    expect(stderr).toContain("could not switch the deepseek plugin on for its repair record");
  });

  it("does not trust an exit code: a consent the core still reports pending puts it back off", () => {
    run({ ...boardState, inspectAll: inspectAllJson([{ id: "deepseek", consentRequired: true }]) });
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
    expect(marker().deepseek?.reason).toContain(
      "is installed but could not be switched on. The core still reports it as requiring capability consent",
    );
  });

  it("files the row as the install it is when the core cannot find the payload", () => {
    run({ ...boardState, enableRefusal: "Plugin not found: deepseek" });
    const row = marker().deepseek as { stage?: string; reason?: string };
    expect(row.stage).toBe("install");
    expect(row.reason).toContain("is on disk but the core cannot find it");
  });

  it("changes nothing without a row: an entry that is off is the owner's", () => {
    const { calls } = run({ ...boardState, marked: undefined, inspectAll: CONSENTED });
    expect(calls).toEqual([]);
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
  });

  it("leaves an entry that is already on to the consent loop that owns it", () => {
    const { calls } = run({ ...boardState, entryDisabled: false, entryEnabled: true, inspectAll: CONSENTED });
    expect(calls).toEqual([]);
    expect(Object.keys(marker())).toEqual(["deepseek"]);
  });
});

/** A deepseek manifest the way the plugin ships it: V4 models declaring no efforts. */
function shippedManifest(): string {
  return JSON.stringify({
    id: "deepseek",
    modelCatalog: {
      providers: {
        deepseek: {
          models: [
            { id: "deepseek-v4-flash", compat: {} },
            { id: "deepseek-v4-pro" },
            { id: "deepseek-chat" },
          ],
        },
      },
    },
  });
}

describe.skipIf(!hasBash || !hasPython3)("gateway-pre-start.sh deepseek xhigh patch", () => {
  function patch(where: "extensions" | "npm"): Record<string, unknown> {
    const home = path.join(dir, "openclaw-home");
    const payload = where === "extensions" ? path.join(home, "extensions", "deepseek") : npmPayloadDir(home);
    mkdirSync(payload, { recursive: true });
    writeFileSync(path.join(payload, "openclaw.plugin.json"), shippedManifest());
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${XHIGH_BLOCK}`], {
      encoding: "utf-8",
      env: testEnv({
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        // A core with nothing bundled, like every OpenClaw 2 core.
        OPENCLAW_BIN: path.join(dir, "bin", "openclaw"),
        OPENCLAW_CONFIG: path.join(home, "openclaw.json"),
      }),
    });
    if (result.status !== 0) throw new Error(`block exited ${result.status}: ${result.stderr}`);
    return JSON.parse(readFileSync(path.join(payload, "openclaw.plugin.json"), "utf-8"));
  }

  const efforts = (manifest: Record<string, unknown>) =>
    ((manifest.modelCatalog as { providers: { deepseek: { models: { id: string; compat?: { supportedReasoningEfforts?: string[] } }[] } } })
      .providers.deepseek.models)
      .map((model) => [model.id, model.compat?.supportedReasoningEfforts ?? null]);

  it("declares xhigh on a ClawHub payload, as before", () => {
    expect(efforts(patch("extensions"))).toEqual([
      ["deepseek-v4-flash", ["off", "high", "xhigh"]],
      ["deepseek-v4-pro", ["off", "high", "xhigh"]],
      ["deepseek-chat", null],
    ]);
  });

  it("declares xhigh on an npm payload too (TASK-1302)", () => {
    expect(efforts(patch("npm"))).toEqual([
      ["deepseek-v4-flash", ["off", "high", "xhigh"]],
      ["deepseek-v4-pro", ["off", "high", "xhigh"]],
      ["deepseek-chat", null],
    ]);
  });
});
