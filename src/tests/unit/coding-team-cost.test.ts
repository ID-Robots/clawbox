/**
 * What a coding team costs, on the board (src/lib/coding-team-board.ts) and in
 * the planner's answer (src/lib/coding-team-planner.ts):
 *
 *  - the planner's REPO MAP, bounded, posted once by the planner alone, on the
 *    bus like every other change, and kept across a reload;
 *  - TOKENS PER ROLE, from the cast list;
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
