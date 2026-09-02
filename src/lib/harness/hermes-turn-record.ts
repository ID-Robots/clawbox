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
  /**
   * Absolute paths of pictures the agent DREW during this turn.
   *
   * Nothing else can find them. Hermes' image backends save into
   * `$HERMES_HOME/cache/images/` and the tool answers the model with the path;
   * the model then writes a reply ABOUT the file in prose, which is what the
   * customer sees — a sentence naming a path the browser cannot open. There is
   * no `MEDIA:` directive on this harness (that is an OpenClaw convention), so
   * the only structured record of what was drawn is the tool result row, and
   * this is where it is read out of.
   */
  generatedImages?: string[];
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
/**
 * Pictures kept from one turn. An agent asked for "four variations" makes four;
 * a runaway loop makes as many as it has time for, and every one of them is
 * about to be COPIED into the chat media tree, so the cap is a disk bound as
 * much as a display one.
 */
const MAX_GENERATED_IMAGES = 4;

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
 * The picture an image tool says it produced, or null.
 *
 * Read from the TOOL RESULT row rather than from the reply text, because the
 * reply text is prose: the model paraphrases the path, wraps it in backticks,
 * or mentions it twice. The result row is the tool's own JSON —
 * `{"success": true, "image": "/home/clawbox/.hermes/cache/images/…png", …}`,
 * captured verbatim from the live box (2026-08-24, session
 * `20260824_212159_ecf214`, row 599).
 *
 * `success` must be literally true. A failed generation still writes a row, and
 * its `image` is null — but a backend that reported an error and a path anyway
 * would otherwise have that path adopted and rendered as a picture of nothing.
 *
 * Matched on the RESULT SHAPE and not on a tool-name allowlist: every Hermes
 * image backend answers through the one `image_generate` tool, but a skill or a
 * future tool that returns the same `{success, image}` contract is making a
 * picture too, and hardcoding names here would drop it silently. The path is
 * validated by the adopter before anything opens it.
 */
function generatedImagePath(content: string): string | null {
  const source = content.trim();
  // Cheap bail-out: the overwhelming majority of tool results are not images,
  // and JSON.parse on a 100 KB terminal capture is not free on a Jetson.
  if (!source.startsWith("{") || !source.includes('"image"')) return null;
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Record<string, unknown>;
    if (row.success !== true) return null;
    const image = typeof row.image === "string" ? row.image.trim() : "";
    return image || null;
  } catch {
    return null;
  }
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
  const generatedImages: string[] = [];
  for (const row of turn) {
    if (row?.role !== "tool") continue;
    const id = text(row.tool_call_id);
    const content = text(row.content);
    if (id) statusByCallId.set(id, resultStatus(content));
    const image = generatedImagePath(content);
    // De-duplicated: a resumed session replays rows, and one file rendered
    // twice in a bubble is a bug the customer sees.
    if (image && !generatedImages.includes(image)) generatedImages.push(image);
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
  //
  // A DRAWN PICTURE IS NOT AN EXCEPTION TO THAT, deliberately. Every image turn
  // observed on the box ends with the model saying something about the file it
  // just made, so an empty answer here means the record could not be read at
  // all — and inventing a picture-only record from a half-read turn would put a
  // bubble on screen that the console fallback then duplicates.
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
    ...(generatedImages.length
      ? { generatedImages: generatedImages.slice(0, MAX_GENERATED_IMAGES) }
      : {}),
  };
}

/**
 * One `session_model_usage` row, trimmed to the columns this module reads.
 *
 * `api_call_count` and `last_seen` are read only to tell a row apart from
 * ITSELF one turn earlier — see `usageMark`. Nothing here interprets either as
 * a time or a quantity, so neither the clock nor the units have to be known.
 */
export interface UsageRow {
  model?: string | null;
  billing_provider?: string | null;
  api_call_count?: number | null;
  last_seen?: unknown;
}

/**
 * A row's identity AND its version, in one string.
 *
 * The whole billing question is "which of these rows did the turn that just ran
 * write?", and `session_model_usage` cannot be asked that directly: a row
 * AGGREGATES a session's calls for its key, so `last_seen` says when that
 * combination last billed, never which turn it billed for. Comparing it against
 * a clock this process holds would also mean knowing its epoch and units, which
 * nothing here does.
 *
 * So the rows are compared against THEMSELVES instead: snapshot the session's
 * marks before the turn, read them again after, and a mark that was not there
 * before belongs to a row the turn either created or billed against again. No
 * absolute time, no unit, no epoch — only "did this change".
 */
export function usageMark(row: UsageRow): string {
  return [
    typeof row?.model === "string" ? row.model : "",
    typeof row?.billing_provider === "string" ? row.billing_provider : "",
    typeof row?.api_call_count === "number" ? String(row.api_call_count) : "",
    row?.last_seen === null || row?.last_seen === undefined ? "" : String(row.last_seen),
  ].join(" ");
}

/**
 * Which provider the rows THIS TURN touched can be said to name — or nothing.
 *
 * Exported for its own test: the rule is the part with a decision in it, and a
 * test for it should not need a SQLite file to say what it means.
 *
 * `before` is the session's marks as they stood when the turn was submitted. A
 * row still carrying one of them was not written by this turn and cannot speak
 * for it — that is what stops an earlier turn's provider from labelling this
 * bubble when the conversation moved to another provider serving the same model
 * id, and it also turns "the row has not landed yet" into a blank rather than a
 * stale answer.
 *
 * Then ONE provider or none. `session_model_usage` is keyed on (session, model,
 * provider, base_url, mode, task), so several rows can be touched by one turn —
 * several tasks under one provider, which is the ordinary case and answers
 * cleanly, or two providers, which nothing here can resolve. Unknown beats
 * wrong, the rule this whole path follows.
 */
export function pickBillingProvider(rows: UsageRow[], before: ReadonlySet<string>): string {
  if (!Array.isArray(rows)) return "";
  const named = new Set(
    rows
      .filter((row) => !before.has(usageMark(row)))
      .map((row) => (typeof row?.billing_provider === "string" ? row.billing_provider.trim() : ""))
      .filter(Boolean),
  );
  return named.size === 1 ? [...named][0] : "";
}

/** The shape of the `node:sqlite` handle we use, kept local to avoid a dep. */
interface ReadOnlyDb {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
  close: () => void;
}

/**
 * Open `state.db` read-only, hand it to `read`, and give `fallback` back for
 * ANY failure at all — no database, no `node:sqlite`, a table or column that
 * moved. That is the contract every caller here relies on: nothing in this
 * module is allowed to throw into a request that has a good reply in its hand.
 */
async function withStateDb<T>(
  /** What was being read, for the journal line. Never the contents. */
  what: string,
  fallback: T,
  /**
   * MUST be synchronous. The handle is closed in the `finally` below, so an
   * `async` reader would be handed a closed database. `fallback` pins `T`, so
   * writing one is a compile error rather than a use-after-close.
   */
  read: (db: ReadOnlyDb) => T,
): Promise<T> {
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
    if (!DatabaseSync) return fallback;
    // READ-ONLY, always. This file is the agent's memory; the UI is a reader of
    // it and must never be able to become a writer by accident.
    db = new DatabaseSync(statePath(), { readOnly: true });
    return read(db);
  } catch (err) {
    // Name the failure, never the contents: this journal line is the one part
    // of the pipeline that leaves the box, and the turn is the customer's.
    console.warn(
      `[hermes/turn] could not read ${what}:`,
      err instanceof Error ? err.message : "unknown error",
    );
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing left to do about a handle that will be collected anyway.
    }
  }
}

/**
 * The turn the agent just finished, read back from its own store.
 *
 * Returns null whenever the record cannot be had for ANY reason — that is the
 * contract, and the caller's fallback is the console text it already captured.
 */
export async function readHermesTurn(sessionId: string): Promise<HermesTurnRecord | null> {
  if (!sessionId) return null;
  return withStateDb<HermesTurnRecord | null>("the agent's record", null, (db) => {
    const rows = db
      .prepare(
        "SELECT id, role, content, tool_calls, tool_call_id, tool_name, reasoning, reasoning_content"
        + " FROM messages WHERE session_id = ? ORDER BY id",
      )
      .all(sessionId) as MessageRow[];
    return buildTurnFromRows(rows);
  });
}

/** The four columns both billing reads select, so their marks are comparable. */
const USAGE_COLUMNS = "model, billing_provider, api_call_count, last_seen";

/**
 * The session's billing rows as they stand right now, as marks.
 *
 * Taken BEFORE a turn runs, so that afterwards the rows it wrote can be told
 * from the ones it did not. Returns null — never an empty set — when the store
 * could not be read at all, because "no baseline" and "no rows yet" are
 * different facts and only the second one is safe to answer from.
 */
export async function readHermesUsageMarks(sessionId: string): Promise<Set<string> | null> {
  if (!sessionId) return null;
  return withStateDb<Set<string> | null>("the agent's billing record", null, (db) => {
    const rows = db
      .prepare(`SELECT ${USAGE_COLUMNS} FROM session_model_usage WHERE session_id = ?`)
      .all(sessionId) as UsageRow[];
    return new Set(rows.map(usageMark));
  });
}

/**
 * Who Hermes says it BILLED for the turn that just ran — the harness's own
 * answer to "who served that reply", read from its own store.
 *
 * `messages` cannot answer it: its columns are the turn's content, and there is
 * no model or provider among them (checked on the box with
 * `PRAGMA table_info(messages)`). `sessions` carries `model` and
 * `billing_provider`, but only the LAST ones the thread used, so a conversation
 * that switched models would relabel its older bubbles — the exact defect the
 * served-model work exists to prevent. `session_model_usage` is the surface
 * that fits: keyed per (session, model), carrying the provider that actually
 * billed. It is read here keyed on BOTH, so a row belonging to another model in
 * the same conversation cannot speak for this one, and narrowed by `before` to
 * the rows this turn actually wrote.
 *
 * Returns "" for anything less than a single unambiguous answer.
 */
export async function readHermesBillingProvider(
  sessionId: string,
  model: string,
  /** `readHermesUsageMarks` from before the turn — see `pickBillingProvider`. */
  before: ReadonlySet<string>,
): Promise<string> {
  if (!sessionId || !model) return "";
  return withStateDb("the agent's billing record", "", (db) => {
    const rows = db
      .prepare(`SELECT ${USAGE_COLUMNS} FROM session_model_usage WHERE session_id = ? AND model = ?`)
      .all(sessionId, model) as UsageRow[];
    return pickBillingProvider(rows, before);
  });
}
