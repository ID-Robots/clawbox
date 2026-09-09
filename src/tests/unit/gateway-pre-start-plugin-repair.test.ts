import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

/** The repair helpers plus the managed-plugin consent loop that uses them. */
function block(): string {
  return [
    repairHelpers(),
    sliceScript(
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

function marker(): Record<string, { stage?: string; reason?: string; disabled?: boolean; spec?: string; atMs?: number }> {
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
  it("reinstalls a payload the core bump stranded, and does NOT switch the plugin off for it", () => {
    // TASK-602 and TASK-606 meet in this one loop, and the composition is the
    // point: `Plugin not found` is the core's own wording for a payload
    // stranded by a core bump (the packages are keyed to the core generation),
    // and the repair for THAT is the pinned reinstall — not disabling a channel
    // the owner asked for. Resolving this region in favour of either card alone
    // silently puts back the failure the other one exists to end.
    stubOpenclaw(`
if [ "$1" = "plugins" ] && [ "$2" = "enable" ]; then
  echo "Plugin not found: $3. Run 'openclaw plugins list' to see installed plugins." >&2
  exit 1
fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then exit "\${OC_INSTALL_EXIT:-0}"; fi
${CONFIG_SET_STUB}`);
    const r = run({ CLAWBOX_OPENCLAW_EFFECTIVE: "2026.8.1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("discord plugin payload reinstalled (@openclaw/discord@2026.8.1)");
    // Still enabled, and no badge: the box boots WITH the channel.
    expect(config().plugins?.entries?.discord?.enabled).toBe(true);
    expect(marker()).toEqual({});
  });

  it("boots without it when even the pinned reinstall fails, and records the spec to retry", () => {
    stubOpenclaw(`
if [ "$1" = "plugins" ] && [ "$2" = "enable" ]; then
  echo "Plugin not found: $3. Run 'openclaw plugins list' to see installed plugins." >&2
  exit 1
fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then exit "\${OC_INSTALL_EXIT:-0}"; fi
${CONFIG_SET_STUB}`);
    const r = run({ CLAWBOX_OPENCLAW_EFFECTIVE: "2026.8.1", OC_INSTALL_EXIT: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("could not reinstall the discord plugin payload");
    expect(r.stdout).toContain("booting without it");
    expect(config().plugins?.entries?.discord?.enabled).toBe(false);

    const row = marker().discord;
    // `install`, not `consent`: the Retry has to reinstall the payload, and it
    // must use the SAME pinned spec — `plugins install discord` would resolve
    // @latest and drift ahead of the runtime that is actually installed.
    expect(row.stage).toBe("install");
    expect(row.spec).toBe("@openclaw/discord@2026.8.1");
    expect(row.disabled).toBe(true);
  });
});

// TASK-785. The two halves of the same 46-hour badge, measured on the OpenClaw
// box: `data/plugin-repair.json` held discord at `stage: "consent"`,
// `disabled: true`, `spec: ""`, written on 2026-09-06, and eighteen reboots
// later it was still there. Nothing re-attempted it, because the loop above
// only ever visits entries openclaw.json ALREADY says to load — and this row
// describes the entry the previous boot switched OFF. The owner's Retry then
// repaired it on the first press, so the failure had been transient for days.
d("gateway-pre-start.sh — a plugin a PREVIOUS boot switched off", () => {
  /** The 2026-09-06 row off the box, as the boot script wrote it. */
  function seedStaleConsentRow() {
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { discord: { enabled: false } } } }, null, 2),
    );
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          discord: {
            id: "discord",
            stage: "consent",
            reason:
              "The plugin is installed but its capabilities could not be accepted, "
              + "so the gateway would refuse to start with it enabled.",
            atMs: 1788668446552,
            disabled: true,
            spec: "",
          },
        },
        null,
        2,
      ),
    );
  }

  it("re-attempts the consent and clears the record when it works", () => {
    seedStaleConsentRow();
    const r = run({ CLAWBOX_OPENCLAW_EFFECTIVE: "2026.8.1" });
    expect(r.status).toBe(0);

    // The entry the previous boot switched off is back on…
    expect(config().plugins?.entries?.discord?.enabled).toBe(true);
    // …and the badge is gone, because the thing it described is fixed.
    expect(marker()).toEqual({});
    // Through the core's own consent verb, run again — no Retry click.
    expect(readFileSync(path.join(dir, "calls.log"), "utf-8"))
      .toContain("plugins enable discord --accept-capabilities");
  });

  it("leaves it off and refreshes the record when the consent still fails", () => {
    seedStaleConsentRow();
    const r = run({ CLAWBOX_OPENCLAW_EFFECTIVE: "2026.8.1", OC_ENABLE_EXIT: "1" });
    expect(r.status).toBe(0);
    // Still off: the gateway must still be able to start.
    expect(config().plugins?.entries?.discord?.enabled).toBe(false);
    const row = marker().discord;
    expect(row.stage).toBe("consent");
    expect(row.disabled).toBe(true);
    // A fresh attempt, not the 2026-09-06 one.
    expect(row.atMs).toBeGreaterThan(1788668446552);
  });

  it("re-files the row as the install it needs when the payload is gone", () => {
    // A consent row over a stranded payload is a badge that can NEVER clear:
    // the Retry it offers runs `plugins enable`, which is the verb that has
    // just answered "Plugin not found". Re-filed as the install, with the spec.
    seedStaleConsentRow();
    stubOpenclaw(`
if [ "$1" = "plugins" ] && [ "$2" = "enable" ]; then
  echo "Plugin not found: $3. Run 'openclaw plugins list' to see installed plugins." >&2
  exit 1
fi
${CONFIG_SET_STUB}`);
    const r = run({ CLAWBOX_OPENCLAW_EFFECTIVE: "2026.8.1" });
    expect(r.status).toBe(0);
    expect(config().plugins?.entries?.discord?.enabled).toBe(false);
    const row = marker().discord;
    expect(row.stage).toBe("install");
    expect(row.spec).toBe("@openclaw/discord@2026.8.1");
    expect(row.disabled).toBe(true);
    expect(row.reason).toContain("Plugin not found");
  });

  it("puts the entry back off when the failed enable had already switched it on", () => {
    // `plugins enable` writes `plugins.entries.<id>.enabled` FIRST and only
    // then loads the gateway SDK, so a re-attempt that fails can leave the
    // entry ON over a plugin that still does not load — which is the readiness
    // refusal the previous boot switched it off to avoid. The record has to go
    // on saying `disabled: true` too: it is the only bit that tells the updater
    // and the next boot that this switch-off was ClawBox's own.
    seedStaleConsentRow();
    stubOpenclaw(`
if [ "$1" = "plugins" ] && [ "$2" = "enable" ]; then
  "$0" config set "plugins.entries[\\"$3\\"].enabled" true >/dev/null 2>&1 || true
  echo "Error: the gateway SDK could not be loaded" >&2
  exit 1
fi
${CONFIG_SET_STUB}`);
    const r = run({ CLAWBOX_OPENCLAW_EFFECTIVE: "2026.8.1" });
    expect(r.status).toBe(0);
    expect(config().plugins?.entries?.discord?.enabled).toBe(false);
    expect(r.stdout).toContain("Switched the discord plugin off again");
    const row = marker().discord;
    expect(row.disabled).toBe(true);
    expect(row.reason).toContain("the gateway SDK could not be loaded");
  });

  it("never turns on a disabled entry the record does not vouch for", () => {
    // No row at all: the entry is off because somebody meant it to be, and this
    // block must not so much as ask the CLI about it.
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { discord: { enabled: false } } } }, null, 2),
    );
    const r = run({ CLAWBOX_OPENCLAW_EFFECTIVE: "2026.8.1" });
    expect(r.status).toBe(0);
    expect(config().plugins?.entries?.discord?.enabled).toBe(false);
    expect(existsSync(path.join(dir, "calls.log"))).toBe(false);
  });

  it("never re-attempts a plugin the OWNER switched off", () => {
    // `disabled: false` is the boot script's record of a failure over which it
    // changed NOTHING. An entry that is off with such a row against it is off
    // because its owner said so, and no boot may turn a channel on for him.
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { discord: { enabled: false } } } }, null, 2),
    );
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          discord: {
            id: "discord",
            stage: "consent",
            reason: "The plugin is installed but its capabilities could not be accepted.",
            atMs: 1788668446552,
            disabled: false,
            spec: "",
          },
        },
        null,
        2,
      ),
    );
    const r = run({ CLAWBOX_OPENCLAW_EFFECTIVE: "2026.8.1" });
    expect(r.status).toBe(0);
    expect(config().plugins?.entries?.discord?.enabled).toBe(false);
    expect(marker().discord.atMs).toBe(1788668446552);
  });
});

d("gateway-pre-start.sh — what a consent row SAYS", () => {
  it("records the core's own refusal and the spec, not only the generic sentence", () => {
    stubOpenclaw(`
if [ "$1" = "plugins" ] && [ "$2" = "enable" ]; then
  echo "Error: capability consent failed for discord: registry snapshot is locked" >&2
  exit 1
fi
${CONFIG_SET_STUB}`);
    const r = run({ CLAWBOX_OPENCLAW_EFFECTIVE: "2026.8.1" });
    expect(r.status).toBe(0);
    const row = marker().discord;
    // The generic sentence stays — it is the one that explains the consequence.
    expect(row.reason).toMatch(/capabilities could not be accepted/i);
    // …and the CAUSE joins it, so the row names why rather than only what.
    expect(row.reason).toContain("registry snapshot is locked");
    expect(row.reason).toContain("exited 1");
    // The spec the repair needs, recorded for a consent row too.
    expect(row.spec).toBe("@openclaw/discord@2026.8.1");
  });
});
