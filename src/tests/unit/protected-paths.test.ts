import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";
import {
  HOME_DIR,
  PROTECTED_PATH_COMMAND_CASES,
  PROTECTED_PATH_TOOL_CASES,
} from "@/tests/fixtures/protected-path-cases";
import plugin, { onBeforeToolCall } from "../../../scripts/openclaw-plugins/clawbox-path-guard/index.mjs";
import {
  commandDenyReason,
  foldHome,
  toolCallDenyReason,
} from "../../../scripts/openclaw-plugins/clawbox-path-guard/path-guard.mjs";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// THE PIN for TASK-605. "Delete the largest of those files" cost a customer a
// 3.2 GB model download, so the ClawBox tree and the local-model folders are
// now refused — through each harness's own deny mechanism:
//
//   Hermes    `approvals.deny` fnmatch globs in ~/.hermes/config.yaml, rendered
//             by scripts/register-mcp.sh and evaluated by Hermes' own
//             tools/approval.py BEFORE the --yolo / approvals.mode=off bypass.
//   OpenClaw  a `before_tool_call` hook returning `{ block: true }`, because
//             OpenClaw 2026.8.1 has no path-scoped deny to configure.
//
// Two runtimes, one rule, and nothing they can share at run time — so the risk
// is drift, and this file is what stands against it. Every command case below
// goes through BOTH: the OpenClaw plugin's own matcher, and Python's `fnmatch`
// (the very module Hermes uses) against the globs that scripts/register-mcp.sh
// actually WROTE into a config file. Nothing here re-implements the renderer;
// if the script stops emitting a rule, these cases stop passing.

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");
const TABLE = path.join(REPO, "config", "protected-paths.json");

function have(bin: string, args: string[]): boolean {
  return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

// bash + python3 + PyYAML are present on the device and on CI Linux; a
// developer machine without them skips the Hermes half rather than failing.
const CAN_RENDER =
  process.platform !== "win32"
  && have("bash", ["-c", "true"])
  && have("python3", ["-c", "import yaml"]);

let home: string;
let root: string;
let denyGlobs: string[];

/**
 * The command as Hermes' matcher sees it: `_match_user_deny_rule` lowercases
 * and strips each variant produced by `_normalize_command_for_detection`, whose
 * one transformation that matters here is folding the resolved home directory
 * into `~/` (`_rewrite_resolved_user_home`). The plugin does the same fold, for
 * the same reason and with the same helper, which is why this can reuse it.
 */
function asHermesSeesIt(command: string): string {
  return foldHome(command, HOME_DIR).toLowerCase().trim();
}

/** Every candidate through Python's fnmatch in ONE interpreter start. */
function hermesVerdicts(candidates: string[]): boolean[] {
  const program = [
    "import fnmatch, json, sys",
    "payload = json.loads(sys.stdin.read())",
    "globs = [p.lower() for p in payload['globs']]",
    "print(json.dumps([any(fnmatch.fnmatchcase(c, g) for g in globs) for c in payload['candidates']]))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", program], {
    input: JSON.stringify({ globs: denyGlobs, candidates }),
    encoding: "utf-8",
  });
  return JSON.parse(out);
}

beforeAll(() => {
  if (!CAN_RENDER) return;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-deny-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-deny-root-"));

  // The pieces register-mcp.sh insists on before it writes anything, plus the
  // real table — the point of the exercise is the globs the shipped table
  // renders to, not a fixture's.
  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.copyFileSync(TABLE, path.join(root, "config", "protected-paths.json"));
  for (const bin of ["fake-hermes", "fake-bun"]) {
    const p = path.join(home, bin);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  const configPath = path.join(home, ".hermes", "config.yaml");
  fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
  fs.writeFileSync(path.join(home, "edition.env"), "CLAWBOX_EDITION=hermes\n");

  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAWBOX_ROOT: root,
      HERMES_CONFIG: configPath,
      HERMES_BIN: path.join(home, "fake-hermes"),
      BUN_BIN: path.join(home, "fake-bun"),
      CLAWBOX_EDITION_FILE: path.join(home, "edition.env"),
    }),
  });
  expect(r.status, `register-mcp.sh failed: ${r.stderr}`).toBe(0);

  const cfg = JSON.parse(
    execFileSync(
      "python3",
      ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath],
      { encoding: "utf-8" },
    ),
  );
  denyGlobs = (cfg.approvals?.deny ?? []) as string[];
});

afterAll(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const d = CAN_RENDER ? describe : describe.skip;

d("Hermes — approvals.deny rendered into ~/.hermes/config.yaml", () => {
  it("covers both path sets the ruling names", () => {
    expect(denyGlobs.length).toBeGreaterThan(0);
    // The ClawBox tree AND the model folders, wherever they are — the incident
    // file was in a second checkout outside ~/clawbox.
    for (const protectedRoot of ["/clawbox", "/llamacpp/models", "/embed/models"]) {
      expect(
        denyGlobs.some((g) => g.includes(protectedRoot)),
        `no approvals.deny rule mentions ${protectedRoot}`,
      ).toBe(true);
    }
  });

  it("adds nothing on a second run and keeps a rule the owner wrote", () => {
    const configPath = path.join(home, ".hermes", "config.yaml");
    const before = fs.readFileSync(configPath, "utf-8");
    expect(before).toContain("deny:");

    // An owner's own rule survives, and ours are not written twice.
    execFileSync(
      "python3",
      [
        "-c",
        [
          "import sys, yaml",
          "p = sys.argv[1]",
          "cfg = yaml.safe_load(open(p))",
          "cfg['approvals']['deny'].append('*shutdown*')",
          "yaml.safe_dump(cfg, open(p, 'w'), default_flow_style=False, sort_keys=False)",
        ].join("\n"),
        configPath,
      ],
      { encoding: "utf-8" },
    );
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf-8",
      env: testEnv({
        PATH: process.env.PATH ?? "",
        HOME: home,
        CLAWBOX_ROOT: root,
        HERMES_CONFIG: configPath,
        HERMES_BIN: path.join(home, "fake-hermes"),
        BUN_BIN: path.join(home, "fake-bun"),
        CLAWBOX_EDITION_FILE: path.join(home, "edition.env"),
      }),
    });
    expect(r.status).toBe(0);

    const cfg = JSON.parse(
      execFileSync(
        "python3",
        ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath],
        { encoding: "utf-8" },
      ),
    );
    const after = cfg.approvals.deny as string[];
    expect(after).toContain("*shutdown*");
    expect(new Set(after).size).toBe(after.length);
    for (const glob of denyGlobs) expect(after).toContain(glob);
  });
});

describe("one rule, two harnesses — every command answered the same way", () => {
  const cases = PROTECTED_PATH_COMMAND_CASES;

  it.each(cases)("OpenClaw: $command", ({ command, denied, why }) => {
    const reason = commandDenyReason(command, HOME_DIR);
    expect(reason !== null, `${why} — got ${reason ?? "allowed"}`).toBe(denied);
  });

  (CAN_RENDER ? it : it.skip)("Hermes answers identically for every case", () => {
    const verdicts = hermesVerdicts(cases.map((c) => asHermesSeesIt(c.command)));
    const disagreements = cases
      .map((c, i) => ({ ...c, hermes: verdicts[i] }))
      .filter((c) => c.hermes !== c.denied)
      .map((c) => `${c.denied ? "must deny" : "must allow"} ${c.command} (${c.why})`);
    expect(disagreements).toEqual([]);
  });
});

describe("OpenClaw — the shapes only a structured hook can see", () => {
  it.each(PROTECTED_PATH_TOOL_CASES)("$toolName: $why", ({ toolName, params, derivedPaths, denied }) => {
    const reason = toolCallDenyReason({ toolName, params, derivedPaths }, HOME_DIR);
    expect(reason !== null).toBe(denied);
  });

  it("registers before_tool_call and blocks with a reason the agent can relay", () => {
    const hooks: string[] = [];
    plugin.register({ on: (name: string) => hooks.push(name) });
    expect(hooks).toEqual(["before_tool_call"]);

    const result = onBeforeToolCall({
      toolName: "exec",
      params: { command: `rm ${HOME_DIR}/clawbox/data/llamacpp/models/gemma.gguf` },
    });
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("protected");
    // No approval, no prompt — the ruling was explicit that this is silent.
    expect(result).not.toHaveProperty("requireApproval");
  });

  it("has no opinion about a tool it does not know", () => {
    expect(onBeforeToolCall({ toolName: "web_search", params: { query: "rm ~/clawbox" } })).toBeUndefined();
  });
});
