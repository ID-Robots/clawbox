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

// TASK-609's Hermes half. The OpenClaw half seeds its three opt-outs from
// `gateway-pre-start.sh`, the ExecStartPre of `clawbox-gateway.service` — a
// unit the Hermes SKU MASKS, so on that edition the seed never ran at all.
// Measured on the Hermes box right after the OpenClaw half shipped:
// `data/background-optouts.json` absent, and `~/.hermes/config.yaml` carrying
// neither `auxiliary.background_review.enabled` nor `curator.enabled` — both at
// the harness default of `true`, with Settings drawing switches for two jobs
// that were still running.
//
// `register-mcp.sh` is the repo's own Hermes counterpart of that pre-start
// (`production-server.js` fire-and-forgets it on every web-server boot on
// hermes|dual) and it already holds `${HERMES_CONFIG}.lock` while it
// read-modify-writes the same file, which is why the seed belongs here rather
// than in a second, unlocked writer.
//
// The whole real script is run, with stubs, exactly as
// `register-mcp-hermes.test.ts` runs it — the section under test writes the
// customer's config, so a copy of its logic would prove nothing about the
// shipped one.
//
// The three failure shapes pinned:
//   probe-once    — the seed is offered every boot until it is RECORDED, so a
//                   box whose write failed is not written off for ever.
//   false success — nothing is recorded until the keys read back off the file;
//                   a failed or unverifiable write is offered again.
//   false failure — a switch the owner turned back on must survive every later
//                   boot, and the OpenClaw half's rows in the shared record
//                   must survive this half writing to it.

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");

const REVIEW_KEY = "auxiliary.background_review.enabled";
const CURATOR_KEY = "curator.enabled";

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

function record(): unknown {
  return JSON.parse(fs.readFileSync(statePath, "utf-8"));
}

function seededRows(): string[] {
  return ((record() as { seeded: string[] }).seeded ?? []).slice().sort();
}

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
  fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
  fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

d("register-mcp.sh — the Hermes background-job opt-outs", () => {
  it("switches both off on a box that has never expressed an opinion", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBe(false);
    expect(at(CURATOR_KEY)).toBe(false);
    expect(r.stdout).toContain("seeded the Hermes background-job opt-outs");
    expect(seededRows()).toEqual([REVIEW_KEY, CURATOR_KEY].sort());
  });

  it("keeps the rest of the config", () => {
    fs.writeFileSync(
      configPath,
      "model:\n  default: deepseek-v4-pro\n"
      + "auxiliary:\n  background_review:\n    model: keep-me\n"
      + "curator:\n  interval_hours: 168\n",
    );
    run();
    expect(at("model.default")).toBe("deepseek-v4-pro");
    expect(at("auxiliary.background_review.model")).toBe("keep-me");
    expect(at("curator.interval_hours")).toBe(168);
    expect(at(REVIEW_KEY)).toBe(false);
    expect(at(CURATOR_KEY)).toBe(false);
  });

  it("leaves a value the owner set alone, and records it as settled", () => {
    fs.writeFileSync(
      configPath,
      "model:\n  default: deepseek-v4-pro\ncurator:\n  enabled: true\n",
    );
    const r = run();
    expect(at(CURATOR_KEY)).toBe(true);
    expect(at(REVIEW_KEY)).toBe(false);
    expect(r.stdout).toContain(`opt-outs (${REVIEW_KEY})`);
    // Settled without being written: ClawBox has had its say about it, so it is
    // never offered again even if he later unsets it by hand.
    expect(seededRows()).toEqual([REVIEW_KEY, CURATOR_KEY].sort());
  });

  it("does not undo a switch the owner turned back on", () => {
    // THE case this exists for. He switched memory review on in Settings, which
    // writes `true` explicitly; the next boot must not put `false` back.
    run();
    fs.writeFileSync(
      configPath,
      "model:\n  default: deepseek-v4-pro\n"
      + "auxiliary:\n  background_review:\n    enabled: true\ncurator:\n  enabled: false\n",
    );
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBe(true);
    expect(seededRows()).toEqual([REVIEW_KEY, CURATOR_KEY].sort());
  });

  it("costs no config write at all on a box that is already seeded", () => {
    run();
    const before = fs.readFileSync(configPath, "utf-8");
    const stat = fs.statSync(configPath);
    const r = run();
    expect(r.status).toBe(0);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    expect(fs.statSync(configPath).mtimeMs).toBe(stat.mtimeMs);
    expect(r.stdout).not.toContain("seeded the Hermes background-job opt-outs");
  });

  it("does nothing at all on an OpenClaw-only device", () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=openclaw\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBeUndefined();
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("seeds on a dual box too, whichever harness is active", () => {
    // The web server is not restarted when the owner switches harness, so a
    // seed that asked which one was active at boot would leave a box switched
    // to Hermes running both jobs at the harness default.
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=dual\n");
    run();
    expect(at(REVIEW_KEY)).toBe(false);
    expect(at(CURATOR_KEY)).toBe(false);
  });
});

d("register-mcp.sh — the opt-out record", () => {
  it("keeps the OpenClaw half's rows when it writes its own", () => {
    // A dual box: `gateway-pre-start.sh` seeded the three OpenClaw keys first,
    // and dropping them here would offer that half's seed all over again —
    // which for `heartbeat.every` is a REVERT, because an absent value there is
    // also what the owner's "check-ins on" looks like.
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ seeded: ["agents.defaults.heartbeat.every"] }));
    run();
    expect(seededRows()).toEqual([REVIEW_KEY, CURATOR_KEY, "agents.defaults.heartbeat.every"].sort());
  });

  it.each([
    ["not JSON at all", "{{{"],
    ["not an object", "[1, 2]"],
    ["a seeded field that is not a list", JSON.stringify({ seeded: 5 })],
    ["rows that are not strings", JSON.stringify({ seeded: [1, 2] })],
  ])("still seeds on an unusable record, and does not launder it: %s", (_label, body) => {
    // Seeding is safe — both keys are written explicitly in both directions, so
    // an absent value can only mean "no opinion". REPLACING the record is not:
    // a valid record naming only these two would make the OpenClaw half read
    // `heartbeat.every` as never seeded and write `0m` over the owner's "on".
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, body);
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBe(false);
    expect(at(CURATOR_KEY)).toBe(false);
    expect(r.stderr).toContain("cannot be read");
    expect(fs.readFileSync(statePath, "utf-8")).toBe(body);
  });

  (isRoot ? it.skip : it)("records nothing when the config write itself fails", () => {
    // THE false-success guard: a write that did not land must never be recorded
    // as seeded, or the keys are never offered again and both jobs run for ever.
    // The registration step above makes its write on the first run, so on the
    // second it says "already current, skipping write" and this seed is the
    // only thing left that touches the file — which is what lets a read-only
    // ~/.hermes reach the seed's own write rather than an earlier one.
    run();
    fs.rmSync(statePath);
    const registered = fs.readFileSync(configPath, "utf-8")
      .replace(/^curator:\n  enabled: false\n/m, "")
      .replace(/^ {4}enabled: false\n/m, "");
    fs.writeFileSync(configPath, registered);
    fs.chmodSync(path.join(home, ".hermes"), 0o500);
    try {
      const r = run();
      expect(r.stderr + r.stdout).toContain("could not write the Hermes background-job opt-outs");
      expect(r.stderr + r.stdout).not.toContain("Traceback");
      expect(fs.existsSync(statePath)).toBe(false);
    } finally {
      fs.chmodSync(path.join(home, ".hermes"), 0o700);
    }
  });

  it("is never reached, and so records nothing, when the config will not parse", () => {
    // Named for what it actually pins: a config PyYAML cannot load stops the
    // script at the registration step ABOVE this seed, so the seed never runs.
    // That is the right outcome either way — an unreadable config settles
    // nothing and is offered again — but the guard doing the work is the
    // earlier step's, not this block's, and the block's own arms for the same
    // shape are defence in depth. The status is deliberately not asserted.
    fs.writeFileSync(configPath, "model:\n  default: x\n  : : :\n");
    const r = run();
    expect(r.stdout).not.toContain("seeded the Hermes background-job opt-outs");
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
    // parent I must not reshape" would refuse the opt-out on EVERY boot for
    // ever — a job left running at the harness default with nothing but a
    // stderr note per boot, which is the outcome this task exists to remove.
    fs.writeFileSync(configPath, body);
    const r = run();
    expect(r.status).toBe(0);
    expect(at(REVIEW_KEY)).toBe(false);
    expect(at(CURATOR_KEY)).toBe(false);
    expect(r.stderr).not.toContain("cannot read");
    expect(seededRows()).toEqual([REVIEW_KEY, CURATOR_KEY].sort());
  });

  it("keeps the revision it is about to re-serialise at config.yaml.bak", () => {
    // The case the .bak is FOR: a box already registered, so the step above
    // says "already current, skipping write" and this seed is the only thing
    // that rewrites the config on that boot — taking Hermes' own comment blocks
    // with it. The revision that had them stays at the name
    // `hermes-config-yaml.ts` uses for its own writes.
    run();
    fs.rmSync(statePath);
    const withComments = `# ── Security ──\n${fs.readFileSync(configPath, "utf-8")
      .replace(/^curator:\n  enabled: false\n/m, "")
      .replace(/^ {4}enabled: false\n/m, "")}`;
    fs.writeFileSync(configPath, withComments);

    const r = run();
    expect(r.stdout).not.toContain("registered the ClawBox MCP server");
    expect(fs.readFileSync(`${configPath}.bak`, "utf-8")).toBe(withComments);
    expect(fs.statSync(`${configPath}.bak`).mode & 0o777).toBe(0o600);
    // …and the comment really is gone from the live file, which is why the
    // backup exists rather than a comment saying it does not matter.
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("── Security ──");
    expect(at(CURATOR_KEY)).toBe(false);
  });
});
