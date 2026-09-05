import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// TASK-606: what the gateway boot does when a plugin the config depends on
// cannot be installed or consented.
//
// It used to log "gateway will still start" and carry on, which was not true
// under OpenClaw 2: the gateway came up, refused readiness for the unconsented
// plugin, was restarted by `Restart=always`, and burned the unit's
// `StartLimitBurst=20` in about fifteen minutes — 46 minutes with no agent and
// no Telegram, measured on a box, and nothing running as `clawbox` clears a
// start limit at boot.
//
// The owner's ruling (2026-09-03, option a): switch the entry off, record why,
// boot without it, and show a "Needs repair" row with a Retry. These run the
// BLOCKS OUT OF THE SHIPPED SCRIPT rather than a copy, so a drift fails here.
//
// The three failure shapes pinned:
//   false success — "gateway will still start" over a gateway that would not.
//                   The entry has to be provably `enabled: false` in the file,
//                   not merely commanded to be.
//   false failure — a marker only ever written is a permanent badge on a plugin
//                   that has been fine for weeks; every success clears it.
//   probe-once    — nothing is remembered between boots: the consent runs every
//                   time and the marker follows this boot's answer.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

function slice(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`gateway-pre-start.sh no longer contains ${from.trim()}`);
  return src.slice(start, end);
}

/** The repair helpers plus the managed-plugin consent loop that uses them. */
function block(): string {
  return [
    slice(
      "# ── Booting WITHOUT a plugin that could not be made loadable ",
      "# A `.openclaw` INSIDE the state directory",
    ),
    slice(
      "# ── Capability consent for the OTHER ClawBox-managed plugins ",
      "# Codex reads its ChatGPT session",
    ),
  ].join("\n");
}

let dir: string;
let root: string;
let binDir: string;
let configPath: string;
let markerPath: string;

/** An `openclaw` that fails `plugins enable` and records `config set`. */
function stubOpenclaw(body: string) {
  const p = path.join(binDir, "openclaw");
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$OC_CALLS"\n${body}\n`);
  chmodSync(p, 0o755);
}

/** The real `config set` semantics this script depends on, in ten lines. */
const CONFIG_SET_STUB = `
if [ "$1" = "config" ] && [ "$2" = "set" ]; then
  CLAWBOX_PATH="$3" CLAWBOX_VALUE="$4" python3 - "$OPENCLAW_CONFIG" <<'PY'
import json, os, re, sys
cfg_path = sys.argv[1]
with open(cfg_path) as fh:
    cfg = json.load(fh)
m = re.match(r'^plugins\\.entries\\["(.+)"\\]\\.enabled$', os.environ["CLAWBOX_PATH"])
if not m:
    raise SystemExit(1)
entry = cfg.setdefault("plugins", {}).setdefault("entries", {}).setdefault(m.group(1), {})
entry["enabled"] = os.environ["CLAWBOX_VALUE"] == "true"
with open(cfg_path, "w") as fh:
    json.dump(cfg, fh, indent=2)
PY
  exit $?
fi
if [ "$1" = "plugins" ] && [ "$2" = "enable" ]; then exit "\${OC_ENABLE_EXIT:-0}"; fi
exit 0
`;

function run(env: Record<string, string> = {}) {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_BIN=${JSON.stringify(path.join(binDir, "openclaw"))}`,
    'CLAWBOX_OPENCLAW_V2=1',
    block(),
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({
      PATH: `${binDir}:/usr/bin:/bin`,
      OPENCLAW_CONFIG: configPath,
      OC_CALLS: path.join(dir, "calls.log"),
      ...env,
    }),
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function config(): { plugins?: { entries?: Record<string, { enabled?: boolean } | undefined> } } {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function marker(): Record<string, { stage?: string; reason?: string; disabled?: boolean }> {
  return existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf-8")) : {};
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-repair-"));
  root = path.join(dir, "clawbox");
  binDir = path.join(dir, "bin");
  configPath = path.join(dir, "openclaw.json");
  markerPath = path.join(root, "data", "plugin-repair.json");
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ plugins: { entries: { discord: { enabled: true } } } }, null, 2),
  );
  stubOpenclaw(CONFIG_SET_STUB);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

d("gateway-pre-start.sh — a plugin that cannot be consented", () => {
  it("switches it off, records why, and still exits 0", () => {
    const r = run({ OC_ENABLE_EXIT: "1" });
    expect(r.status).toBe(0);

    // The whole point: the gateway can start, because the entry it would have
    // refused readiness over is off IN THE FILE.
    expect(config().plugins?.entries?.discord?.enabled).toBe(false);

    const rows = marker();
    expect(Object.keys(rows)).toEqual(["discord"]);
    expect(rows.discord.stage).toBe("consent");
    expect(rows.discord.disabled).toBe(true);
    expect(rows.discord.reason).toMatch(/capabilities could not be accepted/i);
    expect(r.stdout).toContain("booting without it");
  });

  it("leaves a plugin that consents cleanly alone", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(config().plugins?.entries?.discord?.enabled).toBe(true);
    expect(marker()).toEqual({});
  });

  it("clears a stale marker as soon as the same consent works", () => {
    run({ OC_ENABLE_EXIT: "1" });
    expect(Object.keys(marker())).toEqual(["discord"]);

    // THE FIXTURE RE-ENABLES IT, and that is not cheating — it is what the
    // Retry does, and it is the only thing that can: this loop reads
    // `plugins.entries` for entries that are ALREADY `enabled: true`, so a
    // plugin the previous boot switched off is not offered to it again. The
    // property under test is the one that is this script's own: when it does
    // consent a plugin, the badge goes. Clearing it for a plugin still switched
    // off belongs to the Retry route and to the updater, which have their own
    // tests.
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { discord: { enabled: true } } } }, null, 2),
    );
    const r = run();
    expect(r.status).toBe(0);
    expect(marker()).toEqual({});
  });

  it("leaves ClawBox's own EMAIL: plugin enabled and unmarked when its consent fails", () => {
    // It is copied out of the checkout ~450 lines further down, and that block
    // writes `enabled: true` unconditionally — so a disable here would be
    // undone in the same run, leaving a marker that says `disabled: true` over
    // a config that says otherwise, on a row no panel can render and no Retry
    // can clear. There is also no registry package for a Retry to install.
    writeFileSync(
      configPath,
      JSON.stringify(
        { plugins: { entries: { "clawbox-email-directives": { enabled: true } } } },
        null,
        2,
      ),
    );
    const r = run({ OC_ENABLE_EXIT: "1" });
    expect(r.status).toBe(0);
    expect(config().plugins?.entries?.["clawbox-email-directives"]?.enabled).toBe(true);
    expect(marker()).toEqual({});
    expect(r.stderr).toContain("EMAIL: directives may reach channels");
  });

  it("records the failure even when the entry cannot be switched off", () => {
    // A config the CLI cannot write: the box still boots, the owner still gets
    // a row that says what happened, and the marker says nothing was changed
    // on his behalf.
    stubOpenclaw('if [ "$1" = "config" ]; then exit 1; fi\nif [ "$1" = "plugins" ]; then exit 1; fi\nexit 0');
    const r = run();
    expect(r.status).toBe(0);
    expect(config().plugins?.entries?.discord?.enabled).toBe(true);
    expect(marker().discord.disabled).toBe(false);
    expect(r.stderr).toContain("could not switch the discord plugin off");
  });
});
