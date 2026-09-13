/**
 * The delivery pipeline as the runner actually drives it, against a fake
 * harness — the same shape `coding-agent-durable-completion.test.ts` uses, and
 * for the same reason.
 *
 * WHAT THE PURE SUITE CANNOT SEE. `coding-pipeline.test.ts` proves the ORDER and
 * the routing. What it cannot prove is that this box does them: that the review
 * stage really is the automatic review pass, that an improvement lap resumes the
 * SAME record in the SAME session, that a deployment settling through the
 * watcher that already existed closes the deploy stage, that the finish notice
 * is HELD until the pipeline is over (a "finished" notice for a run about to
 * deploy to production is the exact claim this feature removes), and that a run
 * without a pipeline behaves precisely as it always did.
 *
 * Vercel and the looking are mocked; everything between them is the real runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import type { PipelineVerification } from "@/lib/coding-pipeline";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const announceCodingAgent = vi.hoisted(() => vi.fn(async (run: { id: string; status: string }) => { void run; }));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));
vi.mock("@/lib/coding-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-git")>()),
  commitRunWork: vi.fn(async () => ({ committed: false, reason: "no_changes" })),
  newestCommitSince: vi.fn(async () => null),
}));
vi.mock("@/lib/coding-pr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-pr")>()),
  openPullRequest: vi.fn(async () => ({ ok: false, detail: "no remote" })),
}));

// ── Vercel, all of it ────────────────────────────────────────────────────────

const checkVercelReadiness = vi.hoisted(() => vi.fn<() => Promise<import("@/lib/vercel-link").VercelReadiness>>(async () => ({
  linked: true, projectId: "prj_1", teamId: null, tokenSecretName: "VERCEL_TOKEN",
  tokenPresent: true, tokenValid: true, username: "u", projectResolves: true,
  projectName: "site", ready: true, problems: [] as string[], code: null,
})));
const readVercelLink = vi.hoisted(() => vi.fn(async () => ({ projectId: "prj_1", teamId: null, tokenSecretName: "VERCEL_TOKEN" })));
vi.mock("@/lib/vercel-link", () => ({
  checkVercelReadiness,
  readVercelLink,
  resolveVercelAuth: vi.fn(async () => ({ token: "t", teamId: null })),
}));

const readAutoProduction = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/vercel-deploy-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel-deploy-store")>()),
  readAutoProduction,
}));

/** What the deployment watcher is told when it asks about the build. */
const deploymentReadyState = vi.hoisted(() => ({ value: "ready" as "ready" | "error" }));
vi.mock("@/lib/vercel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/vercel")>();
  return {
    ...real,
    readProject: vi.fn(async () => ({ ok: true, name: "site", gitLink: null, productionDomain: "site.example.com" })),
    readDeployment: vi.fn(async (_auth: unknown, id: string) => ({
      ok: true,
      deployment: {
        id, readyState: deploymentReadyState.value, url: "x-abc.vercel.app",
        inspectorUrl: null, target: null, branch: null, sha: null, createdAt: 1,
        errorMessage: deploymentReadyState.value === "error" ? "the build failed" : null,
      },
    })),
    readBuildLog: vi.fn(async () => ({ ok: true, log: "error TS2304" })),
  };
});

/** Every deploy succeeds; the WATCHER is what decides how the build went. */
const runDeployment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel-deploy-run", () => ({ runDeployment, MAX_PRODUCTION_DEPLOYS: 3 }));

/** The looking, steered per test. */
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
let restore: () => void;
let deployCount = 0;

const INIT = '{"type":"system","subtype":"init","session_id":"sess-pipe-1","model":"deepseek-v4-pro","permissionMode":"acceptEdits"}';
const STDIN_DELIMITER = "<<<clawbox-stdin-end>>>";

function stdinLog(): string[] {
  const file = path.join(base, "stdin.log");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").split(STDIN_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

function okResult(text = "Done."): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1 });
}

/**
 * A harness that succeeds and TOUCHES A FILE every turn.
 *
 * The file matters: `maybeStartReviewPass` skips a run that changed nothing, so
 * a stand-in that only printed would never start the review stage the pipeline
 * waits on.
 */
function installHarness(body?: string): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      'STDIN="$(head -n 1)"',
      `printf '%s\\n%s\\n' "$STDIN" '${STDIN_DELIMITER}' >> "${path.join(base, "stdin.log")}"`,
      body ?? "",
      // A Write is only COUNTED when its tool_result comes back clean — which
      // is what `maybeStartReviewPass` reads, and therefore what decides
      // whether the pipeline's review stage runs at all.
      `printf '%s\\n' '${INIT}' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"file_path":"app.js"}}]}}' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1"}]}}' '${okResult()}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function writeConfig(cfg: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({
    clawai_token: "claw_test_token",
    coding_agent_enabled: true,
    // The pipeline's review stage IS this pass, and the rounds cap its loop.
    coding_agent_review_pass: true,
    coding_agent_review_rounds: 2,
    ...cfg,
  }), "utf-8");
}

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

function verification(ok: boolean, over: Partial<PipelineVerification> = {}): PipelineVerification {
  return {
    ok,
    url: "https://x-abc.vercel.app/",
    status: ok ? 200 : 200,
    reason: ok ? null : "The page is up but does not contain \"Invoice\".",
    judgedBy: "expectations",
    expectations: [{ text: "Invoice", found: ok }],
    vision: null,
    screenshot: "verify-1.png",
    checkedAt: Date.now(),
    ...over,
  };
}

/** Wait until the pipeline stops moving — settled, or parked on the owner. */
async function pipelineSettles(id: string, want?: string) {
  await vi.waitFor(() => {
    const run = lib.getRun(id);
    expect(run?.pipeline).toBeTruthy();
    const status = run!.pipeline!.status;
    expect(status === "running").toBe(false);
    if (want) expect(status).toBe(want);
  }, { timeout: 45_000, interval: 50 });
  return lib.getRun(id)!;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-pipeline-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  writeConfig();
  deployCount = 0;
  deploymentReadyState.value = "ready";
  announceCodingAgent.mockClear();
  checkVercelReadiness.mockClear();
  readAutoProduction.mockReset();
  readAutoProduction.mockResolvedValue(false);
  verifyDeployment.mockReset();
  verifyDeployment.mockResolvedValue(verification(true));
  runDeployment.mockReset();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  // The deploy has to reach `recordManualDeployment`, which is what arms the
  // watcher the pipeline listens to — mocking it away would leave the deploy
  // stage waiting for an event nothing could send.
  runDeployment.mockImplementation(async (input: { runId: string | null; target: string }) => {
    deployCount += 1;
    const deployment = {
      id: `dpl_${deployCount}`, readyState: "queued" as const, url: "x-abc.vercel.app",
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
  makeProject("site");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a run with no pipeline", () => {
  it("settles exactly as it always did", async () => {
    installHarness();
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    await vi.waitFor(() => expect(lib.getRun(started.id)?.status).not.toBe("running"), { timeout: 20_000, interval: 50 });
    expect(lib.getRun(started.id)!.pipeline).toBeNull();
    expect(runDeployment).not.toHaveBeenCalled();
  });
});

describe("the whole flow, end to end", () => {
  it("builds, reviews, deploys a preview, checks it, and waits for the owner on production", async () => {
    installHarness();
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const run = await pipelineSettles(started.id, "waiting_owner");
    const p = run.pipeline!;

    expect(p.stage).toBe("deploy_production");
    const state = (s: string) => p.steps.find((x) => x.stage === s)!.state;
    expect(state("build")).toBe("passed");
    expect(state("review")).toBe("passed");
    expect(state("deploy_preview")).toBe("passed");
    expect(state("verify_preview")).toBe("passed");
    expect(state("deploy_production")).toBe("waiting_owner");

    // ONE deploy so far, and it was the preview: production is the owner's.
    expect(runDeployment).toHaveBeenCalledTimes(1);
    expect(runDeployment.mock.calls[0][0]).toMatchObject({ target: "preview" });

    // The review stage really was the automatic review pass — a second run,
    // resuming this one's session.
    const reviewRun = lib.listRuns().find((r) => r.reviewOf === started.id);
    expect(reviewRun).toBeTruthy();
    expect(p.steps.find((x) => x.stage === "review")!.evidence.some((e) => e.ref === reviewRun!.id)).toBe(true);

    // The evidence a person can act on: the address, and the screenshot.
    const checkEvidence = p.steps.find((x) => x.stage === "verify_preview")!.evidence;
    expect(checkEvidence.some((e) => e.kind === "url" && e.ref === "https://x-abc.vercel.app/")).toBe(true);
    expect(checkEvidence.some((e) => e.kind === "screenshot" && e.ref === "verify-1.png")).toBe(true);

    // HELD: nothing has told the owner this run is finished, because it is not.
    expect(announceCodingAgent).not.toHaveBeenCalled();
  });

  it("goes to production and completes when the owner presses the button", async () => {
    installHarness();
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    await pipelineSettles(started.id, "waiting_owner");

    await lib.approvePipelineProduction(started.id);
    const run = await pipelineSettles(started.id, "complete");

    expect(runDeployment).toHaveBeenCalledTimes(2);
    expect(runDeployment.mock.calls[1][0]).toMatchObject({ target: "production" });
    // The production check goes at the project's own DOMAIN, not the
    // deployment's immutable address.
    expect(verifyDeployment.mock.calls.at(-1)![0]).toMatchObject({ deploymentUrl: "https://site.example.com" });
    expect(run.pipeline!.steps.find((s) => s.stage === "complete")!.state).toBe("passed");
    // `completed` stands, and NOW the owner is told — once.
    expect(run.status).toBe("completed");
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
  });

  it("ships straight through when the owner has switched production on for the project", async () => {
    readAutoProduction.mockResolvedValue(true);
    installHarness();
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const run = await pipelineSettles(started.id, "complete");
    expect(runDeployment).toHaveBeenCalledTimes(2);
    expect(run.status).toBe("completed");
  });

  it("stops at a verified preview when production was switched off for this run", async () => {
    installHarness();
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"], production: false },
    });
    const run = await pipelineSettles(started.id, "complete");
    expect(runDeployment).toHaveBeenCalledTimes(1);
    expect(run.pipeline!.steps.find((s) => s.stage === "deploy_production")!.attempt).toBe(0);
  });
});

describe("a check that fails", () => {
  it("sends the work back in the SAME session with what it saw, then gives up naming the stage", async () => {
    installHarness();
    verifyDeployment.mockResolvedValue(verification(false));
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const run = await pipelineSettles(started.id, "failed");

    // Two rounds were allowed and both were spent, each an improvement lap.
    expect(run.pipeline!.round).toBe(2);
    expect(run.pipeline!.failure?.stage).toBe("verify_preview");

    // The run itself ends `gave_up`, naming the stage — not `failed`, because
    // the harness worked and the session is intact.
    expect(run.status).toBe("gave_up");
    expect(run.error).toContain("preview verification");
    expect(run.resumable).toBe(true);

    // The laps are turns in the SAME record and the SAME session: no second
    // run record for them, and the nudge carried what the check saw.
    expect(lib.listRuns().filter((r) => r.id !== started.id && !r.reviewOf)).toHaveLength(0);
    const nudges = stdinLog().filter((s) => s.includes("delivery pipeline sent this work back"));
    expect(nudges).toHaveLength(2);
    // The nudge travels as JSON on stdin, so the quotes around it are escaped.
    expect(nudges[0]).toContain("Invoice");
    expect(nudges[0]).toContain("improvement round 1 of 2");

    // Told exactly once, at the end — not when the build settled.
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
    expect(announceCodingAgent.mock.calls[0][0].status).toBe("gave_up");
  });

  it("recovers when a later lap passes", async () => {
    installHarness();
    verifyDeployment.mockResolvedValueOnce(verification(false)).mockResolvedValue(verification(true));
    readAutoProduction.mockResolvedValue(true);
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const run = await pipelineSettles(started.id, "complete");
    expect(run.pipeline!.round).toBe(1);
    expect(run.status).toBe("completed");
  });
});

describe("a build that fails on Vercel", () => {
  it("closes the deploy stage and hands the build log to the improvement lap", async () => {
    installHarness();
    deploymentReadyState.value = "error";
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const run = await pipelineSettles(started.id, "failed");
    expect(run.pipeline!.failure?.stage).toBe("deploy_preview");
    const nudges = stdinLog().filter((s) => s.includes("delivery pipeline sent this work back"));
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges[0]).toContain("error TS2304");
    // The one-shot hand-back stood down: no `vercelFixOf` run was started
    // beside the pipeline's own lap.
    expect(lib.listRuns().some((r) => r.vercelFixOf)).toBe(false);
  });
});

describe("the preflight", () => {
  it("refuses a named pipeline before the run starts when nothing is attached", async () => {
    checkVercelReadiness.mockResolvedValueOnce({
      linked: false, projectId: null, teamId: null, tokenSecretName: null,
      tokenPresent: false, tokenValid: null, username: null, projectResolves: null,
      projectName: null, ready: false, problems: [], code: null,
    });
    installHarness();
    await expect(lib.startRun({
      task: "build", projectId: "site", source: "owner", pipeline: true,
    })).rejects.toThrow(/No Vercel project is attached/);
  });

  it("refuses when nothing was named to look for and the box has no vision model", async () => {
    // Asked of the preflight directly: the DEFAULT coding provider needs the
    // same ClawBox AI token, so a box without one is refused by
    // `assertProviderReady` before a pipeline is ever attached. The case this
    // covers is a run paid for by the owner's own Anthropic account on a box
    // that was never linked — where the run is fine and the checking is not.
    writeConfig({ clawai_token: "" });
    const refused = await lib.pipelinePreflight("site", { path: "/", expect: [] });
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { reason: string }).reason).toContain("no vision model");
    // …and it is not refused when the caller said what to look for.
    expect(await lib.pipelinePreflight("site", { path: "/", expect: ["Invoice"] })).toEqual({ ok: true });
  });

  it("refuses a request it cannot read, with the code beside the sentence", async () => {
    installHarness();
    await expect(lib.startRun({
      task: "build", projectId: "site", source: "owner", pipeline: { path: "invoices" },
    })).rejects.toMatchObject({ kind: "invalid", code: "bad_path" });
  });
});

describe("the owner's own gestures", () => {
  it("stopping a waiting pipeline ends it without failing the run", async () => {
    installHarness();
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    await pipelineSettles(started.id, "waiting_owner");
    const run = lib.stopRunPipeline(started.id);
    expect(run.pipeline!.status).toBe("stopped");
    // The run built what it built; the owner calling the rest off is not the
    // run failing.
    expect(run.status).toBe("completed");
    expect(announceCodingAgent).toHaveBeenCalledTimes(1);
  });

  it("approving twice is refused rather than deploying twice", async () => {
    readAutoProduction.mockResolvedValue(true);
    installHarness();
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    await pipelineSettles(started.id, "complete");
    await expect(lib.approvePipelineProduction(started.id)).rejects.toThrow(/not waiting for you/);
  });
});

// ─── what a restart leaves behind ────────────────────────────────────────────

/**
 * A record on disk, as the previous web server left it.
 *
 * Written rather than produced by a real run because the state being tested is
 * precisely the one no live process is in: the box went down mid-stage.
 */
function writeRunRecord(over: Record<string, unknown>): string {
  const id = `run-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const record = {
    id,
    task: "build an invoice page",
    directory: path.join(root, "data", "code-projects", "site"),
    projectId: "site",
    source: "owner",
    status: "completed",
    startedAt: now - 60_000,
    completedAt: now - 1_000,
    sessionId: "sess-pipe-1",
    model: null,
    provider: "clawbox-ai",
    requestedModel: null,
    summary: null,
    error: null,
    numTurns: 1,
    filesTouched: ["app.js"],
    commandsRun: 0,
    reviewOf: null,
    reviewLoopOf: null,
    vercelFixOf: null,
    vercel: null,
    team: null,
    readOnly: false,
    extraBrief: null,
    pr: null,
    review: null,
    permissionDenials: 0,
    deniedActions: [],
    progress: [],
    progressAt: [],
    ...over,
  };
  fs.writeFileSync(path.join(root, "data", "coding-agent-runs.json"), JSON.stringify([record]), "utf-8");
  return id;
}

/** A pipeline mid-flight, as a record carries it. */
function pipelineRecord(stage: string, stageState: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    stage,
    status: "running",
    startedAt: now - 60_000,
    endedAt: null,
    round: 0,
    maxRounds: 2,
    deadlineAt: now + 3_600_000,
    verify: { path: "/", expect: ["Invoice"] },
    production: true,
    failure: null,
    productionApprovedAt: null,
    lastVerification: null,
    steps: [{ stage, state: stageState, attempt: 1, startedAt: now - 10_000, endedAt: null, detail: null, evidence: [] }],
    ...over,
  };
}

describe("a restart in the middle of a stage", () => {
  it("re-runs a verification that was in flight — a fetch and a picture are cheap to make again", async () => {
    const id = writeRunRecord({
      pipeline: pipelineRecord("verify_preview", "running"),
      vercel: {
        phase: "ready", projectId: "prj_1", teamId: null, deploymentId: "dpl_1", readyState: "ready",
        url: "https://x-abc.vercel.app", inspectorUrl: null, target: "preview", branch: null, sha: null,
        startedAt: Date.now() - 5000, endedAt: Date.now(), detail: null, fixRunId: null, feedbackSent: true, promotion: null,
      },
    });
    lib.resumePipelines();
    await vi.waitFor(() => {
      expect(verifyDeployment).toHaveBeenCalled();
      expect(lib.getRun(id)!.pipeline!.stage).not.toBe("verify_preview");
    }, { timeout: 20_000, interval: 50 });
    // It carried on rather than starting over: the preview check passed and
    // production is the next thing it asks about.
    expect(lib.getRun(id)!.pipeline!.status).toBe("waiting_owner");
  });

  it("tries a deploy the restart landed BEFORE — nothing on the record means nothing can come back", async () => {
    const id = writeRunRecord({ pipeline: pipelineRecord("deploy_preview", "running"), vercel: null });
    lib.resumePipelines();
    await vi.waitFor(() => {
      expect(runDeployment).toHaveBeenCalledTimes(1);
      expect(lib.getRun(id)!.pipeline!.status).not.toBe("running");
    }, { timeout: 20_000, interval: 50 });
    expect(runDeployment.mock.calls[0][0]).toMatchObject({ target: "preview" });
  });

  it("leaves a deploy the box actually MADE alone — its own watcher is re-armed beside this", () => {
    writeRunRecord({
      pipeline: pipelineRecord("deploy_preview", "running"),
      vercel: {
        phase: "building", projectId: "prj_1", teamId: null, deploymentId: "dpl_1", readyState: "building",
        url: null, inspectorUrl: null, target: "preview", branch: null, sha: null,
        startedAt: Date.now(), endedAt: null, detail: null, fixRunId: null, feedbackSent: true, promotion: null,
      },
    });
    lib.resumePipelines();
    // Deploying it a second time would put two builds on the owner's account
    // for one push.
    expect(runDeployment).not.toHaveBeenCalled();
  });

  it("leaves a pipeline waiting on the OWNER alone — it is not waiting on this box", () => {
    writeRunRecord({
      pipeline: pipelineRecord("deploy_production", "waiting_owner", { status: "waiting_owner" }),
    });
    lib.resumePipelines();
    expect(runDeployment).not.toHaveBeenCalled();
    expect(verifyDeployment).not.toHaveBeenCalled();
  });

  it("does not ask the owner twice: an approval that survived the restart is honoured", async () => {
    const id = writeRunRecord({
      pipeline: pipelineRecord("deploy_production", "running", { productionApprovedAt: Date.now() - 1000 }),
      vercel: null,
    });
    // The per-project switch is OFF, which is why it stopped to ask in the
    // first place; the owner's press is on the record and stands.
    lib.resumePipelines();
    await vi.waitFor(() => expect(runDeployment).toHaveBeenCalledTimes(1), { timeout: 20_000, interval: 50 });
    expect(runDeployment.mock.calls[0][0]).toMatchObject({ target: "production" });
    await vi.waitFor(() => expect(lib.getRun(id)!.pipeline!.status).toBe("complete"), { timeout: 20_000, interval: 50 });
  });

  it("leaves a settled pipeline alone", () => {
    writeRunRecord({ pipeline: pipelineRecord("complete", "passed", { status: "complete", endedAt: Date.now() }) });
    lib.resumePipelines();
    expect(runDeployment).not.toHaveBeenCalled();
    expect(verifyDeployment).not.toHaveBeenCalled();
  });
});

describe("what an improvement lap is told", () => {
  it("names the stage that failed MOST RECENTLY, not the first one in order", async () => {
    installHarness();
    // The review stage fails first (the pass cannot start), then a later lap's
    // preview check fails. The second nudge must be about the check.
    let lap = 0;
    verifyDeployment.mockImplementation(async () => {
      lap += 1;
      return lap === 1 ? verification(false) : verification(true);
    });
    readAutoProduction.mockResolvedValue(true);
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    await pipelineSettles(started.id, "complete");
    const nudges = stdinLog().filter((s) => s.includes("delivery pipeline sent this work back"));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("preview verification stage");
  });

  it("does not hand a failed DEPLOY the verification from a lap that passed", async () => {
    installHarness();
    // Lap 1: the check passes, so `lastVerification` is a PASS on the record.
    // Lap 2's deploy then fails, and its nudge must not quote that pass as
    // "what this ClawBox checked".
    let deploys = 0;
    const realDeploy = runDeployment.getMockImplementation()!;
    verifyDeployment.mockResolvedValue(verification(true));
    readAutoProduction.mockResolvedValue(true);
    runDeployment.mockImplementation(async (input: { runId: string | null; target: string }) => {
      deploys += 1;
      // The production build is the one that fails.
      deploymentReadyState.value = deploys >= 2 ? "error" : "ready";
      return realDeploy(input);
    });
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const run = await pipelineSettles(started.id, "failed");
    // A production failure ends it rather than looping, so no nudge at all —
    // and the pass on the record is untouched by the failure.
    expect(run.pipeline!.failure?.stage).toBe("deploy_production");
    expect(run.pipeline!.lastVerification!.ok).toBe(true);
    expect(stdinLog().filter((s) => s.includes("delivery pipeline sent this work back"))).toHaveLength(0);
  });
});

describe("only one watcher on a run's deployment", () => {
  it("does not arm the git-integration watch beside a live pipeline", async () => {
    installHarness();
    const started = await lib.startRun({
      task: "build an invoice page", projectId: "site", source: "owner",
      pipeline: { path: "/", expect: ["Invoice"] },
    });
    const run = await pipelineSettles(started.id, "waiting_owner");
    // The one deployment on the record is the PIPELINE's own, not a watch
    // armed by the pull-request step for Vercel's git integration.
    expect(runDeployment).toHaveBeenCalledTimes(1);
    expect(run.vercel?.deploymentId).toBe("dpl_1");
    expect(run.vercel?.phase).toBe("ready");
  });
});
