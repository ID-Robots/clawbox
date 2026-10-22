/**
 * What a coding team costs, on the board (src/lib/coding-team-board.ts) and in
 * the planner's answer (src/lib/coding-team-planner.ts):
 *
 *  - the planner's REPO MAP, bounded, posted once by the planner alone, on the
 *    bus like every other change, and kept across a reload;
 *  - TOKENS PER ROLE, from the cast list, and BY KIND (fresh input, output,
 *    cache written, cache read) from each run's own record;
 *  - the RUN-OR-TEAM advice: one task, or tasks whose files mostly overlap,
 *    say a single run would have been cheaper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let root: string;
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return { ...actual, get DATA_DIR() { return path.join(root, "data"); } };
});

type Board = typeof import("@/lib/coding-team-board");
type Bus = typeof import("@/lib/coding-team-bus");
type Planner = typeof import("@/lib/coding-team-planner");
let board: Board;
let bus: Bus;
let planner: Planner;

const PLANNER = { kind: "planner" } as const;
const OWNER = { kind: "owner" } as const;
const SYSTEM = { kind: "system" } as const;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "team-cost-"));
  vi.resetModules();
  board = await import("@/lib/coding-team-board");
  bus = await import("@/lib/coding-team-bus");
  planner = await import("@/lib/coding-team-planner");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fresh() {
  return board.createBoard({ goal: "Build the invoice app", projectId: null, directory: "/home/clawbox/Projects/inv", source: "owner" }, OWNER);
}

const MAP = {
  files: ["src/app.ts — the server", "src/invoice.ts — the model"],
  entry_points: ["src/app.ts"],
  test_commands: ["bun run test"],
  gotchas: ["tsc needs NODE_OPTIONS=--max-old-space-size=6144"],
};

describe("the planner's repo map", () => {
  it("is read out of the plan, bounded, and absent from a bare array", () => {
    const tasks = [{ task_description: "Build it", files_hint: ["src/app.ts"] }, { task_description: "Test it", depends_on: ["t1"], files_hint: ["tests/"] }];
    const out = planner.parsePlan(JSON.stringify({ shape: { parallelism: 1, review: "final", rationale: "" }, repo_map: MAP, tasks }));
    expect(out.ok && out.repoMap).toEqual({ files: MAP.files, entryPoints: MAP.entry_points, testCommands: MAP.test_commands, gotchas: MAP.gotchas });
    const bare = planner.parsePlan(JSON.stringify(tasks));
    expect(bare.ok && bare.repoMap).toBeNull();
  });

  it("never refuses a plan whose tasks are fine because its map is not", () => {
    const tasks = [{ task_description: "Build it" }, { task_description: "Test it" }];
    for (const repo_map of ["just prose", 7, { files: "src/app.ts" }, { files: [1, 2] }, null]) {
      const out = planner.parsePlan(JSON.stringify({ repo_map, tasks }));
      expect(out.ok, JSON.stringify(repo_map)).toBe(true);
      if (out.ok) expect(out.repoMap).toBeNull();
    }
  });

  it("keeps each list short, each entry on one line, drops repeats, and fits the whole map in its bound", () => {
    const long = Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts — ${"words ".repeat(60)}`);
    const map = board.normalizeRepoMap({ files: [...long, long[0]], test_commands: ["bun run test", "bun run test", "  bun\n run   lint "] })!;
    expect(map.files.length).toBeLessThanOrEqual(board.MAX_REPO_MAP_ITEMS);
    expect(map.files.every((f) => f.length <= board.MAX_REPO_MAP_ITEM_CHARS && !f.includes("\n"))).toBe(true);
    // The long list gave up its entries first: the test commands survived.
    expect(map.testCommands).toEqual(["bun run test", "bun run lint"]);
    expect(board.repoMapText(map).length).toBeLessThanOrEqual(board.MAX_REPO_MAP_CHARS);
    expect(board.normalizeRepoMap({ files: [], gotchas: ["  "] })).toBeNull();
  });

  it("asks the planner for one in its brief, and says a one-task plan runs as one run", () => {
    expect(planner.PLANNER_BRIEF).toContain('"repo_map"');
    expect(planner.PLANNER_BRIEF).toMatch(/test_commands/);
    expect(planner.PLANNER_BRIEF).toMatch(/ONE task runs as a single ordinary run/);
    expect(planner.PLANNER_BRIEF).toMatch(/edit mostly the same files/);
    // The other lever on cost: token-heavy, non-critical work marked bulk, for a cheaper model.
    expect(planner.PLANNER_BRIEF).toMatch(/"bulk" marks a task that is token-heavy and not critical .* so its worker may run on a cheaper model/);
  });

  it("goes on the board through the bus, once, as the planner's alone — and survives a reload", () => {
    const b = fresh();
    const teamBus = new bus.TeamBus(b);
    for (const who of [OWNER, SYSTEM, { kind: "reviewer" } as const, { kind: "worker", id: "run-aaaaaaaa" } as const]) {
      expect(() => teamBus.send(who, { type: "repo_map", ...MAP })).toThrow();
    }
    expect(b.repoMap).toBeNull();
    teamBus.send(PLANNER, { type: "repo_map", ...MAP });
    expect(b.repoMap?.testCommands).toEqual(["bun run test"]);
    expect(b.log.find((e) => e.type === "repo_map")?.message).toBe("Repo map: 2 file(s), 1 entry point(s), 1 test command(s), 1 gotcha(s)");
    expect(() => teamBus.send(PLANNER, { type: "repo_map", ...MAP })).toThrow(/already has its repo map/);
    // A malformed one is refused on its shape.
    expect(bus.validateMessage({ type: "repo_map", files: "x", entry_points: [], test_commands: [], gotchas: [] })).toMatch(/files is a list/);
    const back = board.loadBoard(b.id)!;
    expect(back.repoMap).toEqual(b.repoMap);
    expect(board.repoMapText(back.repoMap)).toBe([
      "Files: src/app.ts — the server; src/invoice.ts — the model",
      "Entry points: src/app.ts",
      "Test commands: bun run test",
      "Gotchas: tsc needs NODE_OPTIONS=--max-old-space-size=6144",
    ].join("\n"));
  });

  it("reads as none — and a single run as not — on a board written before either existed", () => {
    const b = fresh();
    board.saveBoard(b);
    const file = path.join(root, "data", "coding-team", `${b.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw.repoMap;
    delete raw.singleRun;
    fs.writeFileSync(file, JSON.stringify(raw));
    const back = board.loadBoard(b.id)!;
    expect(back.repoMap).toBeNull();
    expect(back.singleRun).toBe(false);
  });
});

describe("tokens per role", () => {
  it("adds each run's tokens up under the role it ran in, beside the total", () => {
    const b = fresh();
    b.runs.push(
      { id: "run-00000001", role: "planner", taskId: null, tokens: 12_000 },
      { id: "run-00000002", role: "worker", taskId: "t1", tokens: 90_000 },
      { id: "run-00000003", role: "worker", taskId: "t2", tokens: 50_000 },
      { id: "run-00000004", role: "reviewer", taskId: "t1", tokens: 8_000 },
      { id: "run-00000005", role: "lead", taskId: "t2", tokens: 3_000 },
      // Still working: counted once its record settles, nothing before.
      { id: "run-00000006", role: "reviewer", taskId: "t2" },
    );
    const m = board.teamMetrics(b);
    expect(m.tokensByRole).toEqual({ planner: 12_000, worker: 140_000, reviewer: 8_000, lead: 3_000 });
    expect(m.tokensUsed).toBe(163_000);
    board.saveBoard(b);
    expect(board.loadBoard(b.id)!.metrics.tokensByRole).toEqual(m.tokensByRole);
  });

  it("is all zeros on a new board", () => {
    expect(fresh().metrics.tokensByRole).toEqual({ planner: 0, worker: 0, reviewer: 0, lead: 0 });
  });
});

describe("tokens per provider", () => {
  it("adds each run's tokens up under the account it was paid from, and keeps each run's model across a reload", () => {
    const b = fresh();
    b.runs.push(
      { id: "run-00000001", role: "planner", taskId: null, tokens: 12_000, provider: "anthropic", model: "claude-fable-5-1", modelRole: "planner" },
      { id: "run-00000002", role: "worker", taskId: "t1", tokens: 90_000, provider: "clawbox-ai", model: "deepseek-v4-flash", modelRole: "bulk" },
      { id: "run-00000003", role: "worker", taskId: "t2", tokens: 50_000, provider: "clawbox-ai", model: null, modelRole: "worker" },
      { id: "run-00000004", role: "reviewer", taskId: "t1", tokens: 8_000, provider: "anthropic", model: "claude-sonnet-5", modelRole: "reviewer" },
      { id: "run-00000005", role: "lead", taskId: "t2", tokens: 3_000, provider: "anthropic", model: "claude-fable-5-1", modelRole: "planner" },
      // Still working: on its account already, its tokens once its record settles.
      { id: "run-00000006", role: "reviewer", taskId: "t2", provider: "anthropic", model: "claude-sonnet-5", modelRole: "reviewer" },
      // A run from before the field: in the total, on no account.
      { id: "run-00000007", role: "worker", taskId: "t3", tokens: 1_000 },
    );
    const m = board.teamMetrics(b);
    expect(m.tokensByProvider).toEqual({ "clawbox-ai": 140_000, anthropic: 23_000 });
    expect(m.tokensUsed).toBe(164_000);
    board.saveBoard(b);
    const back = board.loadBoard(b.id)!;
    expect(back.metrics.tokensByProvider).toEqual(m.tokensByProvider);
    expect(back.runs).toEqual(b.runs);
    expect(back.runs[6]).not.toHaveProperty("provider");
    expect(back.runs[6]).not.toHaveProperty("model");
    expect(back.runs[6]).not.toHaveProperty("modelRole");
  });

  it("is every provider at zero on a new board", () => {
    expect(fresh().metrics.tokensByProvider).toEqual({ "clawbox-ai": 0, anthropic: 0 });
  });

  it("loads a board from before the field — and one hand-edited — without inventing an account", () => {
    const b = fresh();
    board.saveBoard(b);
    const file = path.join(root, "data", "coding-team", `${b.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete (raw.metrics as Record<string, unknown>).tokensByProvider;
    raw.runs = [
      { id: "run-00000001", role: "planner", taskId: null, tokens: 4_000 },
      { id: "run-00000002", role: "worker", taskId: "t1", tokens: 6_000, provider: "openai", model: "gpt x", modelRole: "boss" },
      { id: "run-00000003", role: "worker", taskId: "t2", tokens: 7_000, provider: "anthropic", model: 42, modelRole: "bulk" },
    ];
    fs.writeFileSync(file, JSON.stringify(raw));
    const back = board.loadBoard(b.id)!;
    expect(back.runs).toEqual([
      { id: "run-00000001", role: "planner", taskId: null, tokens: 4_000 },
      { id: "run-00000002", role: "worker", taskId: "t1", tokens: 6_000 },
      { id: "run-00000003", role: "worker", taskId: "t2", tokens: 7_000, provider: "anthropic", modelRole: "bulk" },
    ]);
    expect(back.metrics.tokensByProvider).toEqual({ "clawbox-ai": 0, anthropic: 7_000 });
    expect(back.metrics.tokensUsed).toBe(17_000);
  });
});

describe("tokens by kind", () => {
  const ZERO = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const WORKER = { input: 9_000, output: 1_500, cacheCreation: 2_000, cacheRead: 150_000 };
  const REVIEWER = { input: 700, output: 300, cacheCreation: 0, cacheRead: 11_000 };

  it("adds each run's own breakdown up, in total and by role, and keeps it across a reload", () => {
    const b = fresh();
    b.runs.push(
      { id: "run-00000001", role: "worker", taskId: "t1", tokens: 162_500, tokenBreakdown: { ...WORKER } },
      { id: "run-00000002", role: "reviewer", taskId: "t1", tokens: 12_000, tokenBreakdown: { ...REVIEWER } },
      // From before the field: in the total, in no kind.
      { id: "run-00000003", role: "worker", taskId: "t2", tokens: 5_000 },
      // Still working: nothing yet.
      { id: "run-00000004", role: "reviewer", taskId: "t2" },
    );
    const m = board.teamMetrics(b);
    expect(m.tokenBreakdown).toEqual({ input: 9_700, output: 1_800, cacheCreation: 2_000, cacheRead: 161_000 });
    expect(m.tokenBreakdownByRole.worker).toEqual(WORKER);
    expect(m.tokenBreakdownByRole.reviewer).toEqual(REVIEWER);
    expect(m.tokenBreakdownByRole.planner).toEqual(ZERO);
    expect(m.tokenBreakdownByRole.lead).toEqual(ZERO);
    expect(m.tokensUsed).toBe(179_500);
    board.saveBoard(b);
    const back = board.loadBoard(b.id)!;
    expect(back.runs).toEqual(b.runs);
    expect(back.runs[2]).not.toHaveProperty("tokenBreakdown");
    expect(back.metrics.tokenBreakdown).toEqual(m.tokenBreakdown);
    expect(back.metrics.tokenBreakdownByRole).toEqual(m.tokenBreakdownByRole);
  });

  it("counts only finite, non-negative figures", () => {
    const b = fresh();
    b.runs.push({ id: "run-00000001", role: "worker", taskId: "t1", tokens: 40, tokenBreakdown: { input: -5, output: Infinity, cacheCreation: NaN, cacheRead: 40 } });
    expect(board.teamMetrics(b).tokenBreakdown).toEqual({ ...ZERO, cacheRead: 40 });
  });

  it("is all zeros on a new board", () => {
    const m = fresh().metrics;
    expect(m.tokenBreakdown).toEqual(ZERO);
    expect(m.tokenBreakdownByRole).toEqual({ planner: ZERO, worker: ZERO, reviewer: ZERO, lead: ZERO });
  });

  it("loads a board saved before the field with zeros and the same tokensUsed — and reads a hand-edited one leniently", () => {
    const b = fresh();
    board.saveBoard(b);
    const file = path.join(root, "data", "coding-team", `${b.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete (raw.metrics as Record<string, unknown>).tokenBreakdown;
    delete (raw.metrics as Record<string, unknown>).tokenBreakdownByRole;
    raw.runs = [
      { id: "run-00000001", role: "planner", taskId: null, tokens: 4_000 },
      { id: "run-00000002", role: "worker", taskId: "t1", tokens: 6_000 },
    ];
    fs.writeFileSync(file, JSON.stringify(raw));
    const old = board.loadBoard(b.id)!;
    expect(old.runs).toEqual(raw.runs);
    expect(old.metrics.tokensUsed).toBe(10_000);
    expect(old.metrics.tokensByRole).toEqual({ planner: 4_000, worker: 6_000, reviewer: 0, lead: 0 });
    expect(old.metrics.tokenBreakdown).toEqual(ZERO);
    expect(old.metrics.tokenBreakdownByRole).toEqual({ planner: ZERO, worker: ZERO, reviewer: ZERO, lead: ZERO });

    raw.runs = [
      { id: "run-00000001", role: "worker", taskId: "t1", tokens: 50, tokenBreakdown: { input: "7", output: -1, cacheCreation: null, cacheRead: 50, extra: 9 } },
      { id: "run-00000002", role: "worker", taskId: "t2", tokens: 6, tokenBreakdown: "lots" },
    ];
    fs.writeFileSync(file, JSON.stringify(raw));
    const edited = board.loadBoard(b.id)!;
    expect(edited.runs).toEqual([
      { id: "run-00000001", role: "worker", taskId: "t1", tokens: 50, tokenBreakdown: { ...ZERO, cacheRead: 50 } },
      { id: "run-00000002", role: "worker", taskId: "t2", tokens: 6 },
    ]);
    expect(edited.metrics.tokenBreakdown).toEqual({ ...ZERO, cacheRead: 50 });
    expect(edited.metrics.tokensUsed).toBe(56);
  });
});

describe("a bulk task", () => {
  it("keeps its role on the board through the bus and a reload; a worker's task carries none", () => {
    const b = fresh();
    const teamBus = new bus.TeamBus(b);
    teamBus.send(PLANNER, { type: "task", task_description: "Scrape the catalogue", files_hint: ["data/"], role: "bulk" });
    teamBus.send(PLANNER, { type: "task", task_description: "Build the page", files_hint: ["index.html"], role: "worker" });
    expect(b.tasks.map((t) => t.role)).toEqual(["bulk", undefined]);
    expect(b.tasks[1]).not.toHaveProperty("role");
    const posted = b.log.filter((e) => e.type === "task");
    expect(posted.map((e) => e.message)).toEqual(["Task t1 (bulk) posted: Scrape the catalogue", "Task t2 posted: Build the page"]);
    expect(posted[0].payload).toMatchObject({ role: "bulk" });
    expect(posted[1].payload).not.toHaveProperty("role");
    const back = board.loadBoard(b.id)!;
    expect(back.tasks[0].role).toBe("bulk");
    expect(back.tasks[1]).not.toHaveProperty("role");
  });

  it("is refused a role off the list, on the bus and on the board alike", () => {
    const b = fresh();
    expect(bus.validateMessage({ type: "task", task_description: "x", role: "boss" })).toBe("A task's role is worker or bulk.");
    expect(() => board.postTask(b, PLANNER, { task_description: "x", role: "boss" as never })).toThrow("A task's role is worker or bulk.");
    expect(b.tasks).toEqual([]);
  });
});

describe("run or team", () => {
  const post = (b: ReturnType<typeof fresh>, ...hints: string[][]) => {
    for (const files_hint of hints) board.postTask(b, PLANNER, { task_description: `Task touching ${files_hint.join(", ") || "nothing"}`, files_hint });
  };

  it("says nothing before the plan", () => {
    expect(board.teamAdvice(fresh())).toBeNull();
  });

  it("says a single run would have been cheaper for a one-task plan", () => {
    const b = fresh();
    post(b, ["README.md"]);
    expect(board.teamAdvice(b)).toEqual({ reason: "one_task", overlap: 100 });
  });

  it("says it when most of the plan's hinted files are named by another task too", () => {
    const b = fresh();
    post(b, ["src/app.ts", "src/invoice.ts"], ["src/app.ts", "src/invoice.ts"], ["./src/app.ts", "README.md"]);
    // 5 of the 6 hints are shared: README.md is the one only its task names.
    expect(board.teamAdvice(b)).toEqual({ reason: "overlap", overlap: 83 });
  });

  it("counts a folder hint as overlapping the files inside it", () => {
    const b = fresh();
    post(b, ["src/"], ["src/app.ts"]);
    expect(board.teamAdvice(b)).toEqual({ reason: "overlap", overlap: 100 });
  });

  it("says nothing for a plan that splits cleanly, or one that names too few files to judge", () => {
    const clean = fresh();
    post(clean, ["index.html"], ["styles.css"], ["app.js", "index.html"]);
    // 2 of 4 shared — half, under the bar.
    expect(board.teamAdvice(clean)).toBeNull();
    const vague = fresh();
    post(vague, ["index.html"], []);
    expect(board.teamAdvice(vague)).toBeNull();
  });

  it("judges the plan, not the tasks the lead added later", () => {
    const b = fresh();
    post(b, ["index.html"]);
    board.postTask(b, PLANNER, { task_description: "Added by the lead", files_hint: ["index.html"], origin: "lead" });
    expect(board.teamAdvice(b)).toEqual({ reason: "one_task", overlap: 100 });
  });
});
