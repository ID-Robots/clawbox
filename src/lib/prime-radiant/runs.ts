/**
 * The `runs` table — one row per nightly pass — and the cost summary the
 * Costs view reads (`costs` rows of every kind of run: nightly passes, ingest
 * jobs, the contradiction judge, the Opus tier).
 *
 * Every figure is an ESTIMATE (see cost-rates.ts). Reads never create the
 * database.
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import type { CostRates } from "./cost-rates";
import { stateDbExists, withStateDb } from "./state-db";

export const RUN_STATUSES = ["running", "merged", "held", "nothing", "skipped", "failed", "interrupted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunTrigger = "schedule" | "manual";

export interface RunRecord {
  id: string;
  kind: "nightly";
  branch: string | null;
  status: RunStatus;
  trigger: RunTrigger | null;
  startedAt: string;
  finishedAt: string | null;
  usdEstimate: number;
  /** What the run did: see nightly.ts `NightlySummary`. */
  summary: Record<string, unknown> | null;
}

const ID_ALPHABET = "0123456789abcdef";
const ID_HEX = 12;

export function newRunId(): string {
  return `run-${crypto.randomBytes(ID_HEX / 2).toString("hex")}`;
}

export function safeRunId(input: unknown): string | null {
  if (typeof input !== "string" || !input.startsWith("run-") || input.length !== 4 + ID_HEX) return null;
  let hex = "";
  for (const ch of input.slice(4)) {
    const at = ID_ALPHABET.indexOf(ch);
    if (at < 0) return null;
    hex += ID_ALPHABET[at];
  }
  return `run-${hex}`;
}

interface Row {
  id: string;
  kind: string;
  branch: string | null;
  status: string;
  trigger_kind: string | null;
  started_at: string;
  finished_at: string | null;
  usd_estimate: number;
  summary: string | null;
}

function fromRow(r: Row): RunRecord {
  let summary: Record<string, unknown> | null = null;
  try {
    summary = r.summary ? (JSON.parse(r.summary) as Record<string, unknown>) : null;
  } catch {
    summary = null;
  }
  return {
    id: r.id,
    kind: "nightly",
    branch: r.branch,
    status: (RUN_STATUSES as readonly string[]).includes(r.status) ? (r.status as RunStatus) : "failed",
    trigger: r.trigger_kind === "schedule" || r.trigger_kind === "manual" ? r.trigger_kind : null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    usdEstimate: Number(r.usd_estimate) || 0,
    summary,
  };
}

const COLUMNS = "id, kind, branch, status, trigger_kind, started_at, finished_at, usd_estimate, summary";

export function insertRun(vault: string, run: RunRecord): void {
  withStateDb(vault, (db) => {
    db.prepare(
      `INSERT INTO runs (id, kind, branch, status, trigger_kind, started_at, finished_at, usd_estimate, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(run.id, run.kind, run.branch, run.status, run.trigger, run.startedAt, run.finishedAt, run.usdEstimate, run.summary ? JSON.stringify(run.summary) : null);
  });
}

export function saveRun(vault: string, run: RunRecord): void {
  withStateDb(vault, (db) => {
    db.prepare("UPDATE runs SET branch = ?, status = ?, finished_at = ?, usd_estimate = ?, summary = ? WHERE id = ?").run(
      run.branch,
      run.status,
      run.finishedAt,
      run.usdEstimate,
      run.summary ? JSON.stringify(run.summary) : null,
      run.id,
    );
  });
}

export function readRun(vault: string, id: string): RunRecord | null {
  if (!stateDbExists(vault)) return null;
  return withStateDb(vault, (db) => {
    const row = db.prepare(`SELECT ${COLUMNS} FROM runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  });
}

export function listRuns(vault: string, limit = 20): RunRecord[] {
  if (!stateDbExists(vault)) return [];
  return withStateDb(vault, (db) =>
    (db.prepare(`SELECT ${COLUMNS} FROM runs ORDER BY started_at DESC, id LIMIT ?`).all(Math.max(1, Math.min(limit, 200))) as unknown as Row[]).map(
      fromRow,
    ),
  );
}

/** A run left `running` by a web server that went away is `interrupted`; `live` are the ones running here. */
export function settleOrphanRuns(vault: string, live: ReadonlySet<string>, at: string): number {
  if (!stateDbExists(vault)) return 0;
  return withStateDb(vault, (db) => {
    const rows = db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as Array<{ id: string }>;
    let n = 0;
    for (const { id } of rows) {
      if (live.has(id)) continue;
      n += Number(db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE id = ? AND status = 'running'").run(at, id).changes);
    }
    return n;
  });
}

/** Whether any nightly pass has ever finished (merged, held or found nothing): the first one compares every claim. */
export function anyFinishedRun(vault: string): boolean {
  if (!stateDbExists(vault)) return false;
  return withStateDb(vault, (db) => !!db.prepare("SELECT 1 AS one FROM runs WHERE status IN ('merged', 'held', 'nothing') LIMIT 1").get());
}

// ── costs ─────────────────────────────────────────────────────────────────

export interface CostTotals {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  usdEstimate: number;
}

export interface CostRunRow extends CostTotals {
  runId: string | null;
  /** `nightly`, `ingest`, or `other` (a call filed under no run). */
  kind: "nightly" | "ingest" | "other";
  firstAt: string;
  lastAt: string;
}

export interface CostSummary {
  basis: "estimate";
  currency: "USD";
  rates: CostRates;
  since: string | null;
  totals: CostTotals;
  byOperation: Array<CostTotals & { operation: string }>;
  byModel: Array<CostTotals & { model: string }>;
  byRun: CostRunRow[];
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

function totals(r: { calls: number; tokens_in: number; tokens_out: number; usd: number }): CostTotals {
  return { calls: Number(r.calls) || 0, tokensIn: Number(r.tokens_in) || 0, tokensOut: Number(r.tokens_out) || 0, usdEstimate: round(Number(r.usd) || 0) };
}

const AGG = "COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(usd_estimate), 0) AS usd";

export function readCostSummary(vault: string, rates: CostRates, options: { since?: string | null; runId?: string | null; limit?: number } = {}): CostSummary {
  const empty: CostSummary = {
    basis: "estimate",
    currency: "USD",
    rates,
    since: options.since ?? null,
    totals: { calls: 0, tokensIn: 0, tokensOut: 0, usdEstimate: 0 },
    byOperation: [],
    byModel: [],
    byRun: [],
  };
  if (!stateDbExists(vault)) return empty;
  return withStateDb(vault, (db) => {
    const where: string[] = [];
    const params: string[] = [];
    if (options.since) {
      where.push("at >= ?");
      params.push(options.since);
    }
    if (options.runId) {
      where.push("run_id = ?");
      params.push(options.runId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    type Agg = { calls: number; tokens_in: number; tokens_out: number; usd: number };
    const all = db.prepare(`SELECT ${AGG} FROM costs ${clause}`).get(...params) as Agg;
    const ops = db.prepare(`SELECT operation, ${AGG} FROM costs ${clause} GROUP BY operation ORDER BY usd DESC`).all(...params) as Array<Agg & { operation: string }>;
    const models = db.prepare(`SELECT model, ${AGG} FROM costs ${clause} GROUP BY model ORDER BY usd DESC`).all(...params) as Array<Agg & { model: string }>;
    const runs = db
      .prepare(`SELECT run_id, MIN(at) AS first_at, MAX(at) AS last_at, ${AGG} FROM costs ${clause} GROUP BY run_id ORDER BY last_at DESC LIMIT ?`)
      .all(...params, Math.max(1, Math.min(options.limit ?? 50, 500))) as Array<Agg & { run_id: string | null; first_at: string; last_at: string }>;
    return {
      ...empty,
      totals: totals(all),
      byOperation: ops.map((r) => ({ operation: r.operation, ...totals(r) })),
      byModel: models.map((r) => ({ model: r.model, ...totals(r) })),
      byRun: runs.map((r) => ({
        runId: r.run_id,
        kind: r.run_id?.startsWith("run-") ? "nightly" : r.run_id?.startsWith("ing-") ? "ingest" : "other",
        firstAt: r.first_at,
        lastAt: r.last_at,
        ...totals(r),
      })),
    };
  });
}
