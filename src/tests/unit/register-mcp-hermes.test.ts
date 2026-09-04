import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// scripts/register-mcp.sh is what puts the ClawBox MCP server into Hermes'
// config. Before it existed, the only thing that ever registered the MCP was
// scripts/gateway-pre-start.sh — an ExecStartPre of the OpenClaw gateway unit,
// which the Hermes SKU masks — so `hermes mcp list` answered "No MCP servers
// configured" and the agent had no device tools at all.
//
// The script runs against the real ~/.hermes/config.yaml on a live appliance,
// so the properties worth pinning are the destructive ones: it must not lose
// the keys already in that file, it must not rewrite it when nothing changed,
// and it must refuse rather than overwrite when the file is not what it expects.

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");

function have(bin: string, args: string[]): boolean {
  const r = spawnSync(bin, args, { stdio: "ignore" });
  return r.status === 0;
}

// bash + python3 + PyYAML are all present on the device (and on CI Linux); a
// developer machine without them skips rather than fails.
const CAN_RUN =
  process.platform !== "win32"
  && have("bash", ["-c", "true"])
  && have("python3", ["-c", "import yaml"]);

const d = CAN_RUN ? describe : describe.skip;

/**
 * Skip ONLY where root's extra privilege changes which branch the script takes:
 * it reads a 0000 file and writes into a 0555 directory, so those cases would
 * pass by taking the happy path and prove nothing. A stubbed `chmod` is NOT
 * such a case — the stub exits 1 for every user — so the cases that turn on the
 * minting umask run everywhere. CI is non-root; a `sudo npm test` on a box is not.
 */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let home: string;
let root: string;
let configPath: string;
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

function clawboxEntry(): Record<string, unknown> {
  const cfg = readConfig();
  const servers = cfg.mcp_servers as Record<string, Record<string, unknown>> | undefined;
  return servers?.clawbox ?? {};
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-reg-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-reg-root-"));
  configPath = path.join(home, ".hermes", "config.yaml");
  lockPath = path.join(home, "edition.env");

  // The pieces the script insists on before it will write anything.
  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
  for (const bin of ["fake-hermes", "fake-bun"]) {
    const p = path.join(home, bin);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

d("register-mcp.sh — registering on Hermes", () => {
  it("adds mcp_servers.clawbox to a config that has none", () => {
    fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
    const r = run();
    expect(r.status).toBe(0);

    const entry = clawboxEntry();
    expect(entry.command).toBe(path.join(home, "fake-bun"));
    expect(entry.args).toEqual(["run", path.join(root, "mcp", "clawbox-mcp.ts")]);
    expect(entry.enabled).toBe(true);
  });

  it("keeps every key the config already had", () => {
    fs.writeFileSync(
      configPath,
      "model:\n  default: deepseek-v4-pro\nproviders:\n  clawai:\n    api_key: keep-me\nskills:\n  enabled: true\n",
    );
    run();

    const cfg = readConfig();
    expect(cfg.model).toEqual({ default: "deepseek-v4-pro" });
    expect(cfg.providers).toEqual({ clawai: { api_key: "keep-me" } });
    // `skills` keeps what it had; the script only ADDS its disabled list
    // (asserted in its own describe block below).
    expect((cfg.skills as Record<string, unknown>).enabled).toBe(true);
  });

  it("leaves an MCP server someone else registered alone", () => {
    fs.writeFileSync(configPath, "mcp_servers:\n  other:\n    url: http://example.invalid\n");
    run();

    const servers = readConfig().mcp_servers as Record<string, unknown>;
    expect(servers.other).toEqual({ url: "http://example.invalid" });
    expect(servers.clawbox).toBeTruthy();
  });

  it("writes no bearer token into the config", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();

    // The MCP server reads data/.mcp-token itself, so the config carries no
    // secret and rotating the token is not a config-sync problem.
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(raw).not.toMatch(/token/i);
    expect(JSON.stringify(clawboxEntry().env)).not.toMatch(/token/i);
  });

  it("keeps the config owner-only", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    fs.chmodSync(configPath, 0o600);
    run();
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("creates the config when Hermes has not been onboarded yet", () => {
    fs.rmSync(configPath, { force: true });
    const r = run();
    expect(r.status).toBe(0);
    expect(clawboxEntry().enabled).toBe(true);
  });

  it("mints the bearer token file if it is missing, owner-only", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    const tokenPath = path.join(root, "data", ".mcp-token");
    expect(fs.readFileSync(tokenPath, "utf-8").trim().length).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("mints the token owner-only without leaning on the chmod that follows", () => {
    // A bare `openssl rand -hex 32 > file` creates the file at the umask's
    // mode — 0644 under root's — so the secret is on disk world-readable for
    // the window before the chmod, and STAYS there when the chmod cannot run
    // (a file this uid does not own). `umask 077` in the minting subshell is
    // what makes the mode a property of the creation instead. Stubbing `chmod`
    // to fail is how that window is made visible without being two users.
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const stubBin = path.join(home, "stub-bin");
    fs.mkdirSync(stubBin, { recursive: true });
    const stub = path.join(stubBin, "chmod");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(stub, 0o755);

    const r = run({ PATH: `${stubBin}:${process.env.PATH ?? ""}` });
    expect(r.status).toBe(0);
    const tokenPath = path.join(root, "data", ".mcp-token");
    expect(fs.readFileSync(tokenPath, "utf-8").trim().length).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(tokenPath).mode & 0o077, "the bearer was left readable by other local users").toBe(0);
  });

  it.skipIf(isRoot)("still registers the MCP server when the bearer cannot be written", () => {
    // REGISTERING is this script's job; minting the bearer is a convenience it
    // does on the way past. The mint was a bare subshell in plain command
    // position, so under `set -euo pipefail` (:36) a failed redirect — a
    // root-owned token, a read-only data/ — exited the subshell 1 and killed
    // the run before it reached the reconcile. On the hermes SKU nothing else
    // writes mcp_servers.clawbox (there is no gateway pre-start), so
    // `hermes mcp list` stayed "No MCP servers configured" and the agent had NO
    // device tools at all, on every web-server boot. Nothing is lost by
    // carrying on: production-server.js seeds the same file at every
    // clawbox-setup boot and mcp/lib/api.ts reads it directly. TASK-657.
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.chmodSync(dataDir, 0o555);

    let r;
    try {
      r = run();
    } finally {
      fs.chmodSync(dataDir, 0o755);
    }

    expect(r.status, `the registration aborted:\n${r.stdout}${r.stderr}`).toBe(0);
    // The whole point: the device tools exist even though the bearer does not.
    expect(clawboxEntry().command).toBe(path.join(home, "fake-bun"));
    // And it says so, rather than failing silently or claiming it minted one.
    expect(r.stdout).toMatch(/WARN: could not write .*\.mcp-token/);
    expect(r.stdout).not.toMatch(/minted/);
    expect(fs.existsSync(path.join(dataDir, ".mcp-token"))).toBe(false);
  });

  it("does not disturb a bearer token that already exists", () => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    const tokenPath = path.join(root, "data", ".mcp-token");
    const existing = "a".repeat(64);
    fs.writeFileSync(tokenPath, existing);
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    expect(fs.readFileSync(tokenPath, "utf-8").trim()).toBe(existing);
  });
});

d("register-mcp.sh — idempotence", () => {
  it("does not rewrite the file on a second run", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    const first = fs.readFileSync(configPath, "utf-8");

    const second = run();
    expect(second.stdout).toContain("already current");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(first);
  });

  it("repairs an entry that was edited to point somewhere else", () => {
    fs.writeFileSync(
      configPath,
      "mcp_servers:\n  clawbox:\n    command: /usr/bin/false\n    args: []\n",
    );
    run();
    expect(clawboxEntry().command).toBe(path.join(home, "fake-bun"));
  });
});

d("register-mcp.sh — when it must do nothing", () => {
  it("exits without touching the config on an OpenClaw device", () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=openclaw\n");
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(readConfig().mcp_servers).toBeUndefined();
  });

  it("registers on the premium dual SKU, which also runs Hermes", () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=dual\n");
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    expect(clawboxEntry().enabled).toBe(true);
  });

  it("prefers the root-owned lock over the environment", () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=openclaw\n");
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run({ CLAWBOX_EDITION: "hermes" });
    expect(readConfig().mcp_servers).toBeUndefined();
  });

  it("does nothing when Hermes is not installed", () => {
    fs.rmSync(path.join(home, "fake-hermes"));
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(readConfig().mcp_servers).toBeUndefined();
  });
});

d("register-mcp.sh — refuses rather than clobbers", () => {
  it("fails loudly when the config is not valid YAML", () => {
    const broken = "model:\n  default: [unclosed\n";
    fs.writeFileSync(configPath, broken);
    const r = run();
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(broken);
  });

  it.skipIf(isRoot)("says why, rather than tracing back, when the config cannot be read", () => {
    // The file is THERE and unreadable — permissions, a truncated mount. The
    // `except FileNotFoundError: cfg = {}` arm beside this one is for "Hermes
    // has not been onboarded yet", and taking it here would write a config
    // holding only `mcp_servers` over one whose contents were never seen. The
    // reader had no arm for it at all, so a bare `python3` heredoc under
    // `set -euo pipefail` ended the run with a PermissionError traceback.
    // TASK-657.
    const kept = "model:\n  default: deepseek-v4-pro\n";
    fs.writeFileSync(configPath, kept);
    fs.chmodSync(configPath, 0o000);
    const r = run();
    fs.chmodSync(configPath, 0o600);
    expect(r.status).not.toBe(0);
    // Diagnosed, not traced back.
    expect(r.stderr).toMatch(/could not be read/);
    expect(r.stderr).not.toMatch(/Traceback/);
    // And the file it could not read is exactly as it was.
    expect(fs.readFileSync(configPath, "utf-8")).toBe(kept);
  });

  it("fails when the MCP entry point is missing", () => {
    fs.rmSync(path.join(root, "mcp", "clawbox-mcp.ts"));
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const r = run();
    expect(r.status).not.toBe(0);
    expect(readConfig().mcp_servers).toBeUndefined();
  });

  it("fails when bun is not where it is expected", () => {
    fs.rmSync(path.join(home, "fake-bun"));
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const r = run();
    expect(r.status).not.toBe(0);
  });
});

d("register-mcp.sh — the entry Hermes will accept", () => {
  beforeEach(() => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
  });

  it("launches a real executable, never a shell with an inline script", () => {
    // Hermes' own supply-chain gate rejects a shell interpreter as the command,
    // both when the entry is saved and again when the server is spawned.
    const entry = clawboxEntry();
    expect(path.basename(String(entry.command))).not.toMatch(/^(ba|z|k)?sh$|^cmd$/);
    expect(entry.args).toEqual(expect.arrayContaining(["run"]));
  });

  it("points the MCP at the device API on loopback", () => {
    expect(clawboxEntry().env).toEqual({ CLAWBOX_API_BASE: "http://127.0.0.1:80" });
  });

  it("allows enough time for a cold start on a loaded device", () => {
    expect(Number(clawboxEntry().connect_timeout)).toBeGreaterThanOrEqual(15);
  });
});

// Hermes seeds a bundled `email` skill category (himalaya CLI + inbox triage)
// that teaches the agent to drive a mailbox from the terminal. On a ClawBox the
// himalaya CLI is unconfigured and the device's email capability is the
// ClawBox MCP email_* tools, so the script disables those two skills through
// `skills.disabled` — the exact key agent/skill_utils.py reads. Observed live:
// "read my last 5 emails" went himalaya → failing terminal calls → a clarify
// question nothing could answer, with email_list sitting in the tool list.
d("register-mcp.sh — bundled email-skill distractors", () => {
  const DISTRACTORS = ["himalaya", "email-inbox-triage", "google-workspace"];

  function disabledSkills(): unknown {
    const skills = readConfig().skills as Record<string, unknown> | undefined;
    return skills?.disabled;
  }

  it("disables the bundled email skills on a config that never mentioned skills", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    expect(disabledSkills()).toEqual(DISTRACTORS);
  });

  it("appends to the owner's own disabled list without duplicating", () => {
    fs.writeFileSync(configPath, "skills:\n  disabled:\n    - my-own-skill\n    - himalaya\n");
    run();
    expect(disabledSkills()).toEqual(["my-own-skill", "himalaya", "email-inbox-triage", "google-workspace"]);
  });

  it("parses the JSON-string list form `hermes config set` stores", () => {
    // hermes' own parse_config_string_list treats '["a"]' as a list; writing
    // our names next to it as plain strings must not lose the owner's entry.
    fs.writeFileSync(configPath, `skills:\n  disabled: '["my-own-skill"]'\n`);
    run();
    expect(disabledSkills()).toEqual(["my-own-skill", "himalaya", "email-inbox-triage", "google-workspace"]);
  });

  it("is part of the idempotence contract: a second run rewrites nothing", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    const first = fs.readFileSync(configPath, "utf-8");
    const second = run();
    expect(second.stdout).toContain("already current");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(first);
  });

  it("leaves a skills.disabled it cannot read alone but still registers the MCP", () => {
    // A mapping under `disabled` is not a shape this script understands, and
    // the previous read of it as "nothing is disabled" would have written the
    // three distractor names straight over the owner's value. Same rule as the
    // non-mapping `skills` key below: leave it, say so, register anyway.
    fs.writeFileSync(configPath, "skills:\n  disabled:\n    himalaya: true\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(disabledSkills()).toEqual({ himalaya: true });
    expect(r.stderr).toContain("skills.disabled is not a list or a string");
    expect(clawboxEntry().enabled).toBe(true);
  });

  it("leaves a malformed skills value alone but still registers the MCP", () => {
    fs.writeFileSync(configPath, "skills: broken\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(readConfig().skills).toBe("broken");
    expect(clawboxEntry().enabled).toBe(true);
  });
});

// Hermes parks the agent's worker thread on a clarify for `agent.clarify_timeout`
// seconds — 3600 by default, and `<= 0` means forever. On an appliance that is
// an hour of a session nobody can use for anything else because one question
// went unanswered. 300s is the ClawBox default, written where the rest of this
// device's Hermes config is rendered.
d("register-mcp.sh — the clarify window this appliance ships with", () => {
  function agentBlock(): Record<string, unknown> {
    return (readConfig().agent as Record<string, unknown>) ?? {};
  }

  it("seeds agent.clarify_timeout at 300 on a config that never set it", () => {
    fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
    const r = run();
    expect(r.status).toBe(0);
    // A NUMBER, not the string `hermes config set` would have stored: upstream
    // reads it as a number and a quoted one is a different value.
    expect(agentBlock().clarify_timeout).toBe(300);
  });

  it("leaves a window the owner chose for themselves alone", () => {
    fs.writeFileSync(configPath, "agent:\n  clarify_timeout: 900\n");
    run();
    expect(agentBlock().clarify_timeout).toBe(900);
  });

  it("defers to the legacy clarify.timeout, which wins in hermes' own resolver", () => {
    // resolve_clarify_timeout reads `clarify.timeout` BEFORE
    // `agent.clarify_timeout`, so writing ours beside it would leave the file
    // claiming 300 while the box waited the owner's window.
    fs.writeFileSync(configPath, "clarify:\n  timeout: 1800\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(readConfig().agent).toBeUndefined();
    expect(clawboxEntry().enabled).toBe(true);
  });

  it("keeps the rest of the agent block untouched", () => {
    fs.writeFileSync(configPath, "agent:\n  reasoning_effort: medium\n");
    run();
    expect(agentBlock().reasoning_effort).toBe("medium");
    expect(agentBlock().clarify_timeout).toBe(300);
  });

  it("writes nothing on a second run, with the key already seeded", () => {
    // The idempotence contract, exercised through the branch this block adds:
    // the first run creates the `agent` block, and the second must find its own
    // value there and leave the file byte-identical.
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    const first = fs.readFileSync(configPath, "utf-8");
    expect(first).toContain("clarify_timeout");
    const second = run();
    expect(second.stdout).toContain("already current");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(first);
  });

  it("leaves an agent key it cannot read alone but still registers the MCP", () => {
    fs.writeFileSync(configPath, "agent: broken\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(readConfig().agent).toBe("broken");
    expect(clawboxEntry().enabled).toBe(true);
  });
});
