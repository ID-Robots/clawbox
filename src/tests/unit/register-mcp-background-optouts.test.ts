import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The Hermes half of "Working on its own" being ON by default (owner ruling
// 2026-09-15, reversing TASK-609's opt-outs of 2026-09-03). TASK-609 seeded
// `false` into `auxiliary.background_review.enabled` and `curator.enabled`
// once per box from this script — `production-server.js` fire-and-forgets it
// on every web-server boot on hermes|dual, and it already holds
// `${HERMES_CONFIG}.lock` while it read-modify-writes the same file — and
// recorded it in `data/background-optouts.json`. This is the SECOND GENERATION
// of that record: a box is brought to both ON once, the record says
// `generation: 2`, and the harness keys are the owner's for ever.
//
// The whole real script is run, with stubs, exactly as
// `register-mcp-hermes.test.ts` runs it — the section under test writes the
// customer's config, so a copy of its logic would prove nothing about the
// shipped one.
//
// The failure shapes pinned:
//   pays nothing  — a generation-2 record naming both keys is one file read:
//                   no YAML load, no write, and a `false` the owner wrote in
//                   Settings after the migration stays his.
//   the owner's   — only a REAL boolean `false` is flipped; a string, `true`
//                   or an absence is left exactly where it is.
//   false success — nothing is recorded until the keys read back off the
//                   file, and an unusable record changes nothing and records
//                   nothing.
//   dual box      — the OpenClaw half's generation-2 rows in the shared record
//                   survive this half writing to it, and its generation-1
//                   rows are NOT carried into generation 2.

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");

const REVIEW_KEY = "auxiliary.background_review.enabled";
const CURATOR_KEY = "curator.enabled";
const HERMES_KEYS = [REVIEW_KEY, CURATOR_KEY].sort();
const OPENCLAW_KEYS = [
  "agents.defaults.heartbeat.every",
  "plugins.entries.memory-core.config.dreaming.enabled",
  "skills.workshop.autonomous.mode",
];

function have(bin: string, args: string[]): boolean {
  return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

const CAN_RUN =
  process.platform !== "win32"
  && have("bash", ["-c", "true"])
  && have("python3", ["-c", "import yaml"]);

const d = CAN_RUN ? describe : describe.skip;

/**
 * Root writes into a 0500 directory, so the one case that turns on a refused
 * write would pass there by taking the happy path and prove nothing. CI is
 * non-root; a `sudo npm test` on a box is not. Same guard, same reason, as
 * `register-mcp-hermes.test.ts`.
 */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let home: string;
let root: string;
let configPath: string;
let statePath: string;
let lockPath: string;

function run(env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAWBOX_ROOT: root,
      HERMES_CONFIG: configPath,
      HERMES_BIN: path.join(home, "fake-hermes"),
      BUN_BIN: path.join(home, "fake-bun"),
      CLAWBOX_EDITION_FILE: lockPath,
      ...env,
    }),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Read the YAML back as JSON so the assertions are about values, not formatting. */
function readConfig(): Record<string, unknown> {
  const out = execFileSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath],
    { encoding: "utf-8" },
  );
  return JSON.parse(out);
}

function at(dotted: string): unknown {
  let node: unknown = readConfig();
  for (const part of dotted.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function record(): { seeded: string[]; generation?: number } {
  return JSON.parse(fs.readFileSync(statePath, "utf-8"));
}

function writeRecord(body: unknown) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
}

const BASE = "model:\n  default: deepseek-v4-pro\n";
/** The config the previous build left behind: both opt-outs seeded. */
const OPTED_OUT = `${BASE}auxiliary:\n  background_review:\n    enabled: false\ncurator:\n  enabled: false\n`;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-optout-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-optout-root-"));
  configPath = path.join(home, ".hermes", "config.yaml");
  statePath = path.join(root, "data", "background-optouts.json");
  lockPath = path.join(home, "edition.env");

  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
  for (const bin of ["fake-hermes", "fake-bun"]) {
    const p = path.join(home, bin);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(configPath, BASE);
  fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

d("register-mcp.sh — a fresh Hermes box", () => {
  it("writes nothing into the config and records generation 2", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBeUndefined();
    expect(at(CURATOR_KEY)).toBeUndefined();
    expect(r.stdout).not.toContain("brought the Hermes background jobs");
    expect(record()).toEqual({ seeded: HERMES_KEYS, generation: 2 });
  });

  it("flips a config restored from a backup of an opted-out box", () => {
    fs.writeFileSync(configPath, OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBe(true);
    expect(at(CURATOR_KEY)).toBe(true);
    expect(r.stdout).toContain(`brought the Hermes background jobs (${REVIEW_KEY}, ${CURATOR_KEY})`);
    expect(record()).toEqual({ seeded: HERMES_KEYS, generation: 2 });
  });

  it("keeps the rest of the config", () => {
    fs.writeFileSync(
      configPath,
      `${BASE}auxiliary:\n  background_review:\n    enabled: false\n    model: keep-me\n`
      + "curator:\n  enabled: false\n  interval_hours: 168\n",
    );
    run();
    expect(at("model.default")).toBe("deepseek-v4-pro");
    expect(at("auxiliary.background_review.model")).toBe("keep-me");
    expect(at("curator.interval_hours")).toBe(168);
    expect(at(REVIEW_KEY)).toBe(true);
    expect(at(CURATOR_KEY)).toBe(true);
  });

  it("does nothing at all on an OpenClaw-only device", () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=openclaw\n");
    fs.writeFileSync(configPath, OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("runs on a dual box too, whichever harness is active", () => {
    // The web server is not restarted when the owner switches harness, so a
    // step that asked which one was active at boot would leave a box switched
    // to Hermes with its opt-outs.
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=dual\n");
    fs.writeFileSync(configPath, OPTED_OUT);
    run();
    expect(at(REVIEW_KEY)).toBe(true);
    expect(at(CURATOR_KEY)).toBe(true);
  });
});

d("register-mcp.sh — a box the previous build seeded off", () => {
  it("flips both keys still at `false`, and writes generation 2", () => {
    writeRecord({ seeded: HERMES_KEYS });
    fs.writeFileSync(configPath, OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBe(true);
    expect(at(CURATOR_KEY)).toBe(true);
    expect(r.stdout).toContain("brought the Hermes background jobs");
    expect(record()).toEqual({ seeded: HERMES_KEYS, generation: 2 });
  });

  it("leaves the one key the owner changed afterwards, and flips the other", () => {
    // He switched memory review on in Settings, which writes `true`; the
    // curator is still at the seed.
    writeRecord({ seeded: HERMES_KEYS });
    fs.writeFileSync(configPath, `${BASE}auxiliary:\n  background_review:\n    enabled: true\ncurator:\n  enabled: false\n`);
    const r = run();
    expect(at(REVIEW_KEY)).toBe(true);
    expect(at(CURATOR_KEY)).toBe(true);
    expect(r.stdout).toContain(`brought the Hermes background jobs (${CURATOR_KEY})`);
    expect(record()).toEqual({ seeded: HERMES_KEYS, generation: 2 });
  });

  it("leaves a key the owner unset by hand absent", () => {
    // Absent is the harness default and already on; pinning `true` there
    // would be a value ClawBox chose over the harness's.
    writeRecord({ seeded: HERMES_KEYS });
    fs.writeFileSync(configPath, `${BASE}curator:\n  enabled: false\n`);
    run();
    expect(at(REVIEW_KEY)).toBeUndefined();
    expect(at(CURATOR_KEY)).toBe(true);
    expect(record().generation).toBe(2);
  });

  it("does not mistake a STRING `false` for the seed", () => {
    // The CLI has been seen to exit 0 while storing a string, and the seed
    // wrote a real boolean. A string is the owner's own doing, whatever the
    // harness makes of it.
    writeRecord({ seeded: HERMES_KEYS });
    fs.writeFileSync(configPath, `${BASE}curator:\n  enabled: "false"\n`);
    const r = run();
    expect(at(CURATOR_KEY)).toBe("false");
    expect(r.stdout).not.toContain("brought");
    expect(record().generation).toBe(2);
  });
});

d("register-mcp.sh — a box already at generation 2", () => {
  it("pays nothing, and a `false` the owner wrote since stays his", () => {
    writeRecord({ seeded: HERMES_KEYS, generation: 2 });
    fs.writeFileSync(configPath, OPTED_OUT);
    const before = fs.readFileSync(statePath, "utf-8");
    // The registration step (§3) writes the config on the first run of a
    // fresh HOME; on the second it says "already current", so this block is
    // the only thing left that could touch the file.
    run();
    const config = fs.readFileSync(configPath, "utf-8");
    const stat = fs.statSync(configPath);
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBe(false);
    expect(at(CURATOR_KEY)).toBe(false);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(config);
    expect(fs.statSync(configPath).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.readFileSync(statePath, "utf-8")).toBe(before);
    expect(r.stdout).not.toContain("brought the Hermes background jobs");
  });

  it("is idempotent across boots after a migration", () => {
    writeRecord({ seeded: HERMES_KEYS });
    fs.writeFileSync(configPath, OPTED_OUT);
    run();
    const config = fs.readFileSync(configPath, "utf-8");
    const r = run();
    expect(r.status).toBe(0);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(config);
    expect(r.stdout).not.toContain("brought");
  });
});

d("register-mcp.sh — the shared record on a dual box", () => {
  it("reads the previous build's record naming only the OpenClaw keys", () => {
    writeRecord({ seeded: OPENCLAW_KEYS });
    fs.writeFileSync(configPath, OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("cannot be read");
    expect(at(REVIEW_KEY)).toBe(true);
    // The OpenClaw half's generation-1 rows are NOT carried forward: at
    // generation 2 a row means "brought to the default by this build", and a
    // carried-over row would tell that half it was done before it had looked.
    expect(record()).toEqual({ seeded: HERMES_KEYS, generation: 2 });
  });

  it("keeps the OpenClaw half's generation-2 rows when it writes its own", () => {
    writeRecord({ seeded: OPENCLAW_KEYS, generation: 2 });
    fs.writeFileSync(configPath, OPTED_OUT);
    run();
    expect(at(CURATOR_KEY)).toBe(true);
    expect(record()).toEqual({ seeded: [...OPENCLAW_KEYS, ...HERMES_KEYS].sort(), generation: 2 });
  });

  it("is not done on a generation-2 record that names none of its keys", () => {
    writeRecord({ seeded: OPENCLAW_KEYS, generation: 2 });
    run();
    expect(record().seeded).toEqual([...OPENCLAW_KEYS, ...HERMES_KEYS].sort());
  });
});

d("register-mcp.sh — what it refuses to guess about", () => {
  it.each([
    ["not JSON at all", "{{{"],
    ["not an object", "[1, 2]"],
    ["a seeded field that is not a list", JSON.stringify({ seeded: 5 })],
    ["rows that are not strings", JSON.stringify({ seeded: [1, 2] })],
    ["a generation that is not an integer", JSON.stringify({ seeded: [], generation: "2" })],
  ])("changes nothing and does not launder an unusable record: %s", (_label, body) => {
    // A record that is there and unreadable may be a generation 2 whose owner
    // has since switched a job off. And REPLACING it would make the OpenClaw
    // half of a dual box read its keys as never judged.
    writeRecord(body);
    fs.writeFileSync(configPath, OPTED_OUT);
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBe(false);
    expect(at(CURATOR_KEY)).toBe(false);
    expect(r.stderr).toContain("cannot be read");
    expect(r.stderr).not.toContain("Traceback");
    expect(fs.readFileSync(statePath, "utf-8")).toBe(body);
  });

  (isRoot ? it.skip : it)("records nothing when the config write itself fails", () => {
    // THE false-success guard: a write that did not land must never be
    // recorded as done, or the keys are never looked at again and both jobs
    // stay off. The registration step makes its write on the first run, so on
    // the second it says "already current, skipping write" and this block is
    // the only thing left that touches the file — which is what lets a
    // read-only ~/.hermes reach this block's own write rather than an earlier
    // one.
    run();
    fs.rmSync(statePath);
    fs.writeFileSync(configPath, `${fs.readFileSync(configPath, "utf-8")}curator:\n  enabled: false\n`);
    fs.chmodSync(path.join(home, ".hermes"), 0o500);
    try {
      const r = run();
      expect(r.stderr + r.stdout).toContain("could not bring the Hermes background jobs");
      expect(r.stderr + r.stdout).not.toContain("Traceback");
      expect(fs.existsSync(statePath)).toBe(false);
    } finally {
      fs.chmodSync(path.join(home, ".hermes"), 0o700);
    }
  });

  it("is never reached, and so records nothing, when the config will not parse", () => {
    // Named for what it actually pins: a config PyYAML cannot load stops the
    // script at the registration step ABOVE this block, so the block never
    // runs. That is the right outcome either way — an unreadable config
    // settles nothing — but the guard doing the work is the earlier step's,
    // and the block's own arms for the same shape are defence in depth. The
    // status is deliberately not asserted.
    fs.writeFileSync(configPath, "model:\n  default: x\n  : : :\n");
    const r = run();
    expect(r.stdout).not.toContain("brought the Hermes background jobs");
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("settles neither key when their parents are not mappings", () => {
    fs.writeFileSync(configPath, "auxiliary: a-string\ncurator: 5\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(at("auxiliary")).toBe("a-string");
    expect(at("curator")).toBe(5);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it.each([
    ["one empty section", "model:\n  default: x\ncurator:\n"],
    ["both empty", "model:\n  default: x\nauxiliary:\ncurator:\n"],
    ["an empty parent one level down", "model:\n  default: x\nauxiliary:\n  background_review:\ncurator:\n"],
  ])("treats an empty section as an absence, not as a shape it cannot read: %s", (_label, body) => {
    // `curator:` with nothing under it loads as `null`. Reading that as "a
    // parent I must not reshape" would look at it again on EVERY boot for ever
    // — a YAML load and a stderr note per boot over an empty section.
    fs.writeFileSync(configPath, body);
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBeUndefined();
    expect(at(CURATOR_KEY)).toBeUndefined();
    expect(r.stderr).not.toContain("cannot read");
    expect(record()).toEqual({ seeded: HERMES_KEYS, generation: 2 });
  });

  it("keeps the revision it is about to re-serialise at config.yaml.bak", () => {
    // The case the .bak is FOR: a box already registered, so the step above
    // says "already current, skipping write" and this block is the only thing
    // that rewrites the config on that boot — taking Hermes' own comment
    // blocks with it. The revision that had them stays at the name
    // `hermes-config-yaml.ts` uses for its own writes.
    run();
    fs.rmSync(statePath);
    const withComments = `# ── Security ──\n${fs.readFileSync(configPath, "utf-8")}curator:\n  enabled: false\n`;
    fs.writeFileSync(configPath, withComments);

    const r = run();
    expect(r.stdout).not.toContain("registered the ClawBox MCP server");
    expect(fs.readFileSync(`${configPath}.bak`, "utf-8")).toBe(withComments);
    expect(fs.statSync(`${configPath}.bak`).mode & 0o777).toBe(0o600);
    // …and the comment really is gone from the live file, which is why the
    // backup exists rather than a comment saying it does not matter.
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("── Security ──");
    expect(at(CURATOR_KEY)).toBe(true);
  });
});
