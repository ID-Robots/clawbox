/**
 * GET /setup-api/coding-agent/runs?id= — a run in a worktree that was refused
 * on the project's own path and pointed at its worktree (coding-agent.ts,
 * coding-worktree-paths.ts): the record the route answers carries how many
 * refusals were hinted (`worktreeHints`) and, on each such `denials` entry,
 * where the run was pointed (`worktreePath`) — what a coding team reads to
 * take them as a note — re-validated off disk like every other field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/browser-sessions", () => ({ closeSessionsForRun: vi.fn(async () => 0) }));
vi.mock("@/lib/project-icon", () => ({ ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })) }));

type Lib = typeof import("@/lib/coding-agent");

let base: string;
let root: string;
let project: string;
let worktree: string;
let restore: () => void;
let GET: (req: Request) => Promise<Response>;
let lib: Lib;

const runsFile = () => path.join(root, "data", "coding-agent-runs.json");

function settledRecord(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    task: "style it",
    directory: worktree,
    projectId: null,
    source: "owner",
    status: "completed",
    startedAt: Date.now() - 60_000,
    completedAt: Date.now() - 1_000,
    sessionId: "sess-hint-1",
    provider: "clawbox-ai",
    requestedModel: null,
    model: null,
    summary: "Styled it.",
    error: null,
    numTurns: 2,
    filesTouched: ["styles.css"],
    commandsRun: 0,
    progress: [],
    progressAt: [],
    exitCode: 0,
    effort: "max",
    maxTurns: 150,
    lastActivityAt: Date.now() - 1_000,
    unit: null,
    pgid: null,
    ...extra,
  };
}

async function readRun(id: string): Promise<Record<string, unknown>> {
  const res = await GET(new Request(`http://localhost/setup-api/coding-agent/runs?id=${id}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { run: Record<string, unknown> }).run;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-worktree-hint-route-"));
  const home = path.join(base, "home");
  root = path.join(home, "clawbox");
  project = path.join(home, "Projects", "site");
  worktree = path.join(project, ".clawbox", "worktrees", "t1-1");
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ clawai_token: "claw_test_token", coding_agent_enabled: true }), "utf-8");
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  GET = (await import("@/app/setup-api/coding-agent/runs/route")).GET;
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a worktree run's hinted refusals, through the route", () => {
  it("answers how many were hinted and where each was pointed, beside the refusals as they always were", async () => {
    fs.writeFileSync(runsFile(), JSON.stringify([settledRecord("run-hinted01", {
      permissionDenials: 3,
      deniedActions: [`Read: ${project}/styles.css`, `Write: ${project}/new.css`, "Read: /etc/hostname"],
      denials: [
        { text: `Read: ${project}/styles.css`, rule: null, refusal: null, worktreePath: `${worktree}/styles.css` },
        { text: `Write: ${project}/new.css`, rule: null, refusal: null, worktreePath: `${worktree}/new.css` },
        { text: "Read: /etc/hostname", rule: null, refusal: null },
      ],
      worktreeHints: 2,
      messages: [{ at: Date.now() - 30_000, text: `[from ClawBox] Your Read was refused: its path is outside your folder. Your folder is ${worktree}.`, deliveredAt: Date.now() - 30_000 }],
    })]));
    const run = await readRun("run-hinted01");
    expect(run).toMatchObject({ permissionDenials: 3, worktreeHints: 2 });
    expect(run.denials).toEqual([
      { text: `Read: ${project}/styles.css`, rule: null, refusal: null, worktreePath: `${worktree}/styles.css` },
      { text: `Write: ${project}/new.css`, rule: null, refusal: null, worktreePath: `${worktree}/new.css` },
      { text: "Read: /etc/hostname", rule: null, refusal: null },
    ]);
    expect((run.messages as Array<{ text: string }>)[0].text.startsWith("[from ClawBox] ")).toBe(true);
  });

  it("re-validates the marks off disk: a count that is not one, and a path that is not absolute, are dropped", async () => {
    fs.writeFileSync(runsFile(), JSON.stringify([
      settledRecord("run-bogus001", {
        permissionDenials: 1,
        deniedActions: [`Read: ${project}/styles.css`],
        denials: [{ text: `Read: ${project}/styles.css`, rule: null, refusal: null, worktreePath: "styles.css" }],
        worktreeHints: -4,
      }),
      settledRecord("run-bogus002", { permissionDenials: 0, deniedActions: [], denials: [], worktreeHints: "2" }),
      // Written before a run could be pointed at its worktree.
      settledRecord("run-before01", { permissionDenials: 1, deniedActions: [`Read: ${project}/styles.css`], denials: [{ text: `Read: ${project}/styles.css`, rule: null, refusal: null }] }),
    ]));
    const bogus = await readRun("run-bogus001");
    expect(bogus.worktreeHints).toBe(0);
    expect(bogus.denials).toEqual([{ text: `Read: ${project}/styles.css`, rule: null, refusal: null }]);
    expect((await readRun("run-bogus002")).worktreeHints).toBe(0);
    const before = await readRun("run-before01");
    expect(before.worktreeHints).toBe(0);
    expect((before.denials as Array<Record<string, unknown>>)[0]).not.toHaveProperty("worktreePath");
  });
});
