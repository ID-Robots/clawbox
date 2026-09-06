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

// TASK-609: OpenClaw 2 switches on three background jobs by default —
// heartbeat DMs to the owner, memory dreaming on the default model, and
// self-learning's weekly collection review — and ClawBox wrote none of those
// keys, so a box that upgraded started messaging its owner and spending his
// tokens without being asked.
//
// The owner's ruling (2026-09-03) is a SEED, not a policy: write the opt-out
// only where the key is absent, so a value he set is never overwritten and
// switching one back on is not undone at the next boot.
//
// The three failure shapes pinned:
//   probe-once    — the seed runs every boot, so a key the core adds later is
//                   still caught; it is the KEY's absence that gates it, not a
//                   marker file.
//   false success — a `config set` that fails must not be reported as a seeded
//                   box, and must not stop the gateway.
//   false failure — an owner who switched heartbeat back on must not find it
//                   off again after a reboot. That is the case this suite
//                   exists for.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

/** The shipped block, out of the real script rather than a copy of it. */
function block(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const from = "# ── OpenClaw 2's three background jobs, opted out of ONCE ";
  // Ends where the Codex flow begins. The block sits ABOVE that on purpose:
  // `gateway-pre-start-codex-runtime.test.ts` extracts from
  // `CODEX_SHOULD_LOAD=` to the managed-consent banner and runs it under
  // `set -euo pipefail` with only its own variables, so a block of ours inside
  // that slice failed on an unbound `CLAWBOX_ROOT` — six of its cases at once.
  const to = 'CODEX_SHOULD_LOAD="$NEEDS_CODEX_PLUGIN"';
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error("the background-job opt-out block is not in gateway-pre-start.sh");
  return src.slice(start, end);
}

let dir: string;
let binDir: string;
let configPath: string;
let statePath: string;

/** An `openclaw` that applies `config set --batch-json` the way the CLI does. */
function stubOpenclaw(exitCode = 0) {
  const p = path.join(binDir, "openclaw");
  writeFileSync(
    p,
    `#!/usr/bin/env bash\n`
    + `printf '%s\\n' "$*" >> "$OC_CALLS"\n`
    + `if [ "\${OC_EXIT:-${exitCode}}" != "0" ]; then exit "\${OC_EXIT:-${exitCode}}"; fi\n`
    + `if [ "$1" = "config" ] && [ "$2" = "set" ] && [ "$3" = "--batch-json" ]; then\n`
    + `  CLAWBOX_BATCH="$4" python3 - "$OPENCLAW_CONFIG" <<'PY'\n`
    + `import json, os, sys\n`
    + `cfg_path = sys.argv[1]\n`
    + `with open(cfg_path) as fh:\n`
    + `    cfg = json.load(fh)\n`
    + `for entry in json.loads(os.environ["CLAWBOX_BATCH"]):\n`
    + `    node = cfg\n`
    + `    parts = entry["path"].split(".")\n`
    + `    for part in parts[:-1]:\n`
    + `        node = node.setdefault(part, {})\n`
    + `    node[parts[-1]] = entry["value"]\n`
    + `with open(cfg_path, "w") as fh:\n`
    + `    json.dump(cfg, fh, indent=2)\n`
    + `PY\n`
    + `fi\nexit 0\n`,
  );
  chmodSync(p, 0o755);
}

function run(env: Record<string, string> = {}) {
  const program = [
    "set -euo pipefail",
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_BIN=${JSON.stringify(path.join(binDir, "openclaw"))}`,
    `CLAWBOX_ROOT=${JSON.stringify(path.join(dir, "root"))}`,
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

function config(): Record<string, never> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function at(pathStr: string): unknown {
  let node: unknown = config();
  for (const part of pathStr.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function calls(): string {
  const p = path.join(dir, "calls.log");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-optout-"));
  binDir = path.join(dir, "bin");
  configPath = path.join(dir, "openclaw.json");
  statePath = path.join(dir, "root", "data", "background-optouts.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({}, null, 2));
  stubOpenclaw();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

d("gateway-pre-start.sh — the OpenClaw 2 background-job opt-outs", () => {
  it("seeds all three on a box that has never expressed an opinion", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(at("agents.defaults.heartbeat.every")).toBe("0m");
    expect(at("plugins.entries.memory-core.config.dreaming.enabled")).toBe(false);
    expect(at("skills.workshop.autonomous.mode")).toBe("off");
    expect(r.stdout).toContain("Seeded the OpenClaw 2 background-job opt-outs");
    // One CLI start for the three keys, not three.
    expect(calls().trim().split("\n")).toHaveLength(1);
  });

  it("leaves a value the owner set alone, on every later boot", () => {
    // THE case this exists for: switching heartbeat back on in Settings must
    // not be undone by the next reboot.
    writeFileSync(
      configPath,
      JSON.stringify({ agents: { defaults: { heartbeat: { every: "30m" } } } }, null, 2),
    );
    run();
    expect(at("agents.defaults.heartbeat.every")).toBe("30m");
    // …while the two he has said nothing about are still seeded.
    expect(at("plugins.entries.memory-core.config.dreaming.enabled")).toBe(false);
    expect(at("skills.workshop.autonomous.mode")).toBe("off");
  });

  it("costs nothing on a box that is already seeded", () => {
    run();
    rmSync(path.join(dir, "calls.log"), { force: true });
    const r = run();
    expect(r.status).toBe(0);
    // No batch to write, so the CLI is never started at all — this runs inside
    // a blocking ExecStartPre and a CLI cold start is 10-12 s on a Jetson.
    expect(calls()).toBe("");
    expect(r.stdout).not.toContain("Seeded");
  });

  it("does NOT re-seed a switch the owner turned back on", () => {
    // THE ONE-WAY-SWITCH BUG. Turning check-ins on removes the key — the core's
    // own default cadence is what should decide it — and the write is followed
    // by a gateway restart whose ExecStartPre is this very script. An
    // absence-gated seed put `0m` straight back, before the gateway started, so
    // the switch could never be turned on at all.
    run();
    expect(at("agents.defaults.heartbeat.every")).toBe("0m");

    writeFileSync(configPath, JSON.stringify({}, null, 2));  // the owner's "on"
    rmSync(path.join(dir, "calls.log"), { force: true });
    const r = run();
    expect(r.status).toBe(0);
    expect(at("agents.defaults.heartbeat.every")).toBeUndefined();
    expect(calls()).toBe("");
  });

  it("records only what actually landed, so a failed seed is offered again", () => {
    const failed = run({ OC_EXIT: "1" });
    expect(failed.status).toBe(0);
    expect(existsSync(statePath)).toBe(false);

    const r = run();
    expect(r.stdout).toContain("Seeded");
    expect(at("skills.workshop.autonomous.mode")).toBe("off");
    expect(JSON.parse(readFileSync(statePath, "utf-8")).seeded).toEqual([
      "agents.defaults.heartbeat.every",
      "plugins.entries.memory-core.config.dreaming.enabled",
      "skills.workshop.autonomous.mode",
    ]);
  });

  it("settles a key the owner had already set, so removing it later is not re-seeded", () => {
    // He had a cadence of his own on the first boot. That key is recorded as
    // settled without being written — and when he later switches check-ins ON,
    // which REMOVES the key, the next boot leaves it alone.
    writeFileSync(
      configPath,
      JSON.stringify({ agents: { defaults: { heartbeat: { every: "30m" } } } }, null, 2),
    );
    run();
    expect(JSON.parse(readFileSync(statePath, "utf-8")).seeded)
      .toContain("agents.defaults.heartbeat.every");

    writeFileSync(configPath, JSON.stringify({}, null, 2));
    rmSync(path.join(dir, "calls.log"), { force: true });
    const r = run();
    expect(r.status).toBe(0);
    expect(at("agents.defaults.heartbeat.every")).toBeUndefined();
    expect(calls()).toBe("");
  });

  it("offers them again after a factory reset has emptied data/", () => {
    run();
    // `setup/reset` empties DATA_DIR and wipes ~/.openclaw; the record goes with
    // it, and a box with the core's noisy defaults back gets the opt-outs back.
    rmSync(statePath, { force: true });
    writeFileSync(configPath, JSON.stringify({}, null, 2));
    const r = run();
    expect(r.stdout).toContain("Seeded");
    expect(at("agents.defaults.heartbeat.every")).toBe("0m");
  });

  it("keeps an owner's explicit `false` for a switch, not just a truthy one", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ skills: { workshop: { autonomous: { mode: "auto" } } } }, null, 2),
    );
    run();
    expect(at("skills.workshop.autonomous.mode")).toBe("auto");
  });

  it("never fails the unit when the CLI does, and says so", () => {
    const r = run({ OC_EXIT: "1" });
    expect(r.status).toBe(0);
    expect(at("agents.defaults.heartbeat.every")).toBeUndefined();
    expect(r.stderr).toContain("could not seed");
  });

  it("does nothing on an unreadable config rather than writing a fresh one", () => {
    writeFileSync(configPath, "{ broken", "utf-8");
    const r = run();
    expect(r.status).toBe(0);
    expect(readFileSync(configPath, "utf-8")).toBe("{ broken");
    expect(calls()).toBe("");
  });
  it.each([
    ["a document that is not an object", "[1, 2]"],
    ["a `seeded` that is not a list", JSON.stringify({ seeded: 5 })],
    ["rows that are not strings", JSON.stringify({ seeded: [1, 2] })],
    ["rows that are not even hashable", JSON.stringify({ seeded: [[1]] })],
    ["a file that is not JSON at all", "{ broken"],
  ])("says so and changes nothing when the record is there but unusable: %s", (_name, body) => {
    // Only STATEPY writes this file and it always writes `{"seeded": [...]}`,
    // so this needs a hand edit or a corrupted filesystem — but every one of
    // these shapes used to raise out of the Python, which `|| true` swallowed:
    // the box neither seeded nor said why.
    //
    // "THERE AND UNUSABLE" IS NOT "ABSENT". Re-seeding on it would write `0m`
    // back over check-ins the owner has switched ON — switching them on REMOVES
    // the key, so `present()` is false for exactly the key he just changed.
    // Leaving the harness keys alone and saying so is the only answer that
    // cannot undo his choice.
    writeFileSync(statePath, body);
    const r = run();
    expect(r.status).toBe(0);
    expect(at("agents.defaults.heartbeat.every")).toBeUndefined();
    expect(at("skills.workshop.autonomous.mode")).toBeUndefined();
    expect(calls()).toBe("");
    expect(r.stderr).toContain("cannot be read");
    // …and it is left for a human to look at rather than overwritten.
    expect(readFileSync(statePath, "utf-8")).toBe(body);
  });

  it("records a well-formed set even when the batch is recorded over a stale one", () => {
    // STATEPY is reached only after a write that landed, so it must never raise
    // over the record it is replacing: `sorted()` on a mixed list did, the `if
    // !` turned that into a WARN, and the same seed was then offered at every
    // boot for ever.
    run();
    expect(JSON.parse(readFileSync(statePath, "utf-8")).seeded).toHaveLength(3);
  });
});
