/**
 * The runner's retry hint for a run in a WORKTREE (src/lib/coding-agent.ts,
 * src/lib/coding-worktree-paths.ts), against a fake claude-ds.
 *
 * Night validation, 2026-09-23: a coding-team worker in
 * `<project>/.clawbox/worktrees/<run>` read or wrote `<project>/<file>`, was
 * refused by folder containment, and the refusal failed the task with every
 * deliverable on disk. The refusal stands; what changed is that the run is
 * told, in its own transcript, the path in its worktree to retry with — and
 * the refusal is marked on the record so the team reads it as a note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { decodeHarnessTurns } from "@/tests/helpers/fake-harness";

// Starts real processes, like the runner's own suite.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const announce = vi.hoisted(() => vi.fn<(run: unknown) => Promise<undefined>>(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: announce }));
const memAvailable = vi.hoisted(() => vi.fn(async (): Promise<number | null> => 8000));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: memAvailable }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let project: string;
let worktree: string;
let restore: () => void;

const turnsFile = () => path.join(base, "turns.txt");
const INIT = '{"type":"system","subtype":"init","session_id":"sess-hint-1","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/**
 * A harness that asks for `calls` (each refused, as Claude Code answers a
 * path outside the working folder), reads `turns` lines of stdin — the task
 * and whatever the box writes back while it works — and reports the refusals.
 */
function installHarness(calls: Array<{ id: string; name: string; input: Record<string, unknown> }>, turns: number): void {
  const assistant = JSON.stringify({ type: "assistant", message: { content: calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })) } });
  const results = JSON.stringify({
    type: "user",
    message: { content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, is_error: true, content: `Claude requested permissions to use ${c.name}, but you have not granted it yet.` })) },
  });
  const result = JSON.stringify({
    type: "result", subtype: "success", is_error: false, num_turns: 2, result: "Done.", session_id: "sess-hint-1",
    permission_denials: calls.map((c) => ({ tool_name: c.name, tool_use_id: c.id, tool_input: c.input })),
  });
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      `echo '${INIT}'`,
      `echo '${assistant}'`,
      `echo '${results}'`,
      // Blocks until the box has written every hint it owes: the proof it
      // reached the harness while the run was still working.
      `head -n ${turns} > "${turnsFile()}"`,
      `echo '${result}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coding-worktree-hint-")));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  project = path.join(home, "Projects", "site");
  worktree = path.join(project, ".clawbox", "worktrees", "t1-1");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  for (const dir of [project, worktree]) fs.writeFileSync(path.join(dir, "styles.css"), "body {}");
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true });
  announce.mockClear();
  vi.resetModules();
  const messages = await import("@/lib/coding-run-messages");
  messages._resetStreamInputForTests();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const finished = async (id: string) => {
  const run = await lib.waitForRun(id, 20_000);
  if (!run) throw new Error("run vanished");
  return run;
};

describe("a run in a worktree refused on the project's own path", () => {
  it("is told, in its transcript and while it works, the path in its worktree to retry — reads and writes alike — and the record marks each one", async () => {
    installHarness([
      { id: "t_read", name: "Read", input: { file_path: `${project}/styles.css` } },
      // Nothing of the project's there: no hint, an ordinary refusal.
      { id: "t_miss", name: "Read", input: { file_path: `${project}/missing.css` } },
      // A new file: the write stays refused, and the worktree folder it belongs in is named.
      { id: "t_write", name: "Write", input: { file_path: `${project}/new.css`, content: "x" } },
      // Somewhere else entirely: not the worktree's to point at.
      { id: "t_etc", name: "Read", input: { file_path: "/etc/hostname" } },
    ], 3);
    const run = await lib.startRun({ task: "style it", directory: worktree, source: "owner" });
    expect(run.directory).toBe(worktree);
    const settled = await finished(run.id);
    expect(settled.status).toBe("completed");

    const turns = decodeHarnessTurns(fs.readFileSync(turnsFile(), "utf-8"));
    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain("style it");
    for (const [turn, tool, counterpart] of [[turns[1], "Read", `${worktree}/styles.css`], [turns[2], "Write", `${worktree}/new.css`]]) {
      expect(turn).toMatch(/^\[ClawBox: a note from this box about an action of yours it refused\./);
      expect(turn).toContain(`[from ClawBox] Your ${tool} was refused: its path is outside your folder. Your folder is ${worktree}`);
      expect(turn).toContain(`that path is ${counterpart}: retry with that path`);
      // The project's own path is never named to the run.
      expect(turn.split(worktree).join("")).not.toContain(project);
    }

    // The refusals stand, all four; two were answered with a hint, and say where.
    expect(settled.permissionDenials).toBe(4);
    expect(settled.worktreeHints).toBe(2);
    expect(settled.denials.map((d) => [d.text, d.worktreePath ?? null])).toEqual([
      [`Read: ${project}/styles.css`, `${worktree}/styles.css`],
      [`Read: ${project}/missing.css`, null],
      [`Write: ${project}/new.css`, `${worktree}/new.css`],
      ["Read: /etc/hostname", null],
    ]);
    // On the record and in the feed, as delivered — the road the owner's messages take.
    expect(settled.messages.map((m) => [m.text.split(":")[0], typeof m.deliveredAt])).toEqual([
      ["[from ClawBox] Your Read was refused", "number"],
      ["[from ClawBox] Your Write was refused", "number"],
    ]);
    expect(settled.progress.join("\n")).toContain("Message to the run: [from ClawBox] Your Read was refused");

    // The record keeps the marks across a reload.
    const onDisk = (JSON.parse(fs.readFileSync(path.join(root, "data", "coding-agent-runs.json"), "utf-8")) as Array<{ id: string; worktreeHints?: number; denials?: Array<{ worktreePath?: string }> }>)
      .find((r) => r.id === run.id);
    expect(onDisk?.worktreeHints).toBe(2);
    expect(onDisk?.denials?.[0]?.worktreePath).toBe(`${worktree}/styles.css`);
  });

  it("says one path once, however often the run is refused it", async () => {
    installHarness([
      { id: "t_a", name: "Read", input: { file_path: `${project}/styles.css` } },
      { id: "t_b", name: "Edit", input: { file_path: `${project}/styles.css`, old_string: "a", new_string: "b" } },
    ], 2);
    const run = await lib.startRun({ task: "style it", directory: worktree, source: "owner" });
    const settled = await finished(run.id);
    expect(decodeHarnessTurns(fs.readFileSync(turnsFile(), "utf-8"))).toHaveLength(2);
    expect(settled.messages).toHaveLength(1);
    // Both refusals are marked: the team counts every one.
    expect(settled.worktreeHints).toBe(2);
    expect(settled.denials.every((d) => d.worktreePath === `${worktree}/styles.css`)).toBe(true);
  });
});

describe("a worktree run on a harness that takes no streaming input", () => {
  it("leaves nothing in the owner's queue for a later spawn — and still marks the refusal for the team", async () => {
    const messages = await import("@/lib/coding-run-messages");
    messages.noteStreamInputRefused();
    const call = { id: "t_read", name: "Read", input: { file_path: `${project}/styles.css` } };
    const events = [
      INIT,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", ...call }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: "Not allowed." }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", session_id: "sess-hint-1", permission_denials: [{ tool_name: call.name, tool_use_id: call.id, tool_input: call.input }] }),
    ];
    fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    // `cat`: a plain spawn gets its task and an EOF.
    fs.writeFileSync(path.join(binDir, "claude-ds"), ["#!/usr/bin/env bash", `cat > "${turnsFile()}"`, ...events.map((e) => `echo '${e}'`), "exit 0"].join("\n"), { mode: 0o755 });
    const run = await lib.startRun({ task: "style it", directory: worktree, source: "owner" });
    const settled = await finished(run.id);
    expect(settled.messages).toEqual([]);
    expect(settled.worktreeHints).toBe(1);
    expect(settled.denials[0].worktreePath).toBe(`${worktree}/styles.css`);
  });
});

describe("a run that is not in a worktree", () => {
  it("is never pointed anywhere: its refusals are recorded as they always were", async () => {
    installHarness([{ id: "t_read", name: "Read", input: { file_path: `${project}/styles.css` } }], 1);
    const run = await lib.startRun({ task: "style it", directory: project, source: "owner" });
    const settled = await finished(run.id);
    expect(settled.permissionDenials).toBe(1);
    expect(settled.worktreeHints).toBe(0);
    expect(settled.denials[0].worktreePath).toBeUndefined();
    expect(settled.messages).toEqual([]);
  });
});
