import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// "Working on its own" is ON by default (owner ruling 2026-09-15, reversing
// TASK-609's opt-outs of 2026-09-03). TASK-609 seeded `0m` / `false` / `off`
// into the three OpenClaw background-job keys once per box and recorded it in
// `data/background-optouts.json` as `{"seeded": [...]}`; this is the SECOND
// GENERATION of that record — a box is brought to all three ON once, the
// record says `generation: 2`, and the harness keys are the owner's for ever.
//
// The failure shapes pinned:
//   pays nothing  — a generation-2 record is one file read: no CLI start (10 s
//                   on a Jetson, inside a blocking ExecStartPre), no write.
//   the owner's   — only a key still AT the literal ClawBox seeded is flipped;
//                   a value he set, or an absent key, is left exactly there.
//   never `0m`    — the block writes the cadence key in ONE direction only:
//                   removal. Re-seeding `0m` at boot is the one-way switch
//                   TASK-609 had to guard against, and now nothing writes it.
//   false success — nothing is recorded until every write landed, and an
//                   unusable record changes nothing and records nothing.
//   dual box      — the file also carries `register-mcp.sh`'s Hermes rows;
//                   each half is done only when generation 2 names ITS keys.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

const HEARTBEAT = "agents.defaults.heartbeat.every";
const DREAMING = "plugins.entries.memory-core.config.dreaming.enabled";
const MODE = "skills.workshop.autonomous.mode";
const OPENCLAW_KEYS = [HEARTBEAT, DREAMING, MODE];
const HERMES_KEYS = ["auxiliary.background_review.enabled", "curator.enabled"];

/** The shipped block, out of the real script rather than a copy of it. */
function block(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const from = "# ── OpenClaw 2's three background jobs, brought to their defaults ONCE ";
  // Ends where the Codex flow begins. The block sits ABOVE that on purpose:
  // `gateway-pre-start-codex-runtime.test.ts` extracts from
  // `CODEX_SHOULD_LOAD=` to the managed-consent banner and runs it under
  // `set -euo pipefail` with only its own variables, so a block of ours inside
  // that slice failed on an unbound `CLAWBOX_ROOT` — six of its cases at once.
  const to = 'CODEX_SHOULD_LOAD="$NEEDS_CODEX_PLUGIN"';
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error("the background-job block is not in gateway-pre-start.sh");
  return src.slice(start, end);
}

let dir: string;
let binDir: string;
let configPath: string;
let statePath: string;

/**
 * An `openclaw` that applies `config set --batch-json` and `config unset` the
 * way the CLI does — including `unset`'s exit 1 on an absent path.
 */
function stubOpenclaw(exitCode = 0) {
  const p = path.join(binDir, "openclaw");
  writeFileSync(
    p,
    `#!/usr/bin/env bash\n`
    + `printf '%s\\n' "$*" >> "$OC_CALLS"\n`
    + `if [ "\${OC_EXIT:-${exitCode}}" != "0" ]; then exit "\${OC_EXIT:-${exitCode}}"; fi\n`
    + `if [ "$1" = "config" ] && [ "$2" = "unset" ] && [ "\${OC_UNSET_EXIT:-0}" != "0" ]; then exit "$OC_UNSET_EXIT"; fi\n`
    + `if [ "$1" = "config" ] && { [ "$2" = "set" ] && [ "$3" = "--batch-json" ] || [ "$2" = "unset" ]; }; then\n`
    + `  CLAWBOX_VERB="$2" CLAWBOX_ARG="\${4:-$3}" python3 - "$OPENCLAW_CONFIG" <<'PY'\n`
    + `import json, os, sys\n`
    + `cfg_path = sys.argv[1]\n`
    + `with open(cfg_path) as fh:\n`
    + `    cfg = json.load(fh)\n`
    + `if os.environ["CLAWBOX_VERB"] == "unset":\n`
    + `    parts = os.environ["CLAWBOX_ARG"].split(".")\n`
    + `    node = cfg\n`
    + `    for part in parts[:-1]:\n`
    + `        node = node.get(part) if isinstance(node, dict) else None\n`
    + `    if not isinstance(node, dict) or parts[-1] not in node:\n`
    + `        sys.exit(1)\n`
    + `    del node[parts[-1]]\n`
    + `else:\n`
    + `    for entry in json.loads(os.environ["CLAWBOX_ARG"]):\n`
    + `        node = cfg\n`
    + `        parts = entry["path"].split(".")\n`
    + `        for part in parts[:-1]:\n`
    + `            node = node.setdefault(part, {})\n`
    + `        node[parts[-1]] = entry["value"]\n`
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

function calls(): string[] {
  const p = path.join(dir, "calls.log");
  return existsSync(p) ? readFileSync(p, "utf-8").trim().split("\n").filter(Boolean) : [];
}

function record(): { seeded: string[]; generation?: number } {
  return JSON.parse(readFileSync(statePath, "utf-8"));
}

/** The config the previous build left behind: all three opt-outs seeded. */
const OPTED_OUT = {
  agents: { defaults: { heartbeat: { every: "0m" } } },
  plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
  skills: { workshop: { autonomous: { mode: "off" } } },
};

function writeConfig(body: unknown) {
  writeFileSync(configPath, JSON.stringify(body, null, 2));
}

/** The previous build's record: every key named, no generation. */
function writeGen1(keys: string[] = OPENCLAW_KEYS) {
  writeFileSync(statePath, JSON.stringify({ seeded: keys }, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-optout-"));
  binDir = path.join(dir, "bin");
  configPath = path.join(dir, "openclaw.json");
  statePath = path.join(dir, "root", "data", "background-optouts.json");
  mkdirSync(path.dirname(statePath), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeConfig({});
  stubOpenclaw();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const UNUSABLE: [string, string | Buffer][] = [
  ["a document that is not an object", "[1, 2]"],
  ["a `seeded` that is not a list", JSON.stringify({ seeded: 5 })],
  ["rows that are not strings", JSON.stringify({ seeded: [1, 2] })],
  ["rows that are not even hashable", JSON.stringify({ seeded: [[1]] })],
  ["a `generation` that is not an integer", JSON.stringify({ seeded: [], generation: "2" })],
  ["a `generation` that is a boolean", JSON.stringify({ seeded: [], generation: true })],
  ["a file that is not JSON at all", "{ broken"],
  // REAL BYTES. `"�"` in a source file is written out as EF BF BD, which
  // is valid UTF-8 and decodes fine — so a case named for the decode guard was
  // passing through `JSONDecodeError`, the branch that was already there.
  // These are the shapes a power cut mid-write actually leaves.
  ["a file that is not even UTF-8", Buffer.from([0xff, 0xfe, 0x00, 0x67, 0x61, 0x72, 0x62])],
  ["a document nested past the decoder's limit", "[".repeat(200_000)],
];

d("gateway-pre-start.sh — a fresh box", () => {
  it("seeds nothing into the config and records generation 2", () => {
    // The core's defaults are already on. No CLI start, and the config is not
    // even rewritten — the record alone says this box has been judged.
    const r = run();
    expect(r.status).toBe(0);
    expect(config()).toEqual({});
    expect(calls()).toEqual([]);
    expect(r.stdout).not.toContain("Brought");
    expect(record()).toEqual({ seeded: OPENCLAW_KEYS, generation: 2 });
  });

  it("flips a config restored from a backup of an opted-out box", () => {
    // No record — `data/` is not in the backup — but the literals are. That
    // is the migration case in every way but the file, and gets the same answer.
    writeConfig(OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    expect(at(HEARTBEAT)).toBeUndefined();
    expect(at(DREAMING)).toBe(true);
    expect(at(MODE)).toBe("auto");
    expect(r.stdout).toContain("Brought the OpenClaw 2 background jobs");
    expect(record()).toEqual({ seeded: OPENCLAW_KEYS, generation: 2 });
  });

  it("leaves a value the owner set alone, whatever it is", () => {
    writeConfig({
      agents: { defaults: { heartbeat: { every: "30m" } } },
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
      skills: { workshop: { autonomous: { mode: "propose" } } },
    });
    const r = run();
    expect(r.status).toBe(0);
    expect(at(HEARTBEAT)).toBe("30m");
    expect(at(DREAMING)).toBe(true);
    expect(at(MODE)).toBe("propose");
    expect(calls()).toEqual([]);
    expect(record().generation).toBe(2);
  });
});

d("gateway-pre-start.sh — a box the previous build seeded off", () => {
  it("flips every key still at its opt-out, and writes generation 2", () => {
    writeGen1();
    writeConfig(OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    // Check-ins by REMOVING the key — the core's own cadence decides, and it
    // differs by auth mode, so ClawBox pins nothing.
    expect(at(HEARTBEAT)).toBeUndefined();
    expect(at("agents.defaults.heartbeat")).toEqual({});
    expect(at(DREAMING)).toBe(true);
    expect(at(MODE)).toBe("auto");
    expect(r.stdout).toContain("Brought the OpenClaw 2 background jobs");
    // One batch for the two values, one unset for the cadence: two CLI starts
    // on the migrating boot and never more.
    expect(calls()).toHaveLength(2);
    expect(calls()[0]).toContain("config set --batch-json");
    expect(calls()[1]).toBe(`config unset ${HEARTBEAT}`);
    expect(record()).toEqual({ seeded: OPENCLAW_KEYS, generation: 2 });
  });

  it("leaves the one key the owner changed afterwards, and flips the rest", () => {
    writeGen1();
    writeConfig({ ...OPTED_OUT, agents: { defaults: { heartbeat: { every: "2h" } } } });
    run();
    expect(at(HEARTBEAT)).toBe("2h");
    expect(at(DREAMING)).toBe(true);
    expect(at(MODE)).toBe("auto");
    // No unset was issued for a cadence that is his.
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toContain("config set --batch-json");
    expect(record().generation).toBe(2);
  });

  it("leaves a switch the owner had already turned back on", () => {
    // Check-ins ON removed the key; `propose` is a mode ClawBox never wrote.
    writeGen1();
    writeConfig({
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
      skills: { workshop: { autonomous: { mode: "propose" } } },
    });
    run();
    expect(at(HEARTBEAT)).toBeUndefined();
    expect(at(MODE)).toBe("propose");
    expect(at(DREAMING)).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(record()).toEqual({ seeded: OPENCLAW_KEYS, generation: 2 });
  });

  it("never writes `0m`, in any state", () => {
    // The one-way switch TASK-609 had to guard against: the panel's ON REMOVES
    // the key and is followed by a gateway restart whose ExecStartPre is this
    // script. Nothing this block hands the CLI may carry the literal.
    writeGen1();
    writeConfig(OPTED_OUT);
    run();
    for (const line of calls()) expect(line).not.toContain("0m");
    expect(block()).not.toMatch(/"value":\s*"0m"/);
    expect(block()).not.toMatch(/\bevery\b[^\n]*"0m",\s*True\)/);
  });

  it("records nothing when a write fails, and finishes the job next boot", () => {
    writeGen1();
    writeConfig(OPTED_OUT);
    const failed = run({ OC_EXIT: "1" });
    expect(failed.status).toBe(0);
    expect(failed.stderr).toContain("could not bring the OpenClaw 2 background jobs");
    expect(at(HEARTBEAT)).toBe("0m");
    expect(record()).toEqual({ seeded: OPENCLAW_KEYS });

    rmSync(path.join(dir, "calls.log"), { force: true });
    const r = run();
    expect(r.stdout).toContain("Brought");
    expect(at(HEARTBEAT)).toBeUndefined();
    expect(at(MODE)).toBe("auto");
    expect(record()).toEqual({ seeded: OPENCLAW_KEYS, generation: 2 });
  });

  it("retries only what did not land when the batch landed and the unset did not", () => {
    writeGen1();
    writeConfig(OPTED_OUT);
    const half = run({ OC_UNSET_EXIT: "1" });
    expect(half.status).toBe(0);
    expect(half.stderr).toContain("could not bring");
    expect(at(DREAMING)).toBe(true);
    expect(at(HEARTBEAT)).toBe("0m");
    expect(record().generation).toBeUndefined();

    rmSync(path.join(dir, "calls.log"), { force: true });
    run();
    // The two values are no longer at their literal, so only the cadence is
    // touched — one CLI start, the removal.
    expect(calls()).toEqual([`config unset ${HEARTBEAT}`]);
    expect(at(HEARTBEAT)).toBeUndefined();
    expect(record().generation).toBe(2);
  });
});

d("gateway-pre-start.sh — a box already at generation 2", () => {
  it("pays nothing: no CLI start, no write, the opt-outs the owner set since untouched", () => {
    // The owner switched two of them back OFF through the panel after the
    // migration. A generation-2 record is what makes those his.
    writeFileSync(statePath, JSON.stringify({ seeded: OPENCLAW_KEYS, generation: 2 }, null, 2) + "\n");
    writeConfig(OPTED_OUT);
    const before = readFileSync(statePath, "utf-8");
    const stat = statSync(configPath);
    const r = run();
    expect(r.status).toBe(0);
    expect(calls()).toEqual([]);
    expect(at(HEARTBEAT)).toBe("0m");
    expect(at(DREAMING)).toBe(false);
    expect(statSync(configPath).mtimeMs).toBe(stat.mtimeMs);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("is idempotent across boots after a migration", () => {
    writeGen1();
    writeConfig(OPTED_OUT);
    run();
    rmSync(path.join(dir, "calls.log"), { force: true });
    const r = run();
    expect(r.status).toBe(0);
    expect(calls()).toEqual([]);
    expect(r.stdout).not.toContain("Brought");
  });

  it("offers the defaults again after a factory reset has emptied data/", () => {
    // `setup/reset` empties DATA_DIR; a restored opted-out config with no record
    // is the fresh-box case and is flipped.
    writeGen1();
    writeConfig(OPTED_OUT);
    run();
    rmSync(statePath, { force: true });
    writeConfig(OPTED_OUT);
    const r = run();
    expect(r.stdout).toContain("Brought");
    expect(at(HEARTBEAT)).toBeUndefined();
    expect(record().generation).toBe(2);
  });
});

d("gateway-pre-start.sh — the shared record on a dual box", () => {
  it("reads a record that names only the other harness's keys", () => {
    // `register-mcp.sh` seeded its two Hermes keys first (the previous build).
    // Readable, and this half then judges its own.
    writeGen1(HERMES_KEYS);
    writeConfig(OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("cannot be read");
    expect(at(HEARTBEAT)).toBeUndefined();
    expect(at(MODE)).toBe("auto");
    // The previous build's rows are NOT carried into generation 2: at
    // generation 2 a row means "brought to the default by this build", and a
    // carried-over Hermes row would tell that half it was done before it had
    // looked. The Hermes half judges its own keys the same way this one did.
    expect(record()).toEqual({ seeded: OPENCLAW_KEYS, generation: 2 });
  });

  it("keeps the other half's generation-2 rows when it writes its own", () => {
    writeFileSync(statePath, JSON.stringify({ seeded: HERMES_KEYS, generation: 2 }, null, 2));
    writeConfig(OPTED_OUT);
    run();
    expect(at(HEARTBEAT)).toBeUndefined();
    expect(record()).toEqual({ seeded: [...HERMES_KEYS, ...OPENCLAW_KEYS].sort(), generation: 2 });
  });

  it("is not done on a generation-2 record that names none of its keys", () => {
    writeFileSync(statePath, JSON.stringify({ seeded: HERMES_KEYS, generation: 2 }, null, 2));
    run();
    expect(record().seeded).toEqual([...HERMES_KEYS, ...OPENCLAW_KEYS].sort());
  });
});

d("gateway-pre-start.sh — what it refuses to guess about", () => {
  it.each(UNUSABLE)("changes nothing and records nothing on an unusable record: %s", (_name, body) => {
    // Only STATEPY writes this file and it always writes `{"seeded": [...],
    // "generation": 2}`, so this needs a hand edit or a corrupted filesystem.
    // A record that is there and unreadable may be a generation 2 whose owner
    // has since switched a job off, and flipping it would undo him — so the
    // box says so and leaves the config exactly as it is.
    writeFileSync(statePath, body);
    writeConfig(OPTED_OUT);
    const stat = statSync(configPath);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("cannot be read");
    // No traceback: every one of these shapes used to raise out of the Python,
    // which `|| true` swallowed, and the box neither acted nor said why.
    expect(r.stderr).not.toContain("Traceback");
    expect(calls()).toEqual([]);
    expect(at(HEARTBEAT)).toBe("0m");
    expect(at(DREAMING)).toBe(false);
    expect(statSync(configPath).mtimeMs).toBe(stat.mtimeMs);
    expect(readFileSync(statePath)).toEqual(Buffer.from(body));
  });

  it("does nothing on an unreadable config rather than writing a fresh one", () => {
    writeFileSync(configPath, "{ broken", "utf-8");
    const r = run();
    expect(r.status).toBe(0);
    expect(readFileSync(configPath, "utf-8")).toBe("{ broken");
    expect(calls()).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
  });

  it("never fails the unit when the CLI does, and says so", () => {
    writeConfig(OPTED_OUT);
    const r = run({ OC_EXIT: "1" });
    expect(r.status).toBe(0);
    expect(at(HEARTBEAT)).toBe("0m");
    expect(r.stderr).toContain("could not bring");
    expect(existsSync(statePath)).toBe(false);
  });

  it("keeps the gateway starting when the plan reader fails", () => {
    // NO GATEWAY, the one outcome this block's own comment says its design
    // refuses. The readers are plain assignments in a BLOCKING ExecStartPre
    // under `set -euo pipefail`, so an unguarded failure there aborted
    // gateway-pre-start.sh outright: the box came up with no gateway at all.
    //
    // The realistic trigger is stdout pollution from a `sitecustomize`, which
    // leaves the reader an unparseable stdin. (NOT PYTHONSTARTUP: CPython reads
    // that only for an interactive interpreter, never for `-c` or `-`.) The
    // failure is injected AT the guarded call rather than modelled through its
    // cause — `python3 -c` is the readers' shape and nothing else in this block
    // uses it — so this pins the guard, not one way of reaching it.
    const real = spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf-8" })
      .stdout.trim();
    const py = path.join(binDir, "python3");
    writeFileSync(
      py,
      "#!/usr/bin/env bash\n"
      + 'if [ "$1" = "-c" ]; then exit 1; fi\n'
      + `exec ${JSON.stringify(real)} "$@"\n`,
    );
    chmodSync(py, 0o755);

    writeConfig(OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not read the background-job plan");
    // Nothing guessed at either: no CLI start, no config write, and no record,
    // so the next boot tries the whole thing again.
    expect(calls()).toEqual([]);
    expect(at(HEARTBEAT)).toBe("0m");
    expect(existsSync(statePath)).toBe(false);
  });

  it("never hands the CLI what a FAILED plan reader left on stdout", () => {
    // The shape an emptiness test cannot catch. A `sitecustomize` that prints
    // pollutes EVERY python3 in the block: SEEDPY's stdout is then unparseable,
    // so the readers raise — but their own banner is already on THEIR stdout,
    // so the variables are non-empty garbage. `|| true` alone would walk that
    // straight into `openclaw config set --batch-json "sitecustomize: hello"`,
    // and the removal's flag would be a banner. So the SHAPE is what is
    // checked, not the length — and the cadence key never travels as text.
    const real = spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf-8" })
      .stdout.trim();
    const py = path.join(binDir, "python3");
    writeFileSync(
      py,
      "#!/usr/bin/env bash\n"
      + 'echo "sitecustomize: hello"\n'
      + `exec ${JSON.stringify(real)} "$@"\n`,
    );
    chmodSync(py, 0o755);

    writeConfig(OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not read the background-job plan");
    expect(calls()).toEqual([]);
    expect(at(HEARTBEAT)).toBe("0m");
    expect(existsSync(statePath)).toBe(false);
  });
});
