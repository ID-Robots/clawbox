import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Starts real processes (bash, python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The three pieces scripts/gateway-pre-start.sh gained for the agent-database
// work, run out of the shipped script rather than a copy:
//   - the memory-index defaults inside the one config pass (the whole python
//     heredoc runs, so the defaults are proved to land in openclaw.json and the
//     rebuild to be asked for only after they did);
//   - the detached launch of the one rebuild those defaults ask for;
//   - the compaction block at the end, and the time budget it is given.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const UNIT = path.resolve(process.cwd(), "config/clawbox-gateway.service");
const SRC = readFileSync(SCRIPT, "utf-8");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function between(from: string, to: string, startAt = 0): string {
  const start = SRC.indexOf(from, startAt);
  if (start < 0) throw new Error(`marker not found: ${from}`);
  const end = SRC.indexOf(to, start + from.length);
  if (end < 0) throw new Error(`marker not found: ${to}`);
  return SRC.slice(start, end);
}

/** The config pass: the heredoc that follows the memory-rebuild export. */
const CONFIG_PASS = (() => {
  const head = `python3 - "$OPENCLAW_CONFIG" <<'PY'\n`;
  const at = SRC.indexOf(head, SRC.indexOf("export CLAWBOX_MEMORY_REBUILD_RECORD="));
  if (at < 0) throw new Error("config pass not found after the memory-rebuild export");
  const body = at + head.length;
  return SRC.slice(body, SRC.indexOf("\nPY\n", body) + 1);
})();

let dir: string;
let cfgPath: string;
let recordPath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "prestart-db-"));
  cfgPath = path.join(dir, "openclaw.json");
  recordPath = path.join(dir, "data", "openclaw-memory-rebuild.json");
  mkdirSync(path.join(dir, "data"), { recursive: true });
});
afterEach(() => {
  try { chmodSync(dir, 0o755); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
});

function pass(config: unknown, opts: { v2?: boolean; core2026_10?: boolean } = {}) {
  writeFileSync(cfgPath, JSON.stringify(config));
  const r = spawnSync("python3", ["-", cfgPath], {
    input: CONFIG_PASS,
    encoding: "utf-8",
    env: {
      NODE_ENV: "test",
      PATH: "/usr/bin:/bin",
      HOME: dir,
      CLAWBOX_OPENCLAW_V2: opts.v2 === false ? "0" : "1",
      CLAWBOX_OPENCLAW_2026_10: opts.v2 === false || opts.core2026_10 === false ? "0" : "1",
      CLAWBOX_MEMORY_REBUILD_RECORD: recordPath,
      CLAWBOX_DEVICE_STORE: path.join(dir, "data", "config.json"),
    },
  });
  if (r.status !== 0) throw new Error(`config pass exited ${r.status}: ${r.stderr}`);
  return { out: `${r.stdout}${r.stderr}`, cfg: JSON.parse(readFileSync(cfgPath, "utf-8")) };
}
const rebuildRecord = () => JSON.parse(readFileSync(recordPath, "utf-8"));

const BOX_CLOUD = {
  provider: "openai-compatible",
  model: "text-embedding-3-large",
  remote: { baseUrl: "https://clawbox.com/api/ai", apiKey: "claw_box_token" },
};

describe.skipIf(!hasPython3)("gateway-pre-start.sh memory index defaults", () => {
  it("stops indexing session transcripts on a box that never chose to, and asks for one rebuild", () => {
    const { cfg, out } = pass({ memory: { search: { provider: "openai-compatible", model: "qwen3-embedding-0.6b" } } });
    expect(cfg.memory.search).toMatchObject({ rememberAcrossConversations: false, sources: ["memory"], model: "qwen3-embedding-0.6b" });
    expect(rebuildRecord()).toMatchObject({ pending: true, attempts: 0, reasons: ["rememberAcrossConversations", "sources"] });
    expect(out).toMatch(/Memory index: settings changed \(rememberAcrossConversations, sources\); one rebuild runs after the gateway starts/);
  });

  it("writes both keys, because sources alone does not stop transcript recall", () => {
    // `rememberAcrossConversations` defaults on for a personal install and adds
    // `sessions` to the resolved sources by itself.
    const { cfg } = pass({});
    expect(cfg.memory).toEqual({ search: { rememberAcrossConversations: false, sources: ["memory"] } });
  });

  it("keeps what an owner chose, and asks for no rebuild", () => {
    const { cfg } = pass({ memory: { search: { rememberAcrossConversations: true, sources: ["memory", "sessions"] } } });
    expect(cfg.memory.search).toEqual({ rememberAcrossConversations: true, sources: ["memory", "sessions"] });
    expect(existsSync(recordPath)).toBe(false);
  });

  it("moves the box's own cloud index from text-embedding-3-large to text-embedding-3-small, once", () => {
    const first = pass({ memory: { search: { ...BOX_CLOUD } } });
    expect(first.cfg.memory.search.model).toBe("text-embedding-3-small");
    expect(rebuildRecord()).toMatchObject({ pending: true, modelMigrated: true, reasons: ["model", "rememberAcrossConversations", "sources"] });
    // Something writes the large model back (a staging override): the move is
    // not repeated against it.
    const again = pass({ memory: { search: { ...first.cfg.memory.search, model: "text-embedding-3-large" } } });
    expect(again.cfg.memory.search.model).toBe("text-embedding-3-large");
  });

  it("leaves an owner's own endpoint on the large model alone", () => {
    const own = { ...BOX_CLOUD, remote: { baseUrl: "https://embeddings.example/v1", apiKey: "sk-owners-own" } };
    const { cfg } = pass({ memory: { search: { ...own, rememberAcrossConversations: false, sources: ["memory"] } } });
    expect(cfg.memory.search.model).toBe("text-embedding-3-large");
    expect(existsSync(recordPath)).toBe(false);
  });

  it("is a no-op the second time, and does not ask for another rebuild", () => {
    pass({ memory: { search: { ...BOX_CLOUD } } });
    const record = readFileSync(recordPath, "utf-8");
    const { out, cfg } = pass(JSON.parse(readFileSync(cfgPath, "utf-8")));
    expect(out).not.toMatch(/Memory index: settings changed/);
    expect(cfg.memory.search.model).toBe("text-embedding-3-small");
    expect(readFileSync(recordPath, "utf-8")).toBe(record);
  });

  it("writes nothing under memory on a core older than OpenClaw 2", () => {
    const { cfg } = pass({ agents: { defaults: {} } }, { v2: false });
    expect(cfg.memory).toBeUndefined();
    expect(existsSync(recordPath)).toBe(false);
  });

  it("writes nothing under memory on a 2026.9 core, which these keys are not verified on", () => {
    // A box whose update the disk pre-flight refused runs the new ClawBox on
    // the old core: a key that core refuses would be a gateway that never starts.
    const { cfg } = pass({ memory: { search: { ...BOX_CLOUD } } }, { core2026_10: false });
    expect(cfg.memory.search).toEqual(BOX_CLOUD);
    expect(existsSync(recordPath)).toBe(false);
  });

  it.skipIf(isRoot)("asks for no rebuild when the config it changed could not be written", () => {
    writeFileSync(cfgPath, JSON.stringify({}));
    chmodSync(dir, 0o555);
    const r = spawnSync("python3", ["-", cfgPath], {
      input: CONFIG_PASS,
      encoding: "utf-8",
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", HOME: dir, CLAWBOX_OPENCLAW_V2: "1", CLAWBOX_OPENCLAW_2026_10: "1", CLAWBOX_MEMORY_REBUILD_RECORD: recordPath },
    });
    chmodSync(dir, 0o755);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/could not write the gateway config/);
    expect(existsSync(recordPath)).toBe(false);
  });
});

/** A `python3` on PATH that records how it was asked, and answers PY_EXIT. */
function stubPython(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, "python3");
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$PY_ARGS"\nexit "\${PY_EXIT:-0}"\n`);
  chmodSync(stub, 0o755);
}

function runBlock(block: string, vars: Record<string, string>, env: Record<string, string>) {
  const program = [
    "set -euo pipefail",
    ...Object.entries(vars).map(([k, v]) => `${k}=${JSON.stringify(v)}`),
    block,
  ].join("\n");
  return spawnSync("bash", ["-c", program], { encoding: "utf-8", env: { NODE_ENV: "test", PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, ...env } });
}

async function waitFor(file: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (existsSync(file) && readFileSync(file, "utf-8").length > 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("gateway-pre-start.sh memory rebuild launch", () => {
  const LAUNCH = between("# The one memory-index rebuild the defaults block", "# Ensure the per-install MCP bearer token exists");

  function launch(record: string | null, core2026_10 = "1") {
    stubPython(path.join(dir, "bin"));
    if (record !== null) writeFileSync(recordPath, record);
    const args = path.join(dir, "py-args");
    const r = runBlock(LAUNCH, {
      SCRIPT_DIR: path.resolve(process.cwd(), "scripts"),
      CLAWBOX_ROOT: dir,
      CLAWBOX_OPENCLAW_2026_10: core2026_10,
      CLAWBOX_MEMORY_REBUILD_RECORD: recordPath,
      CLAWBOX_DEVICE_STORE: path.join(dir, "data", "config.json"),
      OPENCLAW_BIN: "/opt/openclaw/bin/openclaw",
    }, { PY_ARGS: args });
    return { r, args };
  }

  it("starts the rebuild detached, after the gateway, when one is pending", async () => {
    const { r, args } = launch(JSON.stringify({ pending: true }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Memory index rebuild running in the background once the gateway is up/);
    expect(await waitFor(args)).toBe(true);
    const argv = readFileSync(args, "utf-8").trim().split("\n");
    expect(argv.slice(0, 3)).toEqual(["-I", path.resolve(process.cwd(), "scripts/openclaw-db-maintenance.py"), "memory-rebuild"]);
    expect(argv).toEqual(expect.arrayContaining(["--openclaw-bin", "/opt/openclaw/bin/openclaw", "--gateway-port", "18789"]));
  });

  it.each([
    ["nothing is pending", JSON.stringify({ pending: false })],
    ["no rebuild was ever asked for", null],
  ])("starts nothing when %s", async (_why, record) => {
    const { r, args } = launch(record);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(await waitFor(args)).toBe(false);
  });

  it("starts nothing on a core older than 2026.10", async () => {
    const { r, args } = launch(JSON.stringify({ pending: true }), "0");
    expect(r.status).toBe(0);
    expect(await waitFor(args)).toBe(false);
  });
});

describe("gateway-pre-start.sh agent database housekeeping block", () => {
  const BLOCK = between("# ── Agent databases: migration status, compaction, migration copies", "# ── End of pre-start");

  function housekeeping(env: Record<string, string> = {}, core2026_10 = "1") {
    stubPython(path.join(dir, "bin"));
    const args = path.join(dir, "py-args");
    const r = runBlock(BLOCK, {
      SCRIPT_DIR: path.resolve(process.cwd(), "scripts"),
      CLAWBOX_ROOT: dir,
      CLAWBOX_OPENCLAW_2026_10: core2026_10,
      OPENCLAW_STATE_DIR: path.join(dir, ".openclaw"),
      OPENCLAW_CONFIG: path.join(dir, ".openclaw", "openclaw.json"),
      OPENCLAW_BIN: "/opt/oc/bin/openclaw",
    }, { PY_ARGS: args, ...env });
    const argv = existsSync(args) ? readFileSync(args, "utf-8").trim().split("\n") : [];
    const opt = (name: string) => argv[argv.indexOf(name) + 1];
    return { r, argv, opt };
  }

  it("runs the helper's prestart over the gateway's own tree with the full budget on a quick start", () => {
    const { r, argv, opt } = housekeeping();
    expect(r.status).toBe(0);
    expect(argv.slice(0, 3)).toEqual(["-I", path.resolve(process.cwd(), "scripts/openclaw-db-maintenance.py"), "prestart"]);
    expect(opt("--state-dir")).toBe(path.join(dir, ".openclaw"));
    expect(opt("--data-dir")).toBe(path.join(dir, "data"));
    expect(opt("--openclaw-bin")).toBe("/opt/oc/bin/openclaw");
    expect(opt("--core-pkg")).toBe("/opt/oc/bin/../lib/node_modules/openclaw/package.json");
    expect(opt("--budget-seconds")).toBe("360");
    expect(r.stdout).toMatch(/Agent databases: checking \(compaction budget 360s\)/);
  });

  it("shrinks the budget to what the unit's ceiling leaves after the rest of the pre-start", () => {
    // A ceiling of 200 s with 90 s held back leaves 110 s at most.
    const { opt } = housekeeping({ CLAWBOX_PRESTART_CEILING_S: "200" });
    expect(Number(opt("--budget-seconds"))).toBeLessThanOrEqual(110);
    expect(Number(opt("--budget-seconds"))).toBeGreaterThanOrEqual(100);
  });

  it("never hands a negative budget, and still records the status", () => {
    const { opt } = housekeeping({ CLAWBOX_PRESTART_CEILING_S: "10" });
    expect(opt("--budget-seconds")).toBe("0");
  });

  it("falls back to the defaults over a non-numeric override", () => {
    const { opt } = housekeeping({ CLAWBOX_DB_COMPACT_BUDGET_S: "lots", CLAWBOX_PRESTART_CEILING_S: "soon" });
    expect(opt("--budget-seconds")).toBe("360");
  });

  it("turns a failed helper into a WARN, never a failed gateway start", () => {
    const { r } = housekeeping({ PY_EXIT: "9" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARN: agent database housekeeping stopped \(exit 9\); the gateway starts on the databases as they are/);
  });

  it("does nothing on a core older than 2026.10, whose compaction commands are not verified", () => {
    const { r, argv } = housekeeping({}, "0");
    expect(r.status).toBe(0);
    expect(argv).toEqual([]);
  });

  it("budgets inside the unit's TimeoutStartSec, with the helper's own slack on top", () => {
    const unit = readFileSync(UNIT, "utf-8");
    const timeoutStart = Number(/^TimeoutStartSec=(\d+)$/m.exec(unit)?.[1]);
    expect(timeoutStart).toBe(600);
    expect(BLOCK).toContain('CLAWBOX_PRESTART_CEILING_S="${CLAWBOX_PRESTART_CEILING_S:-600}"');
    // budget + 30 s of helper slack + 10 s kill-after, all inside what is held back.
    expect(BLOCK).toContain('timeout -k 10 "$(( _dbm_budget + 30 ))"');
    expect(BLOCK).toContain("CLAWBOX_PRESTART_CEILING_S - 90 - SECONDS");
  });

  it("is the last thing the pre-start does", () => {
    const after = SRC.slice(SRC.indexOf("# ── Agent databases: migration status, compaction, migration copies"));
    expect(after.split("\n").filter((l) => /^\s*[^#\s]/.test(l)).length).toBeGreaterThan(0);
    expect(SRC.trimEnd().endsWith("# ── End of pre-start ────────────────────────────────────────────────────────")).toBe(true);
    expect(SRC.indexOf("# ── Agent databases:")).toBeGreaterThan(SRC.indexOf("# ── Report the installed Claude Code to Anthropic"));
  });
});

describe("gateway-pre-start.sh start-loop recovery block", () => {
  const BLOCK = between("# ── Start-loop recovery", "# ── First boot on a NEW OpenClaw core");

  /** The block with a `python3` that records its argv and a `systemctl` answering NRestarts. */
  function guard(env: Record<string, string> = {}, core2026_10 = "1") {
    const binDir = path.join(dir, "bin");
    stubPython(binDir);
    writeFileSync(path.join(binDir, "systemctl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${dir}/systemctl-args"\nprintf '%s\\n' "\${NRESTARTS:-0}"\n`);
    chmodSync(path.join(binDir, "systemctl"), 0o755);
    const openclaw = path.join(dir, "oc", "openclaw");
    mkdirSync(path.dirname(openclaw), { recursive: true });
    writeFileSync(openclaw, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(openclaw, 0o755);
    const args = path.join(dir, "py-args");
    rmSync(args, { force: true });
    const r = runBlock(BLOCK, {
      SCRIPT_DIR: path.resolve(process.cwd(), "scripts"),
      CLAWBOX_ROOT: dir,
      CLAWBOX_OPENCLAW_2026_10: core2026_10,
      OPENCLAW_STATE_DIR: path.join(dir, ".openclaw"),
      OPENCLAW_CONFIG: path.join(dir, ".openclaw", "openclaw.json"),
      OPENCLAW_BIN: openclaw,
    }, { PY_ARGS: args, ...env });
    const argv = existsSync(args) ? readFileSync(args, "utf-8").trim().split("\n") : [];
    const opt = (name: string) => argv[argv.indexOf(name) + 1];
    return { r, argv, opt, openclaw };
  }

  it("hands the helper systemd's count of automatic restarts and the gateway's own tree", () => {
    const { r, argv, opt, openclaw } = guard({ NRESTARTS: "4" });
    expect(r.status).toBe(0);
    expect(argv.slice(0, 3)).toEqual(["-I", path.resolve(process.cwd(), "scripts/openclaw-db-maintenance.py"), "start-guard"]);
    expect(readFileSync(path.join(dir, "systemctl-args"), "utf-8").trim()).toBe("show clawbox-gateway.service -p NRestarts --value");
    expect(opt("--restarts")).toBe("4");
    expect(opt("--unit")).toBe("clawbox-gateway.service");
    expect(opt("--state-dir")).toBe(path.join(dir, ".openclaw"));
    expect(opt("--config")).toBe(path.join(dir, ".openclaw", "openclaw.json"));
    expect(opt("--data-dir")).toBe(path.join(dir, "data"));
    expect(opt("--openclaw-bin")).toBe(openclaw);
    // Most of the unit's 600 s, 150 held back for the rest of the pre-start.
    expect(Number(opt("--budget-seconds"))).toBeGreaterThanOrEqual(440);
    expect(Number(opt("--budget-seconds"))).toBeLessThanOrEqual(450);
  });

  it("counts an unreadable restart count as none", () => {
    const { opt } = guard({ NRESTARTS: "[not set]" });
    expect(opt("--restarts")).toBe("0");
  });

  it("turns a failed helper into a WARN, never a failed gateway start", () => {
    const { r } = guard({ PY_EXIT: "7" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARN: start-loop recovery stopped \(exit 7\); the gateway starts as it is/);
  });

  it("does nothing on a core older than 2026.10, whose session-sqlite recovery is not verified", () => {
    const { r, argv } = guard({}, "0");
    expect(r.status).toBe(0);
    expect(argv).toEqual([]);
  });

  it("runs before the first config repair, and inside the unit's TimeoutStartSec", () => {
    expect(SRC.indexOf("# ── Start-loop recovery")).toBeLessThan(SRC.indexOf("# ── First boot on a NEW OpenClaw core"));
    expect(SRC.indexOf("# ── Start-loop recovery")).toBeGreaterThan(SRC.indexOf("export CLAWBOX_OPENCLAW_2026_10"));
    expect(BLOCK).toContain("_sg_budget=$(( _sg_ceiling - 150 - SECONDS ))");
    expect(BLOCK).toContain('timeout -k 10 "$(( _sg_budget + 30 ))"');
  });
});

describe("gateway-pre-start.sh 2026.10 gate", () => {
  const GATE = between("# OpenClaw 2026.10 or later.", "# ── Start-loop recovery");

  function gate(effective: string, explicit?: string): string {
    const r = spawnSync("bash", ["-c", [
      "set -euo pipefail",
      `CLAWBOX_OPENCLAW_EFFECTIVE=${JSON.stringify(effective)}`,
      GATE,
      'printf "%s" "$CLAWBOX_OPENCLAW_2026_10"',
    ].join("\n")], { encoding: "utf-8", env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", ...(explicit === undefined ? {} : { CLAWBOX_OPENCLAW_2026_10: explicit }) } });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  }

  it.each([
    ["2026.10.3", "1"],
    ["2026.10.0", "1"],
    ["2026.11.2", "1"],
    ["2027.1.0", "1"],
    ["2026.9.4", "0"],
    ["2026.8.1", "0"],
    ["", "0"],
  ])("reads core %j as %s", (effective, expected) => {
    expect(gate(effective)).toBe(expected);
  });

  it("lets an explicit value win, as CLAWBOX_OPENCLAW_V2 does", () => {
    expect(gate("2026.9.4", "1")).toBe("1");
    expect(gate("2026.10.3", "0")).toBe("0");
  });
});
