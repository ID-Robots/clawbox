import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildTurnFromRows, readHermesTurn } from "@/lib/harness/hermes-turn-record";

/**
 * The turn, read back from the agent's own record instead of its console.
 *
 * EVERY FIXTURE HERE IS REAL. They are the rows `~/.hermes/state.db` actually
 * held on the bench box (2026-08-23, deepseek-v4-flash via the clawai provider)
 * after running the exact argv the chat route builds:
 *
 *   hermes chat -q "Hey" -Q -m deepseek-v4-flash --provider clawai
 *
 * That matters because the console output for the same turn is NOT clean — it
 * carries the monologue twice inside a frame that is never closed — and the
 * whole reason this module exists is that the database is. Fixtures invented
 * from the schema would not have shown that.
 */

/** The "Hey" turn, verbatim from `messages` (ids 199-200). */
const HEY_REASONING =
  'The user just said "Hey" - a simple greeting. I should respond warmly and briefly,'
  + " maybe mention I'm ready to help. No need for tools here. The user profile mentions"
  + " something private, but that's not relevant to a greeting. Just respond"
  + " naturally and concisely, in plain text since this is CLI.";

const HEY_ROWS = [
  { id: 199, role: "user", content: "Hey" },
  {
    id: 200,
    role: "assistant",
    content: "Hey! What can I help you with today?",
    // BOTH columns are populated by this provider, with the SAME text. This is
    // the duplication at its source — the CLI prints one of them live and the
    // other as a recap, which is how it reached the bubble twice.
    reasoning: HEY_REASONING,
    reasoning_content: HEY_REASONING,
    finish_reason: "stop",
  },
];

/** The `uname -sr` turn, verbatim from `messages` (ids 201-204). */
const TOOL_ROWS = [
  {
    id: 201,
    role: "user",
    content: "Run the shell command 'uname -sr' and tell me exactly what it printed.",
  },
  {
    id: 202,
    role: "assistant",
    content: "",
    tool_calls: JSON.stringify([
      {
        id: "call_00_TqRNw8iwWzxQpBfiTVph1791",
        call_id: "call_00_TqRNw8iwWzxQpBfiTVph1791",
        type: "function",
        function: { name: "terminal", arguments: '{"command": "uname -sr"}' },
      },
    ]),
    reasoning: "The user wants me to run 'uname -sr'. Let me run it.",
    reasoning_content: "The user wants me to run 'uname -sr'. Let me run it.",
    finish_reason: "tool_calls",
  },
  {
    id: 203,
    role: "tool",
    content: '{"output": "Linux 5.15.185-tegra", "exit_code": 0, "error": null}',
    tool_call_id: "call_00_TqRNw8iwWzxQpBfiTVph1791",
    tool_name: "terminal",
  },
  {
    id: 204,
    role: "assistant",
    content: "It printed:\n\nLinux 5.15.185-tegra\n\nSo the kernel is Linux 5.15.185.",
    finish_reason: "stop",
  },
];

describe("buildTurnFromRows", () => {
  it("returns the answer WITHOUT the monologue", () => {
    const turn = buildTurnFromRows(HEY_ROWS);
    expect(turn?.text).toBe("Hey! What can I help you with today?");
    expect(turn?.text).not.toContain("The user just said");
  });

  it("returns the monologue ONCE even though both columns carry it", () => {
    const turn = buildTurnFromRows(HEY_ROWS);
    expect(turn?.reasoning).toBe(HEY_REASONING);
    // The bug in one assertion: the monologue used to be pasted into the bubble
    // twice, so the phrase it opens with appeared twice too.
    const occurrences = turn?.reasoning?.split("The user just said").length ?? 0;
    expect(occurrences - 1).toBe(1);
  });

  it("claims no reasoning when the row has none", () => {
    const turn = buildTurnFromRows([
      { id: 1, role: "user", content: "hi" },
      { id: 2, role: "assistant", content: "hello" },
    ]);
    expect(turn).toEqual({ text: "hello" });
    expect(turn).not.toHaveProperty("reasoning");
  });

  it("reads a tool turn: final answer, its thinking, and the step it took", () => {
    const turn = buildTurnFromRows(TOOL_ROWS);
    expect(turn?.text).toBe(
      "It printed:\n\nLinux 5.15.185-tegra\n\nSo the kernel is Linux 5.15.185.",
    );
    expect(turn?.reasoning).toContain("Let me run it.");
    expect(turn?.toolCalls).toEqual([
      { name: "terminal", detail: "uname -sr", status: "ok" },
    ]);
  });

  it("marks a failed step from the tool's own result", () => {
    const rows = structuredClone(TOOL_ROWS);
    rows[2].content = '{"output": "", "exit_code": 127, "error": "not found"}';
    expect(buildTurnFromRows(rows)?.toolCalls?.[0].status).toBe("error");
  });

  it("leaves status off a call whose result was never recorded", () => {
    const rows = structuredClone(TOOL_ROWS).filter((row) => row.role !== "tool");
    const call = buildTurnFromRows(rows)?.toolCalls?.[0];
    expect(call?.name).toBe("terminal");
    expect(call).not.toHaveProperty("status");
  });

  it("reads only the LAST turn out of a resumed session", () => {
    // --resume replays the whole conversation into this table. Only the tail
    // belongs to the run that just finished, and an earlier answer must never
    // be served as this one's.
    const turn = buildTurnFromRows([...HEY_ROWS, ...TOOL_ROWS]);
    expect(turn?.text).toContain("Linux 5.15.185-tegra");
    expect(turn?.text).not.toContain("What can I help you with");
    expect(turn?.reasoning).not.toContain("a simple greeting");
  });

  it("returns null when the turn has no answer, so the caller keeps the console text", () => {
    expect(buildTurnFromRows([])).toBeNull();
    expect(buildTurnFromRows([{ id: 1, role: "user", content: "Hey" }])).toBeNull();
    // A turn cut short after the tool call and before the reply: there is no
    // answer to show, and an empty bubble is worse than the console's.
    expect(buildTurnFromRows(TOOL_ROWS.slice(0, 3))).toBeNull();
  });

  it("survives a tool_calls column it cannot parse", () => {
    const rows = structuredClone(TOOL_ROWS);
    rows[1].tool_calls = "{not json";
    const turn = buildTurnFromRows(rows);
    expect(turn?.text).toContain("Linux 5.15.185-tegra");
    expect(turn).not.toHaveProperty("toolCalls");
  });

  it("summarises multi-argument calls as compact JSON, and bounds the length", () => {
    const rows = [
      { id: 1, role: "user", content: "go" },
      {
        id: 2,
        role: "assistant",
        content: "done",
        tool_calls: JSON.stringify([
          { id: "a", type: "function", function: { name: "web", arguments: '{"q":"cats","n":3}' } },
          {
            id: "b",
            type: "function",
            function: { name: "file", arguments: JSON.stringify({ path: "x".repeat(500) }) },
          },
        ]),
      },
    ];
    const calls = buildTurnFromRows(rows)?.toolCalls ?? [];
    expect(calls[0]).toMatchObject({ name: "web", detail: '{"q":"cats","n":3}' });
    expect(calls[1].detail?.length).toBeLessThanOrEqual(160);
    expect(calls[1].detail?.endsWith("…")).toBe(true);
  });

  it("keeps a tool loop's DISTINCT thoughts but never repeats one", () => {
    const rows = [
      { id: 1, role: "user", content: "go" },
      { id: 2, role: "assistant", content: "", reasoning: "First I check.", reasoning_content: "First I check." },
      { id: 3, role: "assistant", content: "", reasoning: "First I check." },
      { id: 4, role: "assistant", content: "Done.", reasoning: "Now I answer." },
    ];
    expect(buildTurnFromRows(rows)?.reasoning).toBe("First I check.\n\nNow I answer.");
  });

  it("joins an answer the agent split across turns of one run", () => {
    const rows = [
      { id: 1, role: "user", content: "go" },
      { id: 2, role: "assistant", content: "Working on it." },
      { id: 3, role: "assistant", content: "All done." },
    ];
    expect(buildTurnFromRows(rows)?.text).toBe("Working on it.\n\nAll done.");
  });
});

/**
 * The reader against a REAL SQLite file, not a fixture array.
 *
 * `buildTurnFromRows` above proves the rules; this proves the half a unit test
 * usually cannot — that the SQL names columns this schema actually has. Those
 * names are the coupling to the agent's private store, and a test that mocked
 * them would pass forever while the feature was dead on the device.
 *
 * The schema below is `messages` as `~/.hermes/state.db` declared it on the
 * bench box (2026-08-23), trimmed to the columns this module reads.
 */
describe("readHermesTurn against a real state.db", () => {
  let home: string;
  let available = true;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-statedb-"));
    process.env.HERMES_HOME = home;
    try {
      // Variable specifier: `@types/node` here has no declaration for the
      // module, and this test is about the runtime, not the types.
      const specifier = "node:sqlite";
      const { DatabaseSync } = await import(specifier);
      const db = new DatabaseSync(path.join(home, "state.db"));
      db.exec(`CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL,
        finish_reason TEXT,
        reasoning TEXT,
        reasoning_content TEXT
      )`);
      const insert = db.prepare(
        "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name,"
        + " timestamp, finish_reason, reasoning, reasoning_content)"
        + " VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      const think = "The user wants uname. Let me run it.";
      insert.run("s1", "user", "run uname -sr", null, null, null, 1, null, null, null);
      insert.run(
        "s1", "assistant", "", null,
        JSON.stringify([{ id: "c1", type: "function", function: { name: "terminal", arguments: '{"command": "uname -sr"}' } }]),
        null, 2, "tool_calls", think, think,
      );
      insert.run(
        "s1", "tool", '{"output": "Linux 5.15.185-tegra", "exit_code": 0, "error": null}',
        "c1", null, "terminal", 3, null, null, null,
      );
      insert.run("s1", "assistant", "It printed Linux 5.15.185-tegra.", null, null, null, 4, "stop", null, null);
      // A DIFFERENT session must not leak into this one's turn.
      insert.run("s2", "user", "other", null, null, null, 5, null, null, null);
      insert.run("s2", "assistant", "other answer", null, null, null, 6, "stop", null, null);
      db.close();
    } catch {
      // Node without `node:sqlite`. The module is built to degrade on exactly
      // this, and the degradation is asserted below rather than skipped.
      available = false;
    }
  });

  afterEach(() => {
    delete process.env.HERMES_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads the turn back through the real schema", async () => {
    const turn = await readHermesTurn("s1");
    if (!available) {
      // No SQLite: the contract is null, so the route keeps its console text.
      expect(turn).toBeNull();
      return;
    }
    expect(turn?.text).toBe("It printed Linux 5.15.185-tegra.");
    expect(turn?.reasoning).toBe("The user wants uname. Let me run it.");
    expect(turn?.toolCalls).toEqual([{ name: "terminal", detail: "uname -sr", status: "ok" }]);
  });

  it("does not read another session's turn", async () => {
    const turn = await readHermesTurn("s2");
    if (!available) return;
    expect(turn?.text).toBe("other answer");
  });

  it("returns null — never throws — for a session that is not there", async () => {
    await expect(readHermesTurn("nope")).resolves.toBeNull();
  });

  it("returns null for an empty session id without touching the disk", async () => {
    await expect(readHermesTurn("")).resolves.toBeNull();
  });

  it("returns null rather than throwing when the database is missing", async () => {
    process.env.HERMES_HOME = path.join(home, "gone");
    await expect(readHermesTurn("s1")).resolves.toBeNull();
  });
});
