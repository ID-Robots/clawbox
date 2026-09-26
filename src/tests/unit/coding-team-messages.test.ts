/**
 * A coding team's runs talking while they work — the rules and the record.
 *
 *   - the pure half (src/lib/coding-team-messages.ts): the text rules the
 *     steering path already has, under a 1,500-character cap; the two caps
 *     (12 per run, 4 per 5 minutes) with the time the next may go;
 *   - the framing (src/lib/coding-run-messages.ts): a teammate's message
 *     reaches the harness as a teammate's, told not to acknowledge it, while
 *     the owner's own messages are worded exactly as before;
 *   - the board (coding-team-board.ts): a `message` entry only a run on the
 *     cast list may write, in its own name, never touching the alert count,
 *     and a board — old or new — that still loads;
 *   - the bus (coding-team-bus.ts): the shape check, a worker speaking as
 *     another run refused and logged as an alert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  MAX_TEAM_MESSAGE_CHARS,
  MAX_TEAM_MESSAGES_PER_RUN,
  MAX_TEAM_MESSAGES_PER_WINDOW,
  normalizeTeamMessage,
  ownerAgentMessage,
  rateLimitedError,
  TEAM_MESSAGE_WINDOW_MS,
  teamMessageAllowance,
  TeamMessageError,
} from "@/lib/coding-team-messages";
import { runMessagesNote, runMessageTurn, teammateOf, teammatePrefix } from "@/lib/coding-run-messages";

let root: string;
vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return { ...actual, get DATA_DIR() { return path.join(root, "data"); } };
});

let boardLib: typeof import("@/lib/coding-team-board");
let busLib: typeof import("@/lib/coding-team-bus");

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "team-messages-"));
  vi.resetModules();
  boardLib = await import("@/lib/coding-team-board");
  busLib = await import("@/lib/coding-team-bus");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const A = "run-aaaaaaaa";
const B = "run-bbbbbbbb";
const P = "run-pppppppp";
const OUTSIDER = "run-zzzzzzzz";

function refusalOf(fn: () => unknown): TeamMessageError {
  try {
    fn();
  } catch (err) {
    if (err instanceof TeamMessageError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

/** A board with a planner and two workers on its cast list. */
function teamBoard() {
  const board = boardLib.createBoard({ goal: "Build the shop", projectId: null, directory: "/home/clawbox/Projects/shop", source: "agent" }, { kind: "system" });
  board.runs.push({ id: P, role: "planner", taskId: null }, { id: A, role: "worker", taskId: "t1" }, { id: B, role: "worker", taskId: "t2" });
  return board;
}

describe("the text a run may send", () => {
  it("takes the steering path's plain text, trimmed and CRLF-folded, up to 1,500 characters", () => {
    expect(normalizeTeamMessage("  I need t2's API first\r\nplease  ")).toBe("I need t2's API first\nplease");
    expect(normalizeTeamMessage("x".repeat(MAX_TEAM_MESSAGE_CHARS))).toHaveLength(MAX_TEAM_MESSAGE_CHARS);
    expect(MAX_TEAM_MESSAGE_CHARS).toBe(1_500);
  });

  it("refuses what the steering path refuses, and anything over the cap, each with its code", () => {
    expect(refusalOf(() => normalizeTeamMessage("x".repeat(MAX_TEAM_MESSAGE_CHARS + 1))).code).toBe("TOO_LONG");
    expect(refusalOf(() => normalizeTeamMessage("x".repeat(5_000))).code).toBe("TOO_LONG");
    expect(refusalOf(() => normalizeTeamMessage("   ")).code).toBe("EMPTY");
    expect(refusalOf(() => normalizeTeamMessage(42)).code).toBe("EMPTY");
    expect(refusalOf(() => normalizeTeamMessage("ring \u0007 the bell")).code).toBe("NOT_PLAIN_TEXT");
    expect(refusalOf(() => normalizeTeamMessage("\u001b[31mred")).code).toBe("NOT_PLAIN_TEXT");
  });
});

describe("the caps", () => {
  const now = 1_800_000_000_000;

  it("allows a fresh run twelve, counting down", () => {
    expect(teamMessageAllowance([], now)).toEqual({ ok: true, left: MAX_TEAM_MESSAGES_PER_RUN });
    expect(teamMessageAllowance([now - 60_000], now)).toEqual({ ok: true, left: MAX_TEAM_MESSAGES_PER_RUN - 1 });
    expect(MAX_TEAM_MESSAGES_PER_RUN).toBe(12);
  });

  it("holds a run to four in any five minutes, and says when the next may go", () => {
    expect(MAX_TEAM_MESSAGES_PER_WINDOW).toBe(4);
    expect(TEAM_MESSAGE_WINDOW_MS).toBe(5 * 60_000);
    const sent = [now - 240_000, now - 120_000, now - 60_000, now - 1_000];
    const allowance = teamMessageAllowance(sent, now);
    expect(allowance).toEqual({ ok: false, scope: "window", nextAllowedAt: now - 240_000 + TEAM_MESSAGE_WINDOW_MS });
    // One of the four aged out of the window: the fifth may go.
    expect(teamMessageAllowance([now - 301_000, ...sent.slice(1)], now)).toMatchObject({ ok: true });
  });

  it("has no next time for a run that spent all twelve", () => {
    const sent = Array.from({ length: MAX_TEAM_MESSAGES_PER_RUN }, (_, i) => now - 3_600_000 + i * 60_000);
    const allowance = teamMessageAllowance(sent, now);
    expect(allowance).toEqual({ ok: false, scope: "run", nextAllowedAt: null });
    if (allowance.ok) throw new Error("unreachable");
    const refusal = rateLimitedError(allowance);
    expect(refusal.code).toBe("RATE_LIMITED");
    expect(refusal.nextAllowedAt).toBeNull();
    expect(refusal.message).toMatch(/12 team messages/);
  });

  it("words the window refusal with the time, as an instant", () => {
    const refusal = rateLimitedError({ ok: false, scope: "window", nextAllowedAt: now + 60_000 });
    expect(refusal).toMatchObject({ code: "RATE_LIMITED", nextAllowedAt: now + 60_000 });
    expect(refusal.message).toContain(new Date(now + 60_000).toISOString());
  });
});

describe("how a message is worded to its reader", () => {
  it("prefixes the assistant's copy with the team, the role and the run", () => {
    expect(ownerAgentMessage("team-k3x9q2ab", "worker", A, "Which database?")).toBe(`[Coding team team-k3x9q2ab · worker ${A}] Which database?`);
  });

  it("frames a teammate's message as a teammate's, never as the owner's, and says not to acknowledge it", () => {
    const text = `${teammatePrefix("worker", A)} t1's API is at /api/cart`;
    expect(teammateOf(text)).toEqual({ role: "worker", runId: A });
    const turn = runMessageTurn(text);
    expect(turn).toMatch(/a message from worker run-aaaaaaaa, another run of your coding team/);
    expect(turn).toMatch(/not from the person who started this run/);
    expect(turn).toMatch(/do not answer it just to acknowledge it/);
    expect(turn.endsWith(text)).toBe(true);
  });

  it("leaves the owner's own messages worded exactly as before", () => {
    expect(teammateOf("[from somebody] hi")).toBeNull();
    expect(runMessageTurn("use port 8080")).toBe(
      "[ClawBox: a message from the person who started this run. It is about the task you are already on — take it into account and carry on; do not start over.]\n\nuse port 8080",
    );
    expect(runMessagesNote([{ at: 1, text: "use port 8080", deliveredAt: null }])).toMatch(/^\[ClawBox: a message from the person who started this run, sent while it was working\./);
  });

  it("names both senders when a teammate's message rides out with the owner's at a boundary", () => {
    const note = runMessagesNote([
      { at: 1, text: "use port 8080", deliveredAt: null },
      { at: 2, text: `${teammatePrefix("worker", B)} done with the cart`, deliveredAt: null },
    ]);
    expect(note).toMatch(/2 messages sent while this run was working — from the person who started it, or, where a message starts \[from <role> <run>\]/);
    expect(note).toMatch(/do not answer a teammate just to acknowledge it/);
    expect(note).toContain(`2. [from worker ${B}] done with the cart`);
  });
});

describe("the board's message entry", () => {
  it("records who said what to whom, in full, stamps the sender's caps and leaves the alert count alone", () => {
    const board = teamBoard();
    const text = "The task names src/cart.ts but the folder has no src/ at all.\nShould I create it?";
    boardLib.postMessage(board, { kind: "worker", id: A }, { from_run_id: A, to: "lead", text }, 1_000);
    boardLib.postMessage(board, { kind: "worker", id: A }, { from_run_id: A, to: "sibling", to_run_id: B, text: "t1 needs your cart API" }, 2_000);
    boardLib.postMessage(board, { kind: "planner" }, { from_run_id: P, to: "owner_agent", text: "Which payment provider?", undelivered: "NO_SESSION" }, 3_000);
    const entries = board.log.filter((e) => e.type === "message");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ actor: { kind: "worker", id: A }, task_id: "t1", message: `worker ${A} → the lead: The task names src/cart.ts but the folder has no src/ at all.`, payload: { from: A, to: "lead", text } });
    expect(entries[1].payload).toEqual({ from: A, to: "sibling", toRunId: B, text: "t1 needs your cart API" });
    expect(entries[2]).toMatchObject({ message: `planner ${P} → the assistant (not delivered: NO_SESSION): Which payment provider?`, payload: { delivered: false, code: "NO_SESSION" } });
    expect(board.runs.find((r) => r.id === A)?.sentAt).toEqual([1_000, 2_000]);
    expect(board.runs.find((r) => r.id === P)?.sentAt).toEqual([3_000]);
    expect(board.alerts).toBe(0);
  });

  it("is written only by a run on the cast list, in its own name and role", () => {
    const board = teamBoard();
    const say = (actor: Parameters<typeof boardLib.postMessage>[1], from: string) => () => boardLib.postMessage(board, actor, { from_run_id: from, to: "lead", text: "hi" });
    expect(say({ kind: "worker", id: A }, B)).toThrow(boardLib.BoardAccessError);
    expect(say({ kind: "worker", id: OUTSIDER }, OUTSIDER)).toThrow(boardLib.BoardAccessError);
    expect(say({ kind: "reviewer" }, A)).toThrow(boardLib.BoardAccessError);
    expect(say({ kind: "planner" }, A)).toThrow(boardLib.BoardAccessError);
    expect(say({ kind: "system" }, A)).toThrow(boardLib.BoardAccessError);
    expect(say({ kind: "owner" }, A)).toThrow(boardLib.BoardAccessError);
    expect(board.log.some((e) => e.type === "message")).toBe(false);
  });

  it("refuses a sibling outside the team, a message to itself, and one over the caps", () => {
    const board = teamBoard();
    const me = { kind: "worker", id: A } as const;
    expect(() => boardLib.postMessage(board, me, { from_run_id: A, to: "sibling", to_run_id: OUTSIDER, text: "hi" })).toThrow(/not a run of this team/);
    expect(() => boardLib.postMessage(board, me, { from_run_id: A, to: "sibling", to_run_id: A, text: "hi" })).toThrow(/itself/);
    for (let i = 0; i < MAX_TEAM_MESSAGES_PER_WINDOW; i++) boardLib.postMessage(board, me, { from_run_id: A, to: "lead", text: `note ${i}` }, 10_000 + i);
    expect(() => boardLib.postMessage(board, me, { from_run_id: A, to: "lead", text: "one more" }, 10_010)).toThrow(/no team message left in this window/);
    expect(() => boardLib.postMessage(board, me, { from_run_id: A, to: "lead", text: "x".repeat(MAX_TEAM_MESSAGE_CHARS + 1) }, 10_000 + TEAM_MESSAGE_WINDOW_MS * 2)).toThrow(/at most 1500/);
  });

  it("round-trips through the file, and an old board without sentAt or messages still loads", () => {
    const board = teamBoard();
    boardLib.postMessage(board, { kind: "worker", id: A }, { from_run_id: A, to: "sibling", to_run_id: B, text: "your turn" }, 5_000);
    boardLib.saveBoard(board);
    const loaded = boardLib.loadBoard(board.id);
    expect(loaded?.log.at(-1)).toMatchObject({ type: "message", payload: { from: A, to: "sibling", toRunId: B, text: "your turn" } });
    expect(loaded?.runs.find((r) => r.id === A)?.sentAt).toEqual([5_000]);
    expect(loaded?.runs.find((r) => r.id === B)).toEqual({ id: B, role: "worker", taskId: "t2" });

    // A board written before messages existed: no sentAt anywhere, no such entry.
    const file = path.join(root, "data", "coding-team", `${board.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.runs = raw.runs.map((r: Record<string, unknown>) => ({ id: r.id, role: r.role, taskId: r.taskId }));
    raw.log = raw.log.filter((e: { type: string }) => e.type !== "message");
    fs.writeFileSync(file, JSON.stringify(raw));
    const old = boardLib.loadBoard(board.id);
    expect(old).not.toBeNull();
    expect(old?.runs.every((r) => r.sentAt === undefined)).toBe(true);
  });

  it("keeps a message entry whose payload is not a message as a line, without the payload", () => {
    const board = teamBoard();
    boardLib.postMessage(board, { kind: "worker", id: A }, { from_run_id: A, to: "lead", text: "hi" }, 5_000);
    boardLib.saveBoard(board);
    const file = path.join(root, "data", "coding-team", `${board.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const entry = raw.log.find((e: { type: string }) => e.type === "message");
    entry.payload = { from: A, to: "everyone", text: "<script>" };
    raw.runs[1].sentAt = ["soon", 5_000];
    fs.writeFileSync(file, JSON.stringify(raw));
    const loaded = boardLib.loadBoard(board.id);
    const kept = loaded?.log.find((e) => e.type === "message");
    expect(kept?.message).toBe(`worker ${A} → the lead: hi`);
    expect(kept?.payload).toBeUndefined();
    expect(loaded?.runs.find((r) => r.id === A)?.sentAt).toEqual([5_000]);
  });
});

describe("the bus", () => {
  it("names what is wrong with a malformed team message", () => {
    const { validateMessage } = busLib;
    expect(validateMessage({ type: "message", from_run_id: "nope", to: "lead", text: "x" })).toMatch(/from_run_id/);
    expect(validateMessage({ type: "message", from_run_id: A, to: "everyone", text: "x" })).toMatch(/sibling, lead, owner_agent/);
    expect(validateMessage({ type: "message", from_run_id: A, to: "sibling", text: "x" })).toMatch(/to_run_id/);
    expect(validateMessage({ type: "message", from_run_id: A, to: "lead", text: " " })).toMatch(/needs text/);
    expect(validateMessage({ type: "message", from_run_id: A, to: "lead", text: "x".repeat(MAX_TEAM_MESSAGE_CHARS + 1) })).toMatch(/at most/);
    expect(validateMessage({ type: "message", from_run_id: A, to: "sibling", to_run_id: B, text: "x" })).toBeNull();
  });

  it("delivers an accepted message, persisted, and refuses a worker speaking as another run — as an alert", () => {
    const board = teamBoard();
    const bus = new busLib.TeamBus(board);
    const heard: string[] = [];
    bus.subscribe((d) => heard.push(d.message.type));
    bus.send({ kind: "worker", id: A }, { type: "message", from_run_id: A, to: "lead", text: "blocked on t2" });
    expect(heard).toEqual(["message"]);
    expect(boardLib.loadBoard(board.id)?.log.at(-1)).toMatchObject({ type: "message", payload: { from: A, text: "blocked on t2" } });
    expect(board.alerts).toBe(0);

    expect(() => bus.send({ kind: "worker", id: A }, { type: "message", from_run_id: B, to: "lead", text: "I am B" })).toThrow(boardLib.BoardAccessError);
    expect(board.alerts).toBe(1);
    expect(board.log.at(-1)?.message).toMatch(new RegExp(`Refused message from worker ${A}: worker ${A} sent a team message as ${B}`));
    expect(heard).toEqual(["message"]);
  });

  it("logs a refusal the orchestrator makes on grounds of its own the same way", () => {
    const board = teamBoard();
    const bus = new busLib.TeamBus(board);
    expect(() => bus.refuse({ kind: "worker", id: A }, { type: "message", from_run_id: A, to: "sibling", to_run_id: B, text: "hi" }, `SETTLED: ${B} has finished`)).toThrow(boardLib.BoardAccessError);
    expect(board.alerts).toBe(1);
    expect(boardLib.loadBoard(board.id)?.log.at(-1)?.message).toBe(`ALERT: Refused message from worker ${A}: SETTLED: ${B} has finished`);
  });

  it("logs a message to a sibling that had already finished as a NOTE with the same words — refused, counted undelivered, never an alert", () => {
    const board = teamBoard();
    const bus = new busLib.TeamBus(board);
    const heard: string[] = [];
    bus.subscribe((d) => heard.push(d.message.type));
    const reason = `SETTLED: ${B} has finished; there is nothing left to tell it.`;
    expect(() => bus.refuse({ kind: "worker", id: A }, { type: "message", from_run_id: A, to: "sibling", to_run_id: B, text: "total() returns cents" }, reason, "SETTLED")).toThrow(boardLib.BoardAccessError);
    expect(board.alerts).toBe(0);
    expect(board.log.filter((e) => e.type === "alert")).toHaveLength(0);
    expect(board.log.at(-1)).toMatchObject({
      type: "note",
      actor: { kind: "system" },
      message: `Refused message from worker ${A}: ${reason}`,
      payload: { undelivered: { code: "SETTLED", from: A, role: "worker", to: "sibling", toRunId: B } },
    });
    // The words were never read by anybody: not kept. The attempt is on the sender's caps, as an undelivered message is.
    expect(JSON.stringify(board.log.at(-1))).not.toContain("total() returns cents");
    expect(board.runs.find((r) => r.id === A)?.sentAt).toEqual([expect.any(Number)]);
    expect(heard).toEqual([]);
    // Persisted, and counted again from the file.
    const loaded = boardLib.loadBoard(board.id)!;
    expect(loaded.alerts).toBe(0);
    expect(loaded.metrics).toMatchObject({ messagesSent: 1, messagesToSibling: 1, messagesToLead: 0, messagesUndelivered: 1 });
    // A note, so not quoted to a teammate as one of the team's alerts.
    expect(boardLib.boardDigest(loaded, null)).not.toContain("Refused message");
  });

  it("keeps every other refusal an alert, whatever code it carries — and a malformed message an alert even when the code is SETTLED", () => {
    const board = teamBoard();
    const bus = new busLib.TeamBus(board);
    const refuse = (message: Parameters<typeof bus.refuse>[1], reason: string, code: Parameters<typeof bus.refuse>[3]) => {
      expect(() => bus.refuse({ kind: "worker", id: A }, message, reason, code)).toThrow(boardLib.BoardAccessError);
    };
    refuse({ type: "message", from_run_id: A, to: "sibling", to_run_id: OUTSIDER, text: "hi" }, `NOT_IN_TEAM: ${OUTSIDER} is not a run of this team.`, "NOT_IN_TEAM");
    refuse({ type: "message", from_run_id: A, to: "sibling", to_run_id: B, text: "hi" }, "QUEUE_FULL: full", "QUEUE_FULL");
    refuse({ type: "message", from_run_id: A, to: "lead", text: "hi" }, "RATE_LIMITED: later", "RATE_LIMITED");
    refuse({ type: "message", from_run_id: A, to: "sibling", to_run_id: B, text: "  " }, "SETTLED: gone", "SETTLED");
    refuse({ type: "message", from_run_id: "nope", to: "sibling", to_run_id: B, text: "hi" }, "SETTLED: gone", "SETTLED");
    // A worker speaking as another run is the alert it always was, whatever the code.
    refuse({ type: "message", from_run_id: P, to: "sibling", to_run_id: B, text: "hi" }, "SETTLED: gone", "SETTLED");
    expect(board.alerts).toBe(6);
    expect(board.log.filter((e) => e.type === "note")).toHaveLength(0);
    expect(boardLib.teamMetrics(board)).toMatchObject({ messagesSent: 0, messagesUndelivered: 0 });
    expect(board.log.at(-6)?.message).toBe(`ALERT: Refused message from worker ${A}: NOT_IN_TEAM: ${OUTSIDER} is not a run of this team.`);
  });
});
