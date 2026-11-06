/**
 * The coding starts on their way: a run from the moment its request reaches
 * the box until its record is written, and any run or team the box refused
 * to start — so a card can say "Starting…" within a poll of the ask, and say
 * why when nothing will come of it (src/lib/coding-start-phase.ts has the
 * owner's report this answers).
 *
 * In memory, per process (process-store.ts says why not module state): a
 * start lives for seconds and a restart ends every start in flight anyway.
 * The runs list (GET /setup-api/coding-agent/runs) carries these as
 * `starting`, beside the records, never mixed into them: nothing that counts
 * runs — the parallel limit, the queue, the MCP list — can mistake one for a
 * run that exists.
 */

import { processStore } from "./process-store";
import { RUN_START_STEPS, type CodingStartKind, type CodingStartView, type RunStartStep } from "./coding-start-phase";

/** How long a start that failed stays listed: long enough for the chat to show why, short of history. */
export const FAILED_START_TTL_MS = 10 * 60_000;
/**
 * A start still "on its way" after this long has lost its caller (a throw no
 * path ended, a request the server dropped): it is listed no more. Every git
 * step under a start is capped at a minute, and a start runs a handful.
 */
export const STALE_START_MS = 10 * 60_000;
/** Starts listed at most, newest kept. */
const MAX_STARTS = 20;
/** A task or goal on the list: its first characters are what a card's title shows. */
const MAX_TASK_CHARS = 500;
/** A reason on the list: its first line, this long. */
const MAX_REASON_CHARS = 240;

const store = processStore("coding-agent:run-starts", () => ({ starts: new Map<string, CodingStartView>() }));

/** The first non-empty line of a reason, cut to a card's width. */
function reasonLine(reason: string): string {
  const line = reason.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…` : line;
}

function prune(now: number): void {
  for (const [id, start] of store.starts) {
    const gone = start.failedAt !== null
      ? now - start.failedAt > FAILED_START_TTL_MS
      : now - start.requestedAt > STALE_START_MS;
    if (gone) store.starts.delete(id);
  }
  // Oldest first in a Map's order; drop from the front past the cap.
  while (store.starts.size > MAX_STARTS) {
    const oldest = store.starts.keys().next().value;
    if (oldest === undefined) break;
    store.starts.delete(oldest);
  }
}

/** A start is on its way: listed at once, at its first step. */
export function beginCodingStart(fields: {
  id: string;
  kind?: CodingStartKind;
  task: string;
  projectId?: string | null;
  directory?: string | null;
  source: "owner" | "agent";
  now?: number;
}): void {
  const now = fields.now ?? Date.now();
  store.starts.delete(fields.id);
  store.starts.set(fields.id, {
    id: fields.id,
    kind: fields.kind ?? "run",
    task: fields.task.trim().slice(0, MAX_TASK_CHARS),
    projectId: fields.projectId ?? null,
    directory: fields.directory ?? null,
    source: fields.source,
    requestedAt: now,
    step: RUN_START_STEPS[0],
    error: null,
    failedAt: null,
  });
  prune(now);
}

/** The start moved on. Forward only, and never for one that already failed or ended. */
export function stepCodingStart(id: string, step: RunStartStep): void {
  const start = store.starts.get(id);
  if (!start || start.failedAt !== null) return;
  if (RUN_START_STEPS.indexOf(step) <= RUN_START_STEPS.indexOf(start.step)) return;
  store.starts.set(id, { ...start, step });
}

/** The record landed (or the run was queued, which writes one): the list hands over to it. */
export function endCodingStart(id: string): void {
  const start = store.starts.get(id);
  if (start && start.failedAt === null) store.starts.delete(id);
}

/**
 * It will not start: listed with the reason for FAILED_START_TTL_MS. A start
 * never announced (a team's refusal) is listed here for the first time.
 */
export function failCodingStart(id: string, reason: string, fields?: Omit<Parameters<typeof beginCodingStart>[0], "id">): void {
  const now = fields?.now ?? Date.now();
  if (!store.starts.has(id)) {
    if (!fields) return;
    beginCodingStart({ ...fields, id, now });
  }
  const start = store.starts.get(id);
  if (!start) return;
  store.starts.set(id, { ...start, error: reasonLine(reason) || "Could not start.", failedAt: now });
  prune(now);
}

/** Every start on its way and every recent failure, newest first — copies, for the wire. */
export function listCodingStarts(now = Date.now()): CodingStartView[] {
  prune(now);
  return [...store.starts.values()].map((s) => ({ ...s })).sort((a, b) => b.requestedAt - a.requestedAt);
}

/** Tests only: forget every start. */
export function resetCodingStartsForTests(): void {
  store.starts.clear();
}
