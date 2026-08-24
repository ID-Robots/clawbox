// ── What the agent actually thought, did, and said — from its own record ─────
//
// SERVER ONLY.
//
// THE PROBLEM THIS SOLVES. `hermes chat -q … -Q` is captured by the chat route
// as one stdout blob, and that blob is not a clean answer. On the bench box
// (2026-08-23, deepseek-v4-flash via the clawai provider) a bare "Hey" printed:
//
//   ┌─ Reasoning ──────────────────────────────────────────────────────────┐
//   The user just said "Hey" - a simple greeting. I should respond warmly and
//   , maybe mention I'm ready to help. No need for tools here. …
//    naturally and concisely, in plain text since this is CLI.The user just
//   said "Hey" - a simple greeting. … in plain text since this is CLI.
//   Hey! What can I help you with today?
//
// — the monologue TWICE, an opening frame with NO closing frame, and the answer
// on the end. Two independent producers feed the CLI's reasoning printer
// (`_stream_reasoning_delta`, cli.py:7658 @ fcbd1076a): the provider's native
// reasoning stream, wired in at cli.py:7505, arrives token by token and is
// flushed in ~80-character fragments (cli.py:7690 — the model's monologue has
// no newlines, so the length-based flush is the only thing that fires); and the
// inline `<think>`-family tag filter hands the same text over in ONE call
// (cli.py:7838). `_close_reasoning_box` (cli.py:7694) — the only thing that
// prints the closing frame — runs off `_emit_stream_text`, which the quiet path
// never reaches, so the box is left open and the answer follows it unmarked.
//
// There is no marker in that stream that separates monologue from answer, and
// `-Q` prints no tool activity at all. Scraping it can only ever guess.
//
// THE AGENT ALREADY HAS THE ANSWER, SEPARATED. Every turn is written to
// `~/.hermes/state.db`, whose `messages` table carries `content`, `reasoning`,
// `reasoning_content`, `tool_calls`, `tool_name` and `tool_call_id` as distinct
// columns. The same "Hey" turn above is stored as one assistant row with
// `content` = "Hey! What can I help you with today?" and the monologue in
// `reasoning_content` — once, not twice. A tool turn stores the call as JSON on
// the assistant row and its result as a following `role='tool'` row.
//
// So this module reads the turn back from the agent's own record instead of
// parsing the CLI's console output.
//
// WHY THIS IS NOT THE THING `transcript-store.ts` REFUSES TO DO. That module
// declines to read this DB for the REPLAY LOG, and it is right to: replay is a
// per-screen read, it would spawn work on every refresh, and it would put a
// private schema behind the customer's history forever. This is a different
// job. It runs ONCE, on a turn we just ran, for a session id the route already
// holds — and its output is copied into the transcript, which stays the only
// thing replay reads. Nothing here decides what the agent knows, and nothing
// here is on the path of a page load.
//
// AND IT IS NEVER LOAD-BEARING. Every failure — no `node:sqlite`, no database,
// a renamed column, a session that is not there yet — returns null, and the
// route falls back to the console text it has always used. A box whose agent
// schema moves under us loses the reasoning panel and the tool chips. It does
// not lose the reply.

import path from "path";

/** One tool the agent invoked during a turn. */
export interface HermesToolCall {
  /** The tool's own name, e.g. "terminal", "web_search". */
  name: string;
  /** A short, bounded summary of the arguments — what the step was about. */
  detail?: string;
  /** Whether the call came back clean. Absent when no result was recorded. */
  status?: "ok" | "error";
}

/** A turn, with the three things the console blob runs together. */
export interface HermesTurnRecord {
  /** The reply, and only the reply. */
  text: string;
  /** The model's monologue, stored once however many ways it was printed. */
  reasoning?: string;
  /** The tools it used, in call order. */
  toolCalls?: HermesToolCall[];
}

/**
 * The agent's home, by the same rule every other module in this repo uses.
 * `HERMES_HOME` wins so a test can point this somewhere harmless.
 */
function hermesHome(): string {
  return process.env.HERMES_HOME || path.join(process.env.HOME || "/home/clawbox", ".hermes");
}

function statePath(): string {
  return path.join(hermesHome(), "state.db");
}

/**
 * Caps. A bubble shows a reply, not a book, and these values reach the browser.
 * The transcript clamps again on the way to disk; this clamps at the source so
 * an enormous monologue never becomes an enormous JSON response either.
 */
const MAX_REASONING_CHARS = 32_000;
const MAX_TOOL_CALLS = 24;
const MAX_DETAIL_CHARS = 160;

/** Columns we read. Anything missing degrades to "not available", never a throw. */
interface MessageRow {
  id?: number;
  role?: string;
  content?: string | null;
  tool_calls?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A tool call's arguments, shortened to something a chip can carry.
 *
 * The arguments are a JSON string on the wire. A single-valued call ("command":
 * "uname -sr") reads best as just that value, which is what a person recognises
 * the step by; anything richer falls back to the compact JSON. Bounded either
 * way — these are model-authored and can be arbitrarily long.
 */
function summariseArguments(raw: unknown): string | undefined {
  const source = text(raw).trim();
  if (!source) return undefined;
  let detail = source;
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, unknown>);
      detail = values.length === 1 && typeof values[0] === "string"
        ? values[0]
        : JSON.stringify(parsed);
    }
  } catch {
    // Not JSON. Show it as it came.
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…` : detail;
}

/**
 * Did this tool result report a failure?
 *
 * The payload is the tool's own JSON and its shape is the tool's business, so
 * this only claims "error" on signals that are unambiguous — a non-empty
 * `error` or a non-zero `exit_code`. Anything else is reported as "ok" rather
 * than guessed at: a chip that cries failure on a healthy call is worse than a
 * chip that stays quiet.
 */
function resultStatus(content: string): "ok" | "error" {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      const row = parsed as Record<string, unknown>;
      if (row.error !== undefined && row.error !== null && row.error !== "") return "error";
      if (typeof row.exit_code === "number" && row.exit_code !== 0) return "error";
    }
  } catch {
    // Not JSON — a plain-text result carries no failure signal we can trust.
  }
  return "ok";
}

/**
 * Turn the rows of ONE turn into the three fields the chat surface wants.
 *
 * Exported for its own test: the parsing is the part with rules in it, and a
 * test for it should not need a SQLite file to say what it means.
 *
 * `rows` must be the messages of a single session in id order.
 */
export function buildTurnFromRows(rows: MessageRow[]): HermesTurnRecord | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // The turn is everything after the last thing the customer said. Resuming a
  // session replays the whole conversation into this table, and only the tail
  // belongs to the run that just finished.
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }
  const turn = rows.slice(start);
  if (turn.length === 0) return null;

  // A tool result is matched to its call by id, so a chip can say whether the
  // step worked without assuming the rows are adjacent.
  const statusByCallId = new Map<string, "ok" | "error">();
  for (const row of turn) {
    if (row?.role !== "tool") continue;
    const id = text(row.tool_call_id);
    if (id) statusByCallId.set(id, resultStatus(text(row.content)));
  }

  const answers: string[] = [];
  const reasonings: string[] = [];
  const toolCalls: HermesToolCall[] = [];

  for (const row of turn) {
    if (row?.role !== "assistant") continue;

    const body = text(row.content).trim();
    if (body) answers.push(body);

    // `reasoning` and `reasoning_content` hold the SAME monologue when both are
    // set — that is the duplication, at its source. One row contributes one
    // block, and an identical block is never added twice, so a tool loop that
    // repeats its thinking verbatim still reads as one passage.
    const thought = (text(row.reasoning_content) || text(row.reasoning)).trim();
    if (thought && !reasonings.includes(thought)) reasonings.push(thought);

    const rawCalls = text(row.tool_calls).trim();
    if (!rawCalls) continue;
    try {
      const parsed = JSON.parse(rawCalls);
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const call = entry as Record<string, unknown>;
        const fn = (call.function ?? {}) as Record<string, unknown>;
        const name = text(fn.name) || text(call.name);
        if (!name) continue;
        const callId = text(call.id) || text(call.call_id);
        const detail = summariseArguments(fn.arguments);
        const status = callId ? statusByCallId.get(callId) : undefined;
        toolCalls.push({
          name,
          ...(detail ? { detail } : {}),
          ...(status ? { status } : {}),
        });
      }
    } catch {
      // A tool_calls column we cannot parse costs the chips for this turn only.
    }
  }

  const answer = answers.join("\n\n").trim();
  // No answer means this is not a turn we can speak for — the caller keeps the
  // console text rather than replacing a real reply with an empty one.
  if (!answer) return null;

  const reasoning = reasonings.join("\n\n").trim();
  return {
    text: answer,
    ...(reasoning
      ? {
        reasoning: reasoning.length > MAX_REASONING_CHARS
          ? reasoning.slice(0, MAX_REASONING_CHARS)
          : reasoning,
      }
      : {}),
    ...(toolCalls.length ? { toolCalls: toolCalls.slice(0, MAX_TOOL_CALLS) } : {}),
  };
}

/** The shape of the `node:sqlite` handle we use, kept local to avoid a dep. */
interface ReadOnlyDb {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
  close: () => void;
}

/**
 * The turn the agent just finished, read back from its own store.
 *
 * Returns null whenever the record cannot be had for ANY reason — that is the
 * contract, and the caller's fallback is the console text it already captured.
 * Nothing in here is allowed to throw into a request that has a good reply in
 * its hand.
 */
export async function readHermesTurn(sessionId: string): Promise<HermesTurnRecord | null> {
  if (!sessionId) return null;
  let db: ReadOnlyDb | null = null;
  try {
    // `node:sqlite` is a Node 22.5+ builtin and still flagged experimental, so
    // it is imported at CALL time inside the guard: an older runtime must lose
    // the panel, not fail this module's import and take the chat route with it.
    //
    // The specifier is a VARIABLE on purpose. `@types/node` at the version this
    // project pins has no declaration for the module, so a literal import is a
    // compile error for something that is legitimately resolved at runtime —
    // and the guard above is what makes its absence safe either way.
    const specifier = "node:sqlite";
    const sqlite = await import(/* webpackIgnore: true */ specifier);
    const DatabaseSync = (sqlite as unknown as {
      DatabaseSync?: new (file: string, options?: { readOnly?: boolean }) => ReadOnlyDb;
    }).DatabaseSync;
    if (!DatabaseSync) return null;
    // READ-ONLY, always. This file is the agent's memory; the UI is a reader of
    // it and must never be able to become a writer by accident.
    db = new DatabaseSync(statePath(), { readOnly: true });
    const rows = db
      .prepare(
        "SELECT id, role, content, tool_calls, tool_call_id, tool_name, reasoning, reasoning_content"
        + " FROM messages WHERE session_id = ? ORDER BY id",
      )
      .all(sessionId) as MessageRow[];
    return buildTurnFromRows(rows);
  } catch (err) {
    // Name the failure, never the contents: this journal line is the one part
    // of the pipeline that leaves the box, and the turn is the customer's.
    console.warn(
      "[hermes/turn] could not read the agent's record:",
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing left to do about a handle that will be collected anyway.
    }
  }
}
