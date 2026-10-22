import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A real bash and python per case: vitest's 5 s default is not enough on a
// loaded runner (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The 9.x -> 10.x schema migration of a customer box with ~10 GB agent
 * databases needed 30-56 GB free disk for the copies `doctor --fix` keeps. A
 * migration started on a disk that cannot hold them ran out after the new core
 * was already live, and the gateway came up reporting ready with every agent
 * degraded. `step_openclaw_install` now asks first — of the STAGED core's own
 * `openclaw.schemaVersions`, before the promotion — and refuses with a sentence
 * the updater shows (its `Error:` line), leaving the box on the core it had.
 *
 * Driven under bash with the shipped functions and the shipped helper, over
 * real SQLite files; only npm, systemctl and the free space are stood in for.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const HELPER = path.join(REPO, "scripts", "openclaw-db-maintenance.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

function assignment(name: string): string {
  const m = new RegExp(`^${name}=.*$`, "m").exec(INSTALL_SH);
  return m ? m[0] : `${name}=""`;
}

let dir: string;
let prefix: string;
let home: string;
let project: string;
let src: string;
const calls = () => readFileSync(path.join(dir, "calls"), "utf-8").split("\n").filter(Boolean);
const statusFile = () => JSON.parse(readFileSync(path.join(project, "data", "openclaw-migration-status.json"), "utf-8"));
const liveVersion = () => spawnSync("bash", [path.join(prefix, "bin", "openclaw"), "--version"], { encoding: "utf-8" }).stdout;

function makeDb(file: string, userVersion: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync("python3", ["-c", [
    "import sqlite3, sys",
    "c = sqlite3.connect(sys.argv[1])",
    "c.execute('CREATE TABLE t(b BLOB)')",
    "c.executemany('INSERT INTO t VALUES (?)', [(b'x' * 3000,) for _ in range(200)])",
    "c.execute('PRAGMA user_version=%d' % int(sys.argv[2]))",
    "c.commit(); c.close()",
  ].join("\n"), file, String(userVersion)], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** A core tree: a launcher that answers --version (and doctor), and its package.json. */
function writeCore(root: string, version: string, agent: number, state: number, doctor: "ok" | "incomplete" = "ok"): void {
  const pkg = path.join(root, "lib", "node_modules", "openclaw");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(path.join(pkg, "openclaw.mjs"), `#!/usr/bin/env bash
if [ "\${1:-}" = doctor ]; then
  printf 'doctor %s\\n' "$*" >> ${JSON.stringify(path.join(dir, "calls"))}
  ${doctor === "ok" ? "echo 'Doctor complete'; exit 0" : "echo 'startup migrations did not complete'; exit 1"}
fi
echo "OpenClaw ${version} (test)"
`);
  chmodSync(path.join(pkg, "openclaw.mjs"), 0o755);
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "openclaw", version, openclaw: { schemaVersions: { agent, state } } }));
  try { rmSync(path.join(root, "bin", "openclaw")); } catch { /* none yet */ }
  symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", path.join(root, "bin", "openclaw"));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-migration-preflight-"));
  prefix = path.join(dir, "npm-global");
  home = path.join(dir, "home");
  project = path.join(dir, "project");
  src = path.join(dir, "src");
  mkdirSync(path.join(project, "data"), { recursive: true });
  mkdirSync(path.join(src, "config"), { recursive: true });
  mkdirSync(path.join(src, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "calls"), "");
  writeFileSync(path.join(src, "config", "openclaw-target.txt"), "2026.10.3\n");
  // The 9.x box: its core and the databases it migrated to that core's schemas.
  writeCore(prefix, "2026.9.4", 21, 17);
  makeDb(path.join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite"), 21);
  makeDb(path.join(home, ".openclaw", "state", "openclaw.sqlite"), 17);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The helper the step hands to python, as shipped — or wrapped so every
 * statvfs it asks answers `freeBytes`, which is how a full disk is stood in for.
 */
function installHelper(freeBytes: number | null): void {
  const target = path.join(src, "scripts", "openclaw-db-maintenance.py");
  if (freeBytes === null) {
    writeFileSync(target, readFileSync(HELPER, "utf-8"));
    return;
  }
  writeFileSync(target, [
    "import runpy, sys",
    `sys.argv = [${JSON.stringify(HELPER)}] + sys.argv[1:] + ["--free-bytes-override", "${freeBytes}"]`,
    `runpy.run_path(${JSON.stringify(HELPER)}, run_name="__main__")`,
  ].join("\n"));
}

function runStep(opts: { freeBytes?: number | null; doctor?: "ok" | "incomplete"; helper?: boolean } = {}) {
  if (opts.helper !== false) installHelper(opts.freeBytes ?? null);
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const npm = path.join(bin, "npm");
  writeFileSync(npm, `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> ${JSON.stringify(path.join(dir, "calls"))}
prev=""
for a in "$@"; do case "$prev" in --prefix) stage="$a" ;; esac; prev="$a"; done
mkdir -p "$stage/bin" "$stage/lib/node_modules/openclaw"
cat > "$stage/lib/node_modules/openclaw/openclaw.mjs" <<'EOF'
#!/usr/bin/env bash
if [ "\${1:-}" = doctor ]; then
  printf 'doctor %s\\n' "$*" >> ${JSON.stringify(path.join(dir, "calls"))}
  ${opts.doctor === "incomplete" ? "echo 'startup migrations did not complete'; exit 1" : "echo 'Doctor complete'; exit 0"}
fi
echo "OpenClaw 2026.10.3 (new)"
EOF
chmod 755 "$stage/lib/node_modules/openclaw/openclaw.mjs"
printf '{"name":"openclaw","version":"2026.10.3","openclaw":{"schemaVersions":{"agent":24,"state":20}}}' > "$stage/lib/node_modules/openclaw/package.json"
ln -s ../lib/node_modules/openclaw/openclaw.mjs "$stage/bin/openclaw"
`);
  chmodSync(npm, 0o755);
  const log = JSON.stringify(path.join(dir, "calls"));
  const program = [
    "set -uo pipefail",
    `NPM_PREFIX=${JSON.stringify(prefix)}`,
    `OPENCLAW_BIN=${JSON.stringify(path.join(prefix, "bin", "openclaw"))}`,
    `SRC_DIR=${JSON.stringify(src)}`,
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    `PROJECT_DIR=${JSON.stringify(project)}`,
    `CLAWBOX_USER=${JSON.stringify(process.env.USER ?? "clawbox")}`,
    assignment("OPENCLAW_VERSION"),
    assignment("OPENCLAW_NODE_ENGINE"),
    assignment("OPENCLAW_SERVICE_REPAIR_POLICY"),
    "is_hermes_edition() { return 1; }",
    "has_openclaw_harness() { return 0; }",
    "ensure_clawbox_bashrc_path() { :; }",
    "ensure_openclaw_node_engine() { :; }",
    "node_engine_remedy() { :; }",
    "chown() { :; }",
    "flush_core_to_disk() { :; }",
    `stop_openclaw_gateways_for_migration() { printf 'stop-gateways\\n' >> ${log}; }`,
    `systemctl() { printf 'systemctl %s\\n' "$*" >> ${log}; }`,
    "openclaw_version_is_v2() { return 0; }",
    'as_clawbox() { while [ "${1:-}" = "-H" ]; do shift; done; "$@"; }',
    "remove_shadowing_system_openclaw() { :; }",
    shellFunction("recover_parked_openclaw_core"),
    shellFunction("promote_staged_openclaw_core"),
    shellFunction("openclaw_migration_complete"),
    shellFunction("openclaw_db_maintenance"),
    shellFunction("openclaw_migration_disk_preflight"),
    shellFunction("openclaw_record_migration_verdict"),
    // The plugin refresh after the migration is not this suite's: cut there.
    shellFunction("step_openclaw_install").replace(/\n  # Force-reinstall every externally-installed plugin[\s\S]*$/, "\n}"),
    "step_openclaw_install",
  ].join("\n");
  return spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    timeout: 25_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
}

describe.skipIf(!hasPython3)("step_openclaw_install: free disk before the schema migration", () => {
  it("refuses a core whose migration the disk cannot hold, before anything is swapped, and brings the gateway back", () => {
    const r = runStep({ freeBytes: 2_000_000 });
    expect(r.status).not.toBe(0);
    const errorLines = r.stderr.split("\n").filter((l) => l.startsWith("Error:"));
    expect(errorLines.pop()).toMatch(
      /^Error: OpenClaw 2026\.10\.3 has to migrate .* of agent data and needs about .* free on the disk, but only 2\.0 MB is free\. Free up .* and run the update again; nothing was changed\.$/,
    );
    // The 9.x core is still the live one, the stage is gone, doctor never ran.
    expect(liveVersion()).toContain("2026.9.4");
    expect(existsSync(path.join(prefix, ".openclaw-stage"))).toBe(false);
    expect(calls().some((c) => c.startsWith("doctor"))).toBe(false);
    expect(calls()).toContain("systemctl start clawbox-gateway.service");
    expect(statusFile()).toMatchObject({ state: "blocked", reason: "insufficient-disk", freeBytes: 2_000_000, preflight: { target: "2026.10.3" } });
  });

  it("promotes and migrates when the disk has room, and records the migration complete", () => {
    const r = runStep({ freeBytes: 1024 ** 4 });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(liveVersion()).toContain("2026.10.3");
    expect(calls()).toContain("doctor doctor --fix --non-interactive");
    expect(statusFile()).toMatchObject({ source: "install", doctor: { core: "2026.10.3", verdict: "complete" }, preflight: null });
  });

  it("records an incomplete migration, which the gateway's status then reports as degraded", () => {
    const r = runStep({ freeBytes: 1024 ** 4, doctor: "incomplete" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/OpenClaw migration did not complete; leaving the gateway stopped/);
    expect(statusFile()).toMatchObject({ state: "degraded", doctor: { core: "2026.10.3", verdict: "incomplete" } });
  });

  it("asks again before doctor when the core is already at the pin, and leaves the gateway stopped on a refusal", () => {
    writeCore(prefix, "2026.10.3", 24, 20);
    const r = runStep({ freeBytes: 2_000_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/^Error: OpenClaw 2026\.10\.3 has to migrate .*; leaving the gateway stopped$/m);
    expect(calls().some((c) => c.startsWith("doctor"))).toBe(false);
    expect(calls()).not.toContain("systemctl start clawbox-gateway.service");
    expect(calls().some((c) => c.startsWith("npm "))).toBe(false);
  });

  it("does not ask twice when it already asked of the staged core", () => {
    const r = runStep({ freeBytes: 1024 ** 4 });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect((r.stdout.match(/migrates 2 database\(s\)/g) ?? []).length).toBe(1);
  });

  it("stands down, and migrates as before, when the helper is not there", () => {
    const r = runStep({ helper: false });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stderr).toMatch(/openclaw-db-maintenance\.py is missing; the OpenClaw database checks are skipped/);
    expect(liveVersion()).toContain("2026.10.3");
  });
});

/**
 * The other direction: a box that ran OpenClaw 2026.10.6 (agent schema 25)
 * asked to install 2026.10.3 (agent schema 24) — a switch back to a branch that
 * still pins it, or any rollback. 2026.10.3's repair step refuses a newer
 * database outright, and the step used to promote it anyway and stop there with
 * the gateway left stopped. The staged core (the npm stub) is 2026.10.3.
 */
describe.skipIf(!hasPython3)("step_openclaw_install: a core older than the databases on disk", () => {
  const agentDb = () => path.join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
  const backupDir = () => path.join(dir, "backup");

  function newerBox(): void {
    writeCore(prefix, "2026.10.6", 25, 20);
    makeDb(agentDb(), 25);
    rmSync(path.join(home, ".openclaw", "state", "openclaw.sqlite"));
    makeDb(path.join(home, ".openclaw", "state", "openclaw.sqlite"), 20);
  }

  function authorize(over: Record<string, unknown> = {}): void {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(path.join(project, "data", "harness-downgrade.json"), JSON.stringify({
      version: 1,
      openclaw: "2026.10.3",
      hermes: null,
      hermesCommit: null,
      backupDir: backupDir(),
      authorizedAt: new Date().toISOString(),
      authorizedAtEpoch: Math.floor(Date.now() / 1000),
      ...over,
    }));
  }

  it("refuses it before the promotion, keeps the newer core, and brings the gateway back", () => {
    rmSync(agentDb());
    newerBox();
    const r = runStep({ freeBytes: 1024 ** 4 });
    expect(r.status).not.toBe(0);
    const errorLines = r.stderr.split("\n").filter((l) => l.startsWith("Error:"));
    expect(errorLines.pop()).toBe(
      `Error: This box's OpenClaw data is newer than OpenClaw 2026.10.3: ${agentDb()} is on agent schema 25, `
      + "and OpenClaw 2026.10.3 supports schema 24. An older OpenClaw cannot open data a newer one has written, "
      + "so it was not installed and nothing was changed. Stay on an update branch whose OpenClaw supports agent "
      + "schema 25 or newer, or choose \"Back up and update anyway\" in Settings > System Update, which backs the data up first.",
    );
    expect(liveVersion()).toContain("2026.10.6");
    expect(existsSync(path.join(prefix, ".openclaw-stage"))).toBe(false);
    expect(calls().some((c) => c.startsWith("doctor"))).toBe(false);
    // NOT left stopped: the box keeps its assistant.
    expect(calls()).toContain("systemctl start clawbox-gateway.service");
    expect(existsSync(agentDb())).toBe(true);
  });

  it("with the owner's override for this core, sets the newer databases aside beside the backup and installs it", () => {
    rmSync(agentDb());
    newerBox();
    authorize();
    const r = runStep({ freeBytes: 1024 ** 4 });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(liveVersion()).toContain("2026.10.3");
    const moved = path.join(backupDir(), "openclaw-newer-schema", "agents", "main", "agent", "openclaw-agent.sqlite");
    expect(existsSync(moved)).toBe(true);
    expect(existsSync(agentDb())).toBe(false);
    // Only the database the older core cannot open: the state database (20) stays.
    expect(existsSync(path.join(home, ".openclaw", "state", "openclaw.sqlite"))).toBe(true);
    expect(r.stdout).toMatch(/^CLAWBOX-WARN\[harness-downgrade-set-aside\]: OpenClaw 2026\.10\.3 cannot open 1 database/m);
    expect(calls()).toContain("doctor doctor --fix --non-interactive");
  });

  it("is no override when it names another core, has expired, or its backup is gone", () => {
    for (const over of [
      { openclaw: "2026.9.4" },
      { authorizedAtEpoch: Math.floor(Date.now() / 1000) - 13 * 3600 },
      { backupDir: path.join(dir, "no-such-backup") },
    ]) {
      rmSync(agentDb(), { force: true });
      newerBox();
      authorize(over);
      const r = runStep({ freeBytes: 1024 ** 4 });
      expect(r.status, JSON.stringify(over)).not.toBe(0);
      expect(r.stderr).toMatch(/This box's OpenClaw data is newer than OpenClaw 2026\.10\.3/);
      expect(liveVersion()).toContain("2026.10.6");
      expect(existsSync(agentDb())).toBe(true);
    }
  });

  it("refuses before doctor when an older core is already the live one", () => {
    rmSync(agentDb());
    newerBox();
    writeCore(prefix, "2026.10.3", 24, 20);
    const r = runStep({ freeBytes: 1024 ** 4 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/^Error: This box's OpenClaw data is newer than OpenClaw 2026\.10\.3: .*; leaving the gateway stopped$/m);
    expect(calls().some((c) => c.startsWith("doctor"))).toBe(false);
    expect(calls().some((c) => c.startsWith("npm "))).toBe(false);
  });

  it("installs as before over databases on the core's own schema", () => {
    writeCore(prefix, "2026.10.3", 24, 20);
    rmSync(agentDb());
    makeDb(agentDb(), 24);
    rmSync(path.join(home, ".openclaw", "state", "openclaw.sqlite"));
    makeDb(path.join(home, ".openclaw", "state", "openclaw.sqlite"), 20);
    const r = runStep({ freeBytes: 1024 ** 4 });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(calls()).toContain("doctor doctor --fix --non-interactive");
    expect(existsSync(agentDb())).toBe(true);
  });
});
