import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Real git and python per case.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * install.sh's `harness_downgrade_guard`, which `sync_repo_to_update_target`
 * asks after its fetch and before anything moves the tree: would the branch
 * install an older harness than the one that wrote this box's data? The
 * in-app updater asks first (src/lib/updater.ts); this is the same question
 * for every other way into the sync — install.sh over SSH, an update whose
 * pre-flight could not reach origin.
 *
 * Driven under bash with the shipped function over real repositories: a
 * checkout whose origin/main pins the older harnesses, and a Hermes checkout
 * with history. Only the installed core's package.json is written by hand.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const hasTools = ["git", "python3"].every((t) => spawnSync(t, ["--version"], { stdio: "ignore" }).status === 0);

function shellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start + 1);
  return `${INSTALL_SH.slice(start + 1, end)}\n}`;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let dir: string;
let checkout: string;
let hermes: string;
let hermesCommits: string[];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** origin/main carries `openclawPin` and a Hermes pin of `hermesPin`. */
function release(openclawPin: string, hermesPin: string): void {
  const upstream = path.join(dir, "upstream");
  writeFileSync(path.join(upstream, "config", "openclaw-target.txt"), `${openclawPin}\n`);
  writeFileSync(path.join(upstream, "install.sh"),
    `#!/bin/bash\n# Current pin: upstream tag v0.21.1 == "Hermes Agent v0.21.1".\nHERMES_PIN_COMMIT="\${HERMES_PIN_COMMIT:-${hermesPin}}"\n`);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", `pins ${openclawPin}`);
  git(checkout, "fetch", "-q", "origin");
}

function installed(version: string | null): void {
  const pkg = path.join(dir, "npm", "lib", "node_modules", "openclaw");
  rmSync(pkg, { recursive: true, force: true });
  if (!version) return;
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "openclaw", version }));
}

function authorize(over: Record<string, unknown> = {}): void {
  writeFileSync(path.join(checkout, "data", "harness-downgrade.json"), JSON.stringify({
    version: 1, openclaw: "2026.10.3", hermes: null, hermesCommit: null, backupDir: dir,
    authorizedAt: new Date().toISOString(), authorizedAtEpoch: Math.floor(Date.now() / 1000), ...over,
  }));
}

function guard(edition: "openclaw" | "hermes" | "dual" = "openclaw") {
  const program = [
    "set -euo pipefail",
    `PROJECT_DIR=${JSON.stringify(checkout)}`,
    `NPM_PREFIX=${JSON.stringify(path.join(dir, "npm"))}`,
    `CLAWBOX_HOME=${JSON.stringify(path.join(dir, "home"))}`,
    `CLAWBOX_EDITION=${edition}`,
    "GIT_RUNNER=()",
    // install.sh's own one-liners, as shipped.
    /^has_hermes_harness\(\) .*$/m.exec(INSTALL_SH)?.[0] ?? "",
    /^has_openclaw_harness\(\) .*$/m.exec(INSTALL_SH)?.[0] ?? "",
    'as_clawbox() { "$@"; }',
    shellFunction("harness_downgrade_guard"),
    "harness_downgrade_guard origin/main",
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], { encoding: "utf-8", env: { ...process.env, ...GIT_ENV } });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-downgrade-guard-"));
  const upstream = path.join(dir, "upstream");
  mkdirSync(path.join(upstream, "config"), { recursive: true });
  git(dir, "init", "-q", upstream);
  writeFileSync(path.join(upstream, "README.md"), "x\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "init");
  checkout = path.join(dir, "checkout");
  git(dir, "clone", "-q", upstream, checkout);
  mkdirSync(path.join(checkout, "data"), { recursive: true });
  // A Hermes checkout with history: the older release, then the one checked out.
  hermes = path.join(dir, "home", ".hermes", "hermes-agent");
  mkdirSync(hermes, { recursive: true });
  git(hermes, "init", "-q");
  hermesCommits = [];
  for (const v of ["0.21.1", "0.22.4"]) {
    writeFileSync(path.join(hermes, "VERSION"), `${v}\n`);
    git(hermes, "add", "-A");
    git(hermes, "commit", "-qm", v);
    hermesCommits.push(git(hermes, "rev-parse", "HEAD"));
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasTools)("harness_downgrade_guard: a branch older than the data is refused before the reset", () => {
  it("refuses an OpenClaw pin older than the core installed now", () => {
    release("2026.10.3", hermesCommits[1]);
    installed("2026.10.6");
    const r = guard();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'Error: OpenClaw 2026.10.6 is installed, and branch "main" pins the older OpenClaw 2026.10.3. '
      + "An older version cannot open data a newer one has written, so the update stopped before it changed anything.",
    );
  });

  it("refuses a Hermes pin that is behind the commit checked out", () => {
    release("2026.10.6", hermesCommits[0]);
    installed("2026.10.6");
    const r = guard("dual");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`Hermes Agent is checked out at ${hermesCommits[1].slice(0, 12)}, and branch "main" pins the older commit ${hermesCommits[0].slice(0, 12)}`);
  });

  it("honours the owner's override for exactly the versions it names, while it is fresh", () => {
    release("2026.10.3", hermesCommits[1]);
    installed("2026.10.6");
    authorize();
    expect(guard().status).toBe(0);
    authorize({ openclaw: "2026.9.4" });
    expect(guard().status).toBe(1);
    authorize({ authorizedAtEpoch: Math.floor(Date.now() / 1000) - 13 * 3600 });
    expect(guard().status).toBe(1);
  });

  it("honours the override for a Hermes commit by that commit", () => {
    release("2026.10.6", hermesCommits[0]);
    installed("2026.10.6");
    authorize({ openclaw: null, hermes: "0.21.1", hermesCommit: hermesCommits[0] });
    expect(guard("dual").status).toBe(0);
  });
});

describe.skipIf(!hasTools)("harness_downgrade_guard: the same or a newer target, and every unknown, go ahead", () => {
  it("lets the same and a newer pin through", () => {
    release("2026.10.6", hermesCommits[1]);
    installed("2026.10.6");
    expect(guard("dual").status).toBe(0);
    installed("2026.10.3");
    expect(guard("dual").status).toBe(0);
  });

  it("stands down with no core installed, an unordered pin, or no Hermes on the edition", () => {
    release("2026.10.3", hermesCommits[0]);
    installed(null);
    expect(guard().status).toBe(0);
    release("beta", hermesCommits[0]);
    installed("2026.10.6");
    expect(guard().status).toBe(0);
    // An OpenClaw-only box never asks about the Hermes pin.
    release("2026.10.6", hermesCommits[0]);
    expect(guard("openclaw").status).toBe(0);
  });
});

describe("sync_repo_to_update_target asks it", () => {
  it("after the fetch and before anything moves the tree", () => {
    const sync = shellFunction("sync_repo_to_update_target");
    const fetchAt = sync.indexOf("fetch origin");
    const guardAt = sync.indexOf("harness_downgrade_guard");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(fetchAt);
    expect(guardAt).toBeLessThan(sync.indexOf("preserve_local_edits"));
    expect(guardAt).toBeLessThan(sync.indexOf("reset --hard"));
  });
});
