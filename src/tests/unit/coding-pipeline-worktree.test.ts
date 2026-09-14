/**
 * The delivery pipeline against a run that works in a COPY of the project.
 *
 * WHAT THE DRIVER SUITE CANNOT SEE. `coding-pipeline-driver.test.ts` runs its
 * pipelines in a code project inside the ClawBox checkout, which gets no
 * worktree — so nothing there touches the two defects a real board found on the
 * commonest shape (a git folder project, and a Vercel project with no
 * repository connected):
 *
 *  - the DEPLOY uploaded the project checkout while the run's commits were
 *    still only on `clawbox/<runId>`, so the deployment contained the code as
 *    it was BEFORE the run, and the verification then checked that;
 *  - the IMPROVEMENT lap re-spawned into a folder the settle had already merged
 *    home and deleted — `settleRunWorktree` steps aside only while a RUN is
 *    live in the tree, and a pipeline between stages holds nothing — so stage
 *    three of the flow died with "That folder does not exist on this ClawBox".
 *
 * A real repository and a real (fake) harness, because both defects are about
 * where bytes actually are on disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";
import type { PipelineVerification } from "@/lib/coding-pipeline";

// Starts real processes (bash / git) and drives a whole pipeline: vitest's
// defaults are not enough. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));

// ── Vercel, all of it ────────────────────────────────────────────────────────

vi.mock("@/lib/vercel-link", () => ({
  checkVercelReadiness: vi.fn(async () => ({
    linked: true, projectId: "prj_1", teamId: null, tokenSecretName: "VERCEL_TOKEN",
    tokenPresent: true, tokenValid: true, username: "u", projectResolves: true,
    projectName: "site", ready: true, problems: [] as string[], code: null,
  })),
  readVercelLink: vi.fn(async () => ({ projectId: "prj_1", teamId: null, tokenSecretName: "VERCEL_TOKEN" })),
  // The box-wide Vercel switch's migration reads this when the key is absent.
  // Never reached here — the config below sets the key — but a mock that omits
  // it makes the migration throw rather than answer.
  readVercelLinks: vi.fn(async () => ({})),
  resolveVercelAuth: vi.fn(async () => ({ token: "t", teamId: null })),
}));

const readAutoProduction = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/vercel-deploy-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel-deploy-store")>()),
  readAutoProduction,
}));

vi.mock("@/lib/vercel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/vercel")>();
  return {
    ...real,
    readProject: vi.fn(async () => ({ ok: true, name: "site", gitLink: null, productionDomain: "site.example.com" })),
    readDeployment: vi.fn(async (_auth: unknown, id: string) => ({
      ok: true,
      deployment: {
        id, readyState: "ready", url: "x-abc.vercel.app", inspectorUrl: null,
        target: null, branch: null, sha: null, createdAt: 1, errorMessage: null,
      },
    })),
    readBuildLog: vi.fn(async () => ({ ok: true, log: "" })),
  };
});

/**
 * The deploy, recorded rather than made — and it records WHAT WAS ON DISK in
 * the folder it was handed, which is the whole of defect three.
 */
const deploys = vi.hoisted(() => ({ calls: [] as { directory: string; target: string; files: string[] }[] }));
const runDeployment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel-deploy-run", () => ({ runDeployment, MAX_PRODUCTION_DEPLOYS: 3 }));

const verifyDeployment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-pipeline-verify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pipeline-verify")>()),
  verifyDeployment,
}));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let projects: string;
let restore: () => void;

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, session_id: "sess-1" });

/**
 * A harness that writes THE PAGE into its own copy every turn.
 *
 * The file matters twice over: `maybeStartReviewPass` skips a run that changed
 * nothing (so the review stage would never run), and the deployed file listing
 * is what defect three is about.
 */
function installHarness(): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "claude-ds"), [
    "#!/usr/bin/env bash",
    readFirstTurn(),
    `printf '%s' 'the run: <h1>Invoice</h1>' > "$PWD/invoice.html"`,
    `printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"%s/invoice.html"}}]}}\\n' "$PWD"`,
    `echo '${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } })}'`,
    `echo '${result("wrote the page")}'`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });
}

function writeConfig(cfg: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({
    clawai_token: "claw_test_token",
    coding_agent_enabled: true,
    // The box-wide Vercel switch: every case here is a box that deploys.
    coding_vercel_enabled: true,
    coding_agent_default_directory: projects,
    coding_agent_review_pass: true,
    coding_agent_review_rounds: 2,
    ...cfg,
  }), "utf-8");
}

function makeGitProject(name: string): string {
  const dir = path.join(projects, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Placeholder</h1>\n");
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "the placeholder, committed before the run");
  return dir;
}

function verification(ok: boolean, over: Partial<PipelineVerification> = {}): PipelineVerification {
  return {
    ok,
    url: "https://x-abc.vercel.app/",
    status: 200,
    reason: ok ? null : 'The page is up but does not contain "Invoice".',
    judgedBy: "expectations",
    expectations: [{ text: "Invoice", found: ok }],
    vision: null,
    screenshot: "verify-1.png",
    checkedAt: Date.now(),
    ...over,
  };
}

async function pipelineSettles(id: string, want?: string) {
  await vi.waitFor(() => {
    const run = lib.getRun(id);
    expect(run?.pipeline).toBeTruthy();
    expect(run!.pipeline!.status === "running").toBe(false);
    if (want) expect(run!.pipeline!.status).toBe(want);
  }, { timeout: 45_000, interval: 50 });
  return lib.getRun(id)!;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-pipeline-wt-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  projects = path.join(home, "Projects");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  writeConfig();
  installHarness();
  deploys.calls = [];
  readAutoProduction.mockReset();
  readAutoProduction.mockResolvedValue(true);
  verifyDeployment.mockReset();
  verifyDeployment.mockResolvedValue(verification(true));
  runDeployment.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  runDeployment.mockImplementation(async (input: { runId: string | null; target: string; directory: string }) => {
    deploys.calls.push({
      directory: input.directory,
      target: input.target,
      // What a file-upload deploy would actually have sent up.
      files: fs.existsSync(input.directory)
        ? fs.readdirSync(input.directory).filter((n) => !n.startsWith(".")).sort()
        : [],
    });
    const deployment = {
      id: `dpl_${deploys.calls.length}`, readyState: "queued" as const, url: "x-abc.vercel.app",
      inspectorUrl: null, target: input.target, branch: null, sha: null, createdAt: 1, errorMessage: null,
    };
    if (input.runId) {
      lib.recordManualDeployment(input.runId, {
        deployment, projectId: "prj_1", teamId: null,
        target: input.target as "preview" | "production", branch: null,
      });
    }
    return {
      ok: true,
      deploy: { deploymentId: deployment.id, url: `https://${deployment.url}` },
      entry: { latest: null, productionAt: [] },
      made: { deployment, usedGit: true, skipped: [] },
    };
  });
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("what a deployment is made FROM", () => {
  it("uploads the run's own copy, where its work is — not the checkout it has not been merged into", async () => {
    const project = makeGitProject("alpha");
    const started = await lib.startRun({
      task: "build an invoice page", directory: "alpha", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const worktree = lib.getRun(started.id)!.worktree!;
    expect(worktree.path.startsWith(path.join(project, ".clawbox", "worktrees"))).toBe(true);

    const run = await pipelineSettles(started.id, "complete");
    expect(run.pipeline!.status).toBe("complete");

    // BOTH deploys came out of the run's copy, and both would have carried the
    // page the run actually wrote. Against the project checkout at that moment
    // the listing was `index.html` alone — the pre-run placeholder.
    expect(deploys.calls).toHaveLength(2);
    for (const call of deploys.calls) {
      expect(call.directory).toBe(worktree.path);
      expect(call.files).toContain("invoice.html");
    }
  });

  it("falls back to the project for a run with no copy of its own", async () => {
    // A code project lives inside the ClawBox checkout and gets no worktree;
    // there is nothing else to deploy and the project is the honest answer.
    const dir = path.join(root, "data", "code-projects", "site");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: "site", name: "site" }));
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");

    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    await pipelineSettles(started.id, "complete");
    expect(lib.getRun(started.id)!.worktree).toBeNull();
    expect(deploys.calls[0].directory).toBe(dir);
  });
});

describe("the copy the pipeline is still using", () => {
  it("survives the settle, so the improvement lap has a folder to work in", async () => {
    makeGitProject("beta");
    // The first check fails — which is the path the whole feature exists for,
    // and the one that used to die instantly with "That folder does not exist
    // on this ClawBox", because it is decided asynchronously, after
    // `reviewAndShip` has already tidied the tree away.
    verifyDeployment.mockResolvedValueOnce(verification(false)).mockResolvedValue(verification(true));

    const started = await lib.startRun({
      task: "build an invoice page", directory: "beta", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const worktreePath = lib.getRun(started.id)!.worktree!.path;
    const run = await pipelineSettles(started.id, "complete");

    // One lap was spent and it RAN: the stage passed rather than failing on a
    // missing folder, and the run is not `gave_up`.
    expect(run.pipeline!.round).toBe(1);
    const improvement = run.pipeline!.steps.find((s) => s.stage === "improvement")!;
    expect(improvement.state).toBe("passed");
    expect(improvement.detail ?? "").not.toContain("does not exist");
    expect(run.status).toBe("completed");
    expect(deploys.calls.every((c) => c.directory === worktreePath)).toBe(true);
  });

  it("is settled once the pipeline is over — merged home, and gone", async () => {
    const project = makeGitProject("gamma");
    const started = await lib.startRun({
      task: "build an invoice page", directory: "gamma", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const worktreePath = lib.getRun(started.id)!.worktree!.path;
    await pipelineSettles(started.id, "complete");

    await vi.waitFor(() => {
      expect(lib.getRun(started.id)?.worktree?.removed).toBe(true);
    }, { timeout: 20_000, interval: 50 });
    expect(fs.existsSync(worktreePath)).toBe(false);
    // …and the work is home, which is the other half of the settle doing its job.
    expect(fs.existsSync(path.join(project, "invoice.html"))).toBe(true);
  });
});
