import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";
import { repairHelpers, sliceScript } from "@/tests/helpers/gateway-pre-start";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// TASK-1088, the BOOT half. A box whose V4.0 update stopped against OpenClaw
// 2026.9.3 had its Codex and DeepSeek installs refused by that core, so the
// boot script switched both off and filed both as "Needs repair". Those rows
// are still on disk when the 2026.9.4 core arrives, and the install blocks
// retry them on the first boot that finds the payload missing or skewed. What
// that retry must not do:
//
//   * hand ClawBox's switch-off to the owner when it fails again — the row was
//     re-filed `disabled: false`, and the next SUCCESS then cleared the badge
//     over an entry nobody would ever switch back on;
//   * guess the cause — the row said "the device may be offline" whatever the
//     core had actually refused with;
//   * touch the credentials or the provider selection sitting beside the entry.
//
// Run out of the SHIPPED script, against a fake `openclaw` with the real
// `config set` semantics, like the rest of the pre-start suites.

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

/** The codex install/consent arm, verbatim, with the repair helpers it calls. */
function codexBlock(): string {
  return [
    repairHelpers(),
    sliceScript('if [ "$CODEX_NEEDS_INSTALL" = "1" ]; then', "# ── Capability consent for the OTHER ClawBox-managed plugins "),
  ].join("\n");
}

/** The DeepSeek provider install block, verbatim, with the repair helpers it calls. */
function deepseekBlock(): string {
  return [
    repairHelpers(),
    sliceScript(
      'if [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ ! -f "$OPENCLAW_HOME_DIR/extensions/deepseek/openclaw.plugin.json" ]; then',
      "# Resolve the workspace from agents.defaults.workspace",
    ),
  ].join("\n");
}

let dir: string;
let root: string;
let configPath: string;
let markerPath: string;
let bin: string;
let callsLog: string;

/**
 * An `openclaw` with the real `config set` semantics — the repair helpers prove
 * their writes against the FILE — whose `plugins install` refuses every spec in
 * `OC_REFUSE` (comma-separated) with `OC_REFUSAL` on stderr.
 */
function stubOpenclaw() {
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'printf \'%s\\n\' "$*" >> "$OC_CALLS"',
      'if [ "$1" = "config" ] && [ "$2" = "set" ]; then',
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
      'if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then',
      '  IFS=, read -r -a refused <<< "${OC_REFUSE:-}"',
      '  for r in "${refused[@]}"; do',
      '    if [ -n "$r" ] && [ "$3" = "$r" ]; then',
      '      echo "Installing $3..."',
      '      echo "${OC_REFUSAL:-Error: refused}" >&2',
      "      exit 1",
      "    fi",
      "  done",
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
}

/** The owner's own data beside the entries: what a repair must leave byte-for-byte. */
const OWNER_DATA = {
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.5" } } },
  auth: { profiles: { "openai-codex:default": { provider: "openai-codex", mode: "oauth" } } },
  models: { providers: { deepseek: { apiKey: "claw_owner_key", baseUrl: "https://clawbox.com/api/ai" } } },
};

function writeConfig(entries: Record<string, { enabled: boolean }>) {
  writeFileSync(configPath, JSON.stringify({ ...OWNER_DATA, plugins: { entries } }, null, 2));
}

function config(): Record<string, unknown> & { plugins?: { entries?: Record<string, { enabled?: boolean }> } } {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

type Row = {
  id?: string; stage?: string; reason?: string; atMs?: number; disabled?: boolean; spec?: string;
  retriedCore?: string; repairingSinceMs?: number;
};

function writeMarker(rows: Record<string, Row>) {
  writeFileSync(markerPath, JSON.stringify(rows, null, 2));
}

function marker(): Record<string, Row> {
  return existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf-8")) : {};
}

function calls(): string[] {
  return existsSync(callsLog) ? readFileSync(callsLog, "utf-8").trim().split("\n").filter(Boolean) : [];
}

function run(program: string, vars: Record<string, string>, env: Record<string, string> = {}) {
  const script = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_BIN=${JSON.stringify(bin)}`,
    `OPENCLAW_HOME_DIR=${JSON.stringify(path.join(dir, "openclaw-home"))}`,
    "CLAWBOX_OPENCLAW_V2=1",
    ...Object.entries(vars).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    program,
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({
      PATH: `${path.dirname(bin)}:/usr/bin:/bin`,
      OPENCLAW_CONFIG: configPath,
      OC_CALLS: callsLog,
      ...env,
    }),
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The first 2026.9.4 boot's codex arm: the payload on disk is the 2026.9.3 one, so it reinstalls. */
function runCodexInstall(env: Record<string, string> = {}) {
  return run(codexBlock(), {
    CODEX_NEEDS_INSTALL: "1",
    CODEX_INSTALL_REASON: "base version 2026.9.3 != core target 2026.9.4",
    OPENCLAW_TARGET: "2026.9.4",
    CODEX_SHOULD_LOAD: "1",
  }, env);
}

const DEEPSEEK_PINNED = "clawhub:@openclaw/deepseek-provider@2026.9.4";
const DEEPSEEK_UNPINNED = "clawhub:@openclaw/deepseek-provider";

function runDeepseekInstall(env: Record<string, string> = {}) {
  return run(deepseekBlock(), { CLAWBOX_OPENCLAW_EFFECTIVE: "2026.9.4" }, env);
}

/** The row a boot against the OLD core filed when its Codex install was refused. */
const CODEX_ROW_FROM_2026_9_3: Row = {
  id: "codex",
  stage: "install",
  reason: "The ChatGPT (Codex) plugin could not be installed. The device may be offline, or the package registry unreachable.",
  atMs: 1,
  disabled: true,
  spec: "@openclaw/codex@2026.9.3",
};

const DEEPSEEK_ROW_FROM_2026_9_3: Row = {
  id: "deepseek",
  stage: "install",
  reason: "The DeepSeek provider plugin, which ClawBox AI runs on, could not be installed. The device may be offline, or the package registry unreachable.",
  atMs: 2,
  disabled: true,
  spec: "clawhub:@openclaw/deepseek-provider@2026.9.3",
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-repair-core-update-"));
  root = path.join(dir, "clawbox");
  configPath = path.join(dir, "openclaw.json");
  markerPath = path.join(root, "data", "plugin-repair.json");
  bin = path.join(dir, "bin", "openclaw");
  callsLog = path.join(dir, "calls.log");
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  mkdirSync(path.join(dir, "openclaw-home"), { recursive: true });
  stubOpenclaw();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

d("gateway-pre-start.sh — Codex rows a 2026.9.3 boot left (TASK-1088)", () => {
  it("reinstalls for the new core, puts the entry back on and clears the row, touching nothing else", () => {
    writeConfig({ codex: { enabled: false } });
    writeMarker({ codex: CODEX_ROW_FROM_2026_9_3 });

    const r = runCodexInstall();

    expect(r.status).toBe(0);
    expect(calls()).toContain("plugins install @openclaw/codex@2026.9.4 --force --accept-capabilities");
    expect(config().plugins?.entries?.codex?.enabled).toBe(true);
    expect(marker()).toEqual({});
    // The owner's credentials and provider selection, exactly as they were.
    const { plugins: _plugins, ...rest } = config();
    void _plugins;
    expect(rest).toEqual(OWNER_DATA);
  });

  it("keeps the switch-off ClawBox's when the retry fails again, and says what the core answered", () => {
    writeConfig({ codex: { enabled: false } });
    writeMarker({ codex: { ...CODEX_ROW_FROM_2026_9_3, retriedCore: "2026.9.4" } });

    const r = runCodexInstall({
      OC_REFUSE: "@openclaw/codex@2026.9.4",
      OC_REFUSAL: "npm error code ETIMEDOUT npm error network request to https://registry.npmjs.org failed",
    });

    expect(r.status).toBe(0);
    expect(config().plugins?.entries?.codex?.enabled).toBe(false);
    const row = marker().codex;
    // The bug: `disabled: false` here said "the OWNER switched it off", which
    // is what every repair reads to decide it may not put the entry back.
    expect(row.disabled).toBe(true);
    expect(row.stage).toBe("install");
    expect(row.spec).toBe("@openclaw/codex@2026.9.4");
    expect(row.reason).toContain("openclaw plugins install exited 1: npm error code ETIMEDOUT");
    // The updater's after-update retry was already spent on this core; a boot
    // that failed the same row again has not given it another.
    expect(row.retriedCore).toBe("2026.9.4");
    expect(r.stdout).toContain("Leaving the codex plugin switched off");
  });

  it("puts the entry back on at the next boot whose install works — the badge never goes over a dead plugin", () => {
    writeConfig({ codex: { enabled: false } });
    writeMarker({ codex: CODEX_ROW_FROM_2026_9_3 });

    runCodexInstall({ OC_REFUSE: "@openclaw/codex@2026.9.4", OC_REFUSAL: "npm error code EAI_AGAIN" });
    expect(marker().codex?.disabled).toBe(true);

    runCodexInstall();

    // Before the fix the failed boot above re-filed the row `disabled: false`,
    // so this success removed the badge and left the entry OFF: ChatGPT read
    // "connected" and could not run.
    expect(config().plugins?.entries?.codex?.enabled).toBe(true);
    expect(marker()).toEqual({});
  });

  it("leaves an entry the OWNER switched off his, even when the install fails", () => {
    writeConfig({ codex: { enabled: false } });

    runCodexInstall({ OC_REFUSE: "@openclaw/codex@2026.9.4" });

    expect(marker().codex?.disabled).toBe(false);
    expect(config().plugins?.entries?.codex?.enabled).toBe(false);
  });
});

d("gateway-pre-start.sh — the DeepSeek row a 2026.9.3 boot left (TASK-1088)", () => {
  it("records the core's own refusal of the pinned spec, and keeps the switch-off ClawBox's", () => {
    writeConfig({ deepseek: { enabled: false } });
    writeMarker({ deepseek: DEEPSEEK_ROW_FROM_2026_9_3 });

    const r = runDeepseekInstall({
      OC_REFUSE: `${DEEPSEEK_PINNED},${DEEPSEEK_UNPINNED}`,
      OC_REFUSAL: "Error: clawhub registry answered 503 Service Unavailable",
    });

    expect(r.status).toBe(0);
    expect(calls().filter((call) => call.startsWith("plugins install"))).toEqual([
      `plugins install ${DEEPSEEK_PINNED} --accept-capabilities`,
      `plugins install ${DEEPSEEK_UNPINNED} --accept-capabilities`,
    ]);
    const row = marker().deepseek;
    expect(row.disabled).toBe(true);
    expect(row.spec).toBe(DEEPSEEK_PINNED);
    expect(row.reason).toContain("openclaw plugins install exited 1: Error: clawhub registry answered 503 Service Unavailable");
    expect(config().plugins?.entries?.deepseek?.enabled).toBe(false);
  });

  it("puts ClawBox AI's plugin back on when the install works, with its key untouched", () => {
    writeConfig({ deepseek: { enabled: false } });
    writeMarker({ deepseek: DEEPSEEK_ROW_FROM_2026_9_3 });

    runDeepseekInstall({ OC_REFUSE: DEEPSEEK_PINNED });

    expect(config().plugins?.entries?.deepseek?.enabled).toBe(true);
    expect(marker()).toEqual({});
    expect((config().models as typeof OWNER_DATA["models"]).providers.deepseek.apiKey).toBe("claw_owner_key");
  });
});

d("gateway-pre-start.sh — what a re-filed row keeps (TASK-1088)", () => {
  it("keeps the after-update retry already spent, and drops a stale 'repairing' stamp", () => {
    writeMarker({
      codex: { ...CODEX_ROW_FROM_2026_9_3, retriedCore: "2026.9.4", repairingSinceMs: 5 },
      deepseek: DEEPSEEK_ROW_FROM_2026_9_3,
    });

    const r = run(
      `${repairHelpers()}\nclawbox_plugin_repair_mark codex install 1 "still refused" ""`,
      {},
    );

    expect(r.status).toBe(0);
    const rows = marker();
    expect(rows.codex.retriedCore).toBe("2026.9.4");
    expect(rows.codex.repairingSinceMs).toBeUndefined();
    // An empty spec never erases the one the row carries (TASK-785).
    expect(rows.codex.spec).toBe("@openclaw/codex@2026.9.3");
    expect(rows.codex.reason).toBe("still refused");
    // …and the other plugin's row is left exactly as it was.
    expect(rows.deepseek).toEqual(DEEPSEEK_ROW_FROM_2026_9_3);
  });
});
