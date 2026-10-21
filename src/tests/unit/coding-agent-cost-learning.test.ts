/**
 * The runner's half of four cost and learning changes, end to end against a
 * fake harness that writes down what it was given:
 *
 *  - a team's planner and reviewer start on the provider's CHEAPER model at no
 *    more than `xhigh` (src/lib/coding-role-models.ts), a worker on the owner's
 *    own, and the owner's per-role choice wins — provider included: a team can
 *    run its planner on Anthropic and its workers on ClawBox AI, each run on
 *    its own account's wiring alone, and a role whose account is not
 *    connected is refused with that account's reason;
 *  - every run gets a CPU budget (src/lib/coding-run-cpu.ts) in its environment,
 *    and a writing run's brief asks it to keep its builds and tests to it;
 *  - the project's RUN NOTES (src/lib/coding-run-notes.ts) reach every run's
 *    prompt, and the lessons a run proposes are merged — vetted — at settle,
 *    into the project root, outside its worktree and out of `git status`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts real processes (bash / git): see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
// An eight-thread box on mains: the host's own CPUs and charger are neither the
// fixture nor the same on every runner.
vi.mock("@/lib/coding-run-cpu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-run-cpu")>();
  return { ...actual, hostCpuCount: () => 8, onBatteryPower: vi.fn(async () => false) };
});

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let artifactsDir: (runId: string) => string;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projects: string;
let restore: () => void;

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

const BASE_CONFIG = { clawai_token: "claw_test_token", coding_agent_enabled: true } as Record<string, unknown>;

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ ...BASE_CONFIG, coding_agent_default_directory: projects, ...cfg }), "utf-8");
}

const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-1" });

/**
 * A harness that writes down what it was handed — its provider, model, effort
 * and CPU budget from the environment, the Anthropic credential handed over
 * for this spawn (read and deleted, as the real wrapper does), its whole
 * environment and argv — into its own evidence folder, runs `extra`, and
 * finishes.
 */
function installWrapper(extra: string[] = []): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), [
    "#!/usr/bin/env bash",
    readFirstTurn(),
    'printf "%s" "${CLAUDE_DS_PROVIDER:-}" > "$CLAWBOX_RUN_ARTIFACTS_DIR/provider.txt"',
    'printf "%s" "${CLAUDE_DS_MODEL:-}" > "$CLAWBOX_RUN_ARTIFACTS_DIR/model.txt"',
    'printf "%s" "${CLAUDE_DS_EFFORT:-}" > "$CLAWBOX_RUN_ARTIFACTS_DIR/effort.txt"',
    'printf "%s" "${CLAWBOX_RUN_CPU_BUDGET:-}" > "$CLAWBOX_RUN_ARTIFACTS_DIR/budget.txt"',
    'cred=""',
    'if [ -n "${CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE:-}" ]; then cred=$(cat "$CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE"); rm -f "$CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE"; fi',
    'printf "%s" "$cred" > "$CLAWBOX_RUN_ARTIFACTS_DIR/cred.txt"',
    'env > "$CLAWBOX_RUN_ARTIFACTS_DIR/env.txt"',
    'printf "%s\\n" "$@" > "$CLAWBOX_RUN_ARTIFACTS_DIR/argv.txt"',
    ...extra,
    `echo '${result("done")}'`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });
}

/** What the harness of that run wrote down. */
const handed = (runId: string, what: "provider" | "model" | "effort" | "budget" | "cred" | "env" | "argv") => fs.readFileSync(path.join(artifactsDir(runId), `${what}.txt`), "utf8");

/** An Anthropic key in the box's account pool — the box's own fixture, not a real credential. */
const ANTHROPIC_KEY = "role-models-test-anthropic-key-0001";

/** Connect the owner's Anthropic account: one API-key account in the pool. After `writeConfig`, which would wipe it. */
async function connectAnthropic(): Promise<void> {
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "9d".repeat(32), { mode: 0o600 });
  process.env.SESSION_SECRET = "the-web-servers-secret";
  const pool = await import("@/lib/anthropic-accounts");
  pool._resetAnthropicAccountsForTests();
  await pool.addApiKeyAccount({ label: "Work", key: ANTHROPIC_KEY });
}

const runsFile = () => path.join(root, "data", "coding-agent-runs.json");

function makeGitProject(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

function makePlainProject(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  return dir;
}

async function finished(id: string) {
  const run = await lib.waitForRun(id, 20_000);
  if (!run) throw new Error("run vanished");
  return run;
}

const TEAM = "team-aaaa0001";

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN", "CLAUDE_DS_MODEL", "CLAUDE_DS_EFFORT");
  delete process.env.CLAUDE_DS_MODEL;
  delete process.env.CLAUDE_DS_EFFORT;
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-cost-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({});
  installWrapper();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  artifactsDir = (await import("@/lib/coding-agent-artifacts")).artifactsDir;
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  (await import("@/lib/anthropic-accounts"))._resetAnthropicAccountsForTests();
  (await import("@/lib/anthropic-swap"))._resetAnthropicSwapForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a team's roles: the cheaper model where nobody writes code", () => {
  it("starts a planner on the plan's flash tier at no more than xhigh, and a worker on the owner's own", async () => {
    makePlainProject("plain");
    const planner = await lib.startRun({ task: "plan it", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    expect(planner).toMatchObject({ provider: "clawbox-ai", requestedModel: "deepseek-v4-flash", effort: "xhigh" });
    await finished(planner.id);
    // What the harness was actually handed, and what the record keeps after a reload.
    expect(handed(planner.id, "model")).toBe("deepseek-v4-flash");
    expect(handed(planner.id, "effort")).toBe("xhigh");
    expect(lib.getRun(planner.id)).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "xhigh" });

    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    // The owner's own: the plan picks the model, and the effort is the box's default.
    expect(worker).toMatchObject({ provider: "clawbox-ai", requestedModel: null, effort: "xhigh" });
    await finished(worker.id);
    expect(handed(worker.id, "model")).toBe("");

    // A lead and a reviewer are read-only runs on the same cheaper tier.
    const reviewer = await lib.startRun({ task: "review t1", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "reviewer", taskId: "t1" } });
    expect(reviewer).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "xhigh" });
    await finished(reviewer.id);
    const lead = await lib.startRun({ task: "decide", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "lead", taskId: "t1" } });
    expect(lead).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "xhigh" });
    await finished(lead.id);
  });

  it("never thinks harder than the owner's own effort, and follows the owner's per-role choice", async () => {
    makePlainProject("plain");
    writeConfig({ coding_agent_effort: "low", coding_agent_role_models: { reviewer: { model: "standard", effort: "max" }, worker: { model: "economy" } } });
    const planner = await lib.startRun({ task: "plan it", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    expect(planner).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "low" });
    await finished(planner.id);
    const reviewer = await lib.startRun({ task: "review", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "reviewer", taskId: "t1" } });
    expect(reviewer).toMatchObject({ requestedModel: null, effort: "max" });
    await finished(reviewer.id);
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    expect(worker).toMatchObject({ requestedModel: "deepseek-v4-flash", effort: "low" });
    await finished(worker.id);
  });

  it("leaves a run that is not a team's exactly as it was", async () => {
    makePlainProject("plain");
    const run = await lib.startRun({ task: "build it", directory: "plain", source: "owner" });
    expect(run).toMatchObject({ requestedModel: null, effort: "xhigh" });
    await finished(run.id);
  });

  it("answers the choices in the status, `auto` on a box that never chose, and saves an edit", async () => {
    const auto = { provider: "auto", model: "auto", effort: "auto" };
    expect((await lib.getCodingAgentStatus()).roleModels).toEqual({ planner: auto, worker: auto, reviewer: auto, bulk: auto });
    await lib.setRoleModels({ planner: { model: "standard" } });
    expect((await lib.getCodingAgentStatus()).roleModels.planner).toEqual({ provider: "auto", model: "standard", effort: "auto" });
    await expect(lib.setRoleModels({ planner: { model: "cheapest" } })).rejects.toMatchObject({ kind: "invalid" });
    expect(await lib.checkRoleModelsPatch({ lead: {} })).toMatch(/Unknown role/);
    expect(await lib.checkRoleModelsPatch({ worker: { effort: "auto" } })).toBeNull();
    // Checked against what is stored: a model named alone takes the role's stored provider.
    expect(await lib.checkRoleModelsPatch({ planner: { model: "claude-fable-5-1" } })).toMatch(/roleModels\.planner\.provider/);
    await lib.setRoleModels({ planner: { provider: "anthropic" } });
    expect(await lib.checkRoleModelsPatch({ planner: { model: "claude-fable-5-1" } })).toBeNull();
    await lib.setRoleModels({ planner: { model: "claude-fable-5-1" }, bulk: { provider: "clawbox-ai", model: "deepseek-v4-flash" } });
    const saved = (await lib.getCodingAgentStatus()).roleModels;
    expect(saved.planner).toEqual({ provider: "anthropic", model: "claude-fable-5-1", effort: "auto" });
    expect(saved.bulk).toEqual({ provider: "clawbox-ai", model: "deepseek-v4-flash", effort: "auto" });
  });

  it("moves a role the owner put on another provider there, and refuses it while that provider is not connected", async () => {
    makePlainProject("plain");
    // The team runs on ClawBox AI; its planner is pinned to Anthropic, which
    // this box has no credential for. Workers stay on the team's own provider.
    writeConfig({ coding_agent_role_models: { planner: { provider: "anthropic", model: "claude-fable-5-1" }, worker: { provider: "clawbox-ai", model: "deepseek-v4-flash" } } });
    await expect(lib.startRun({ task: "plan it", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } }))
      .rejects.toMatchObject({ kind: "not_ready" });
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    expect(worker).toMatchObject({ provider: "clawbox-ai", requestedModel: "deepseek-v4-flash", effort: "xhigh" });
    await finished(worker.id);
    expect(handed(worker.id, "model")).toBe("deepseek-v4-flash");
  });
});

describe("a team's roles on their own providers", () => {
  it("runs a mixed team: the planner on Anthropic, the workers on ClawBox AI, each on its own account's wiring alone", async () => {
    makePlainProject("plain");
    writeConfig({ coding_agent_role_models: { planner: { provider: "anthropic", model: "claude-fable-5-1" } } });
    await connectAnthropic();

    const planner = await lib.startRun({ task: "plan it", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    expect(planner).toMatchObject({ provider: "anthropic", requestedModel: "claude-fable-5-1", effort: "xhigh", modelRole: "planner" });
    await finished(planner.id);
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    // The team's own provider: nothing moved the workers.
    expect(worker).toMatchObject({ provider: "clawbox-ai", requestedModel: null, effort: "xhigh", modelRole: "worker" });
    await finished(worker.id);

    // What each harness was actually handed: its own provider and model, and
    // the Anthropic credential only where the run is Anthropic's.
    expect(handed(planner.id, "provider")).toBe("anthropic");
    expect(handed(planner.id, "model")).toBe("claude-fable-5-1");
    expect(handed(planner.id, "cred")).toContain(ANTHROPIC_KEY);
    expect(handed(worker.id, "provider")).toBe("clawbox-ai");
    expect(handed(worker.id, "model")).toBe("");
    expect(handed(worker.id, "cred")).toBe("");
    for (const id of [planner.id, worker.id]) {
      const env = handed(id, "env");
      // Neither secret is ever in a run's environment — the wrapper reads its
      // own provider's out of the box's config — and only the Anthropic run
      // has a credential handoff at all.
      expect(env).not.toContain(ANTHROPIC_KEY);
      expect(env).not.toContain("claw_test_token");
      expect(env).not.toMatch(/^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)=/m);
    }
    expect(handed(planner.id, "env")).toMatch(/^CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE=/m);
    expect(handed(worker.id, "env")).not.toMatch(/^CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE=/m);
  });

  it("starts a bulk task on the bulk role's choice, keeps the role on the record, and reads one from before the field as none", async () => {
    makePlainProject("plain");
    writeConfig({ coding_agent_role_models: { bulk: { provider: "clawbox-ai", model: "deepseek-v4-flash" } } });
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    expect(worker).toMatchObject({ requestedModel: null, modelRole: "worker" });
    await finished(worker.id);
    const bulk = await lib.startRun({ task: "scrape t2", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t2", bulk: true } });
    expect(bulk).toMatchObject({ provider: "clawbox-ai", requestedModel: "deepseek-v4-flash", effort: "xhigh", modelRole: "bulk", team: { bulk: true } });
    await finished(bulk.id);
    expect(handed(bulk.id, "model")).toBe("deepseek-v4-flash");
    const lead = await lib.startRun({ task: "decide", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "lead", taskId: "t1" } });
    expect(lead.modelRole).toBe("planner");
    await finished(lead.id);
    const solo = await lib.startRun({ task: "build it", directory: "plain", source: "owner" });
    expect(solo.modelRole).toBeNull();
    await finished(solo.id);

    // On disk, as written.
    const onDisk = JSON.parse(fs.readFileSync(runsFile(), "utf8")) as Record<string, unknown>[];
    const byId = Object.fromEntries(onDisk.map((r) => [r.id as string, r]));
    expect(byId[bulk.id]).toMatchObject({ modelRole: "bulk", team: { role: "worker", taskId: "t2", bulk: true } });
    expect(byId[worker.id].modelRole).toBe("worker");
    expect(byId[solo.id].modelRole).toBeNull();

    // Read back after a restart: a record from before the field, and one with
    // a role this code never writes, read as none — never a refusal.
    delete byId[worker.id].modelRole;
    byId[lead.id].modelRole = "lead";
    fs.writeFileSync(runsFile(), JSON.stringify(onDisk));
    await lib._resetCodingAgentStateForTests();
    expect(lib.getRun(bulk.id)).toMatchObject({ modelRole: "bulk", team: { bulk: true } });
    expect(lib.getRun(worker.id)!.modelRole).toBeNull();
    // A worker's team reads back without a `bulk` it never had.
    expect(lib.getRun(worker.id)!.team).toEqual({ id: TEAM, role: "worker", taskId: "t1" });
    expect(lib.getRun(lead.id)!.modelRole).toBeNull();
    expect(lib.getRun(solo.id)!.modelRole).toBeNull();
  });

  it("judges the gate on the role's own provider, not the owner's default", async () => {
    makePlainProject("plain");
    // The owner's default is Anthropic, which this box has no credential for;
    // the workers are pinned to ClawBox AI, which it has.
    writeConfig({ coding_agent_provider: "anthropic", coding_agent_role_models: { worker: { provider: "clawbox-ai" } } });
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    expect(worker).toMatchObject({ provider: "clawbox-ai", requestedModel: null });
    await finished(worker.id);
    expect(handed(worker.id, "provider")).toBe("clawbox-ai");
    // A bulk task with nothing of its own goes where the workers go.
    const bulk = await lib.startRun({ task: "scrape t2", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t2", bulk: true } });
    expect(bulk).toMatchObject({ provider: "clawbox-ai", modelRole: "bulk" });
    await finished(bulk.id);
    // The planner is on the team's own provider — the unconnected one — and is
    // refused with THAT account's sentence.
    const refused = lib.startRun({ task: "plan it", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    await expect(refused).rejects.toMatchObject({ kind: "not_ready", message: expect.stringMatching(/Anthropic account is not connected/) });
  });

  it("refuses a role whose provider is not connected with that provider's reason, while the team's own runs", async () => {
    makePlainProject("plain");
    writeConfig({ clawai_token: "", coding_agent_provider: "anthropic", coding_agent_role_models: { reviewer: { provider: "clawbox-ai", model: "economy" } } });
    await connectAnthropic();
    const refused = lib.startRun({ task: "review t1", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "reviewer", taskId: "t1" } });
    await expect(refused).rejects.toMatchObject({ kind: "not_ready", message: expect.stringMatching(/ClawBox AI is not connected/) });
    await expect(refused).rejects.toMatchObject({ message: expect.not.stringMatching(/Anthropic/) });
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    expect(worker).toMatchObject({ provider: "anthropic", requestedModel: "claude-opus-5-5", modelRole: "worker" });
    await finished(worker.id);
    expect(handed(worker.id, "provider")).toBe("anthropic");
    expect(handed(worker.id, "model")).toBe("claude-opus-5-5");
  });

  it("keeps a resumed run on the provider and model its session was opened on, whatever the role says now", async () => {
    makePlainProject("plain");
    writeConfig({ coding_agent_role_models: { reviewer: { provider: "anthropic", model: "claude-sonnet-5" } } });
    await connectAnthropic();
    const role = { id: TEAM, role: "reviewer" as const, taskId: "t1" };
    const first = await lib.startRun({ task: "review t1", directory: "plain", source: "owner", readOnly: true, team: role });
    expect(first).toMatchObject({ provider: "anthropic", requestedModel: "claude-sonnet-5", modelRole: "reviewer" });
    expect((await finished(first.id)).sessionId).toBe("sess-1");

    // The owner moves the reviewers to ClawBox AI meanwhile.
    await lib.setRoleModels({ reviewer: { provider: "clawbox-ai", model: "economy" } });
    const again = await lib.startRun({ task: "look again", resumeRunId: first.id, source: "owner", readOnly: true, team: role });
    expect(again).toMatchObject({ provider: "anthropic", requestedModel: "claude-sonnet-5", modelRole: "reviewer" });
    await finished(again.id);
    expect(handed(again.id, "provider")).toBe("anthropic");
    expect(handed(again.id, "model")).toBe("claude-sonnet-5");
    // A FRESH reviewer takes the role's new choice.
    const fresh = await lib.startRun({ task: "review t2", directory: "plain", source: "owner", readOnly: true, team: { ...role, taskId: "t2" } });
    expect(fresh).toMatchObject({ provider: "clawbox-ai", requestedModel: "deepseek-v4-flash" });
    await finished(fresh.id);
    expect(handed(fresh.id, "cred")).toBe("");
  });

  it("answers each role's provider, model, readiness and relative cost — what a fresh run of that role gets", async () => {
    makePlainProject("plain");
    // A box that never chose: the defaults on the team's own provider.
    const defaults = (await lib.getCodingAgentStatus()).roleModelMap;
    expect(defaults.planner).toEqual({ provider: "clawbox-ai", model: "deepseek-v4-flash", effort: "xhigh", auto: true, ready: true, problems: [], relativeCost: 1 });
    expect(defaults.worker).toEqual({ provider: "clawbox-ai", model: null, effort: "xhigh", auto: true, ready: true, problems: [], relativeCost: null });
    expect(defaults.reviewer).toEqual(defaults.planner);
    expect(defaults.bulk).toEqual(defaults.worker);

    // The older `{ model: tier }` shape reads exactly as it did.
    await lib.setRoleModels({ worker: { model: "economy" } });
    expect((await lib.teamRoleModelMap()).worker).toMatchObject({ provider: "clawbox-ai", model: "deepseek-v4-flash", auto: false, relativeCost: 1 });

    // Mixed, with the planner on an account this box has not connected.
    await lib.setRoleModels({ worker: { model: "auto" }, planner: { provider: "anthropic", model: "claude-fable-5-1" }, bulk: { provider: "clawbox-ai", model: "deepseek-v4-flash" } });
    const map = await lib.teamRoleModelMap();
    expect(map).toEqual((await lib.getCodingAgentStatus()).roleModelMap);
    expect(map.planner).toMatchObject({ provider: "anthropic", model: "claude-fable-5-1", effort: "xhigh", auto: false, ready: false, relativeCost: 40 });
    expect(map.planner.problems.join(" ")).toMatch(/Anthropic account is not connected/);
    expect(map.bulk).toEqual({ provider: "clawbox-ai", model: "deepseek-v4-flash", effort: "xhigh", auto: false, ready: true, problems: [], relativeCost: 1 });
    expect(map.worker).toMatchObject({ provider: "clawbox-ai", model: null, auto: true });

    // And it is what the runs get.
    const bulk = await lib.startRun({ task: "scrape t2", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t2", bulk: true } });
    expect(bulk).toMatchObject({ provider: map.bulk.provider, requestedModel: map.bulk.model, effort: map.bulk.effort });
    await finished(bulk.id);
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", team: { id: TEAM, role: "worker", taskId: "t1" } });
    expect(worker).toMatchObject({ provider: map.worker.provider, requestedModel: map.worker.model, effort: map.worker.effort });
    await finished(worker.id);
  });
});

describe("the CPU budget", () => {
  it("is in every run's environment, and in a writing run's brief by each runner's own flag", async () => {
    makePlainProject("plain");
    const run = await lib.startRun({ task: "build it", directory: "plain", source: "owner" });
    // Alone on an eight-thread box: half of it.
    expect(run.cpuBudget).toBe(4);
    await finished(run.id);
    expect(handed(run.id, "budget")).toBe("4");
    expect(handed(run.id, "argv")).toContain("CPU budget: 4 parallel jobs");
    expect(handed(run.id, "argv")).toContain("--maxWorkers=4");
  });

  it("is shared between a team's workers side by side, and a read-only run is told nothing about builds", async () => {
    makePlainProject("plain");
    const worker = await lib.startRun({ task: "do t1", directory: "plain", source: "owner", cpuShare: 2, team: { id: TEAM, role: "worker", taskId: "t1" } });
    expect(worker.cpuBudget).toBe(2);
    await finished(worker.id);
    expect(handed(worker.id, "budget")).toBe("2");
    const planner = await lib.startRun({ task: "plan", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    await finished(planner.id);
    expect(handed(planner.id, "budget")).toBe(String(planner.cpuBudget));
    expect(handed(planner.id, "argv")).not.toContain("CPU budget:");
  });
});

describe("the project's run notes", () => {
  it("reach the run's prompt, and its vetted lessons land in the PROJECT's notes — outside the worktree and out of git status", async () => {
    const project = makeGitProject("site");
    fs.mkdirSync(path.join(project, ".clawbox"), { recursive: true });
    fs.writeFileSync(path.join(project, ".clawbox", "run-notes.md"), "- Tests: bun run test\n");
    installWrapper([
      `printf '%s' '${JSON.stringify({ lessons: ["Lint with bunx eslint before committing", "Deploy key: token=ghp_abcdefghijklmnopqrstuvwxyz0123", "tests: bun run test"] })}' > "$CLAWBOX_RUN_ARTIFACTS_DIR/run-notes.json"`,
    ]);
    const run = await lib.startRun({ task: "build it", directory: "site", source: "owner" });
    // A run of its own in its own worktree: the notes are the project's, not the tree's.
    expect(run.directory).toContain(path.join(".clawbox", "worktrees"));
    await finished(run.id);
    const argv = handed(run.id, "argv");
    expect(argv).toContain("<run-notes>");
    expect(argv).toContain("- Tests: bun run test");
    expect(argv).toContain("run-notes.json");
    const notes = fs.readFileSync(path.join(project, ".clawbox", "run-notes.md"), "utf8");
    expect(notes).toBe("- Tests: bun run test\n- Lint with bunx eslint before committing\n");
    expect(notes).not.toContain("ghp_");
    expect(git(project, "status", "--porcelain")).not.toContain(".clawbox");
  });

  it("are read, not offered for writing, by a read-only run", async () => {
    const project = makePlainProject("plain");
    fs.mkdirSync(path.join(project, ".clawbox"), { recursive: true });
    fs.writeFileSync(path.join(project, ".clawbox", "run-notes.md"), "- The dev server is on port 3100\n");
    const planner = await lib.startRun({ task: "plan", directory: "plain", source: "owner", readOnly: true, team: { id: TEAM, role: "planner", taskId: null } });
    await finished(planner.id);
    const argv = handed(planner.id, "argv");
    expect(argv).toContain("- The dev server is on port 3100");
    expect(argv).not.toContain("run-notes.json");
  });
});
