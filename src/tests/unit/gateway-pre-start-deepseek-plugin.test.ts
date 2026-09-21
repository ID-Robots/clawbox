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
  /** Whether openclaw.json carries a deepseek provider with a key. */
  configured?: boolean;
  /** Whether the plugin is already on disk. */
  present?: boolean;
  /** Whether openclaw.json already carries `plugins.entries.deepseek.enabled: false`. */
  entryDisabled?: boolean;
  /** Whether a repair marker for deepseek is already on disk, and what it says. */
  marked?: { disabled: boolean };
  /** Make `config set` refuse, as an unwritable config would. */
  refuseConfigSet?: boolean;
}

function run(opts: RunOptions): { installs: string[]; stdout: string; stderr: string } {
  const home = path.join(dir, "openclaw-home");
  mkdirSync(home, { recursive: true });
  if (opts.present) {
    mkdirSync(path.join(home, "extensions", "deepseek"), { recursive: true });
    writeFileSync(path.join(home, "extensions", "deepseek", "openclaw.plugin.json"), "{}");
  }
  const config = path.join(dir, "openclaw.json");
  const document: Record<string, unknown> = opts.configured === false
    ? { models: { providers: {} } }
    : { models: { providers: { deepseek: { apiKey: "sk-test", baseUrl: "https://clawbox.com/api/ai" } } } };
  if (opts.entryDisabled) document.plugins = { entries: { deepseek: { enabled: false } } };
  writeFileSync(config, JSON.stringify(document));
  if (opts.marked) {
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({
      deepseek: {
        id: "deepseek", stage: "install", reason: "offline", atMs: 1,
        disabled: opts.marked.disabled, spec: "clawhub:@openclaw/deepseek-provider@2026.8.1",
      },
    }));
  }
  const log = path.join(dir, "installs.log");
  const bin = path.join(dir, "openclaw");
  // Records every `plugins install <spec>` and refuses the specs it is told
  // to — a ClawHub build the runtime rejects exits non-zero the same way.
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
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
      `if [ "$2" = "install" ]; then echo "$3" >> "${log}"; fi`,
      `for r in ${(opts.refuse ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      '  if [ "$3" = "$r" ]; then echo "refused $3" >&2; exit 1; fi',
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
  let installs: string[] = [];
  try {
    installs = readFileSync(log, "utf-8").trim().split("\n").filter(Boolean);
  } catch {
    /* nothing was installed */
  }
  return { installs, stdout: result.stdout, stderr: result.stderr ?? "" };
}

function markerPath(): string {
  return path.join(dir, "data", "plugin-repair.json");
}

function config(): { plugins?: { entries?: Record<string, { enabled?: boolean } | undefined> } } {
  return JSON.parse(readFileSync(path.join(dir, "openclaw.json"), "utf-8"));
}

function marker(): Record<string, { disabled?: boolean }> {
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
