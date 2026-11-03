/**
 * Is a Claude account at its usage limit, and when does it come back? Asked of
 * Anthropic itself (TASK-1260, the chat on the pool).
 *
 * WHY. When the OpenClaw gateway rotates off a pool account inside a turn, the
 * only trace is core's failure state for that profile — and the window core
 * writes there is its OWN backoff (30 s, then doubling per rate-limit failure,
 * kept across windows, up to a day: `computeNextProfileUsageStats` on
 * 2026.10.2), never the account's reset. Anthropic's usage endpoint has the
 * real answer per account: the five-hour and weekly windows, the model-scoped
 * weeks, each with how full it is and when it resets.
 *
 * HARNESS FIRST. This is the endpoint and the headers core's own reader uses
 * (`fetchClaudeUsage`, `provider-usage.fetch.claude`). Core asks it only for
 * the provider's FIRST profile, for display (`models.authStatus` → `usage`),
 * so it cannot answer for each account of a pool; that is the one gap this
 * fills, once per limit core records — and, when the owner chose the "most
 * room" pick, at a move or a spawn, at most every ten minutes per account
 * (src/lib/anthropic-accounts.ts) — never on a timer.
 *
 * Never throws. Null is "Anthropic could not be asked" — a caller must not read
 * it as "not limited".
 *
 * THE METERS OF 2026-11 (TASK-2141). Anthropic moved the subscriptions off the
 * five-hour + weekly pair: the answer now carries `five_hour: null`, the
 * account's week in `seven_day`, and every meter in `limits[]`, each with a
 * `kind` — `session`, `weekly_all` (the account's week) or `weekly_scoped`
 * (one model's own week, `scope.model`) — a `group`, a `severity`, a
 * `percent` and `is_active`. Claude Code classifies on `kind`, never on a
 * label, and so does this reader. A spent `weekly_scoped` week stops only runs
 * on THAT model: it is a model week here (`models`), never the account's
 * `exhausted`. The answer of the old shape still reads as it always did.
 */

import { modelFamily } from "@/lib/anthropic-limit";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_TIMEOUT_MS = 10_000;

/** One model's own week (`weekly_scoped`), as the account's answer gave it. */
export interface AnthropicModelWeek {
  /** What a run's model is matched on (modelFamily): "fable" for `claude-fable-5-1`. Null: no model named. */
  family: string | null;
  /** Anthropic's name for it, for the owner ("Fable"). */
  name: string;
  percent: number;
  resetsAt: number | null;
  /** At or over 100 %: runs on this model are refused until `resetsAt`. */
  spent: boolean;
}

/** One of the account's OWN windows — every run on the account counts against it. */
export interface AnthropicUsageWindow {
  kind: "session" | "weekly";
  percent: number;
  resetsAt: number | null;
  /** Anthropic's `severity` calls it refused, whatever its percent (absent: it does not). */
  refused?: true;
}

export interface AnthropicUsageReading {
  /** At least one of the ACCOUNT's own windows is spent (a model's own week never is this). */
  exhausted: boolean;
  /** The latest reset among the spent windows, when Anthropic gave one. */
  resetsAt: number | null;
  /** `weekly` when a weekly window is among the spent ones, else `session`. */
  kind: "session" | "weekly";
  /**
   * How full the session and the account's week are, in Anthropic's own
   * percent — `five_hour` / `seven_day`, else the active `session` /
   * `weekly_all` meter; null where the answer had no such window.
   */
  utilization: { fiveHour: number | null; sevenDay: number | null };
  /** The account's own windows, as read (both shapes). Optional only for a reading made before TASK-2141. */
  windows?: AnthropicUsageWindow[];
  /** The active model weeks (`weekly_scoped`, `is_active` not false). Optional as `windows` is. */
  models?: AnthropicModelWeek[];
  /** Extra usage past the plan, when the answer says: on, and whether its monthly spend limit is reached. */
  extraUsage?: { enabled: boolean; spendLimitReached: boolean } | null;
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function parseReset(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

const percentOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const word = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");

/** A window that is spent: Anthropic's own percentage at or over 100. */
const FULL_PERCENT = 100;

/** A meter Anthropic itself calls refused, whatever its percent says. */
const SPENT_SEVERITIES = new Set(["rejected", "exceeded", "blocked", "limited"]);

/** The `limits[]` kinds Claude Code knows (CLI 2.1.317): classified on these, never on a label. */
const SESSION_KINDS = new Set(["session", "five_hour"]);
const ACCOUNT_WEEK_KINDS = new Set(["weekly_all", "seven_day"]);
const MODEL_WEEK_KINDS = new Set(["weekly_scoped"]);

/** The model a `weekly_scoped` meter caps: `scope.model.{id, display_name}`. */
function scopedModel(scope: unknown): { family: string | null; name: string } | null {
  const model = isRecord(scope) && isRecord(scope.model) ? scope.model : null;
  if (!model) return null;
  const id = typeof model.id === "string" && model.id.trim() ? model.id.trim() : null;
  const display = typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim().slice(0, 40) : null;
  if (!id && !display) return null;
  return { family: modelFamily(id) ?? modelFamily(display), name: display ?? id ?? "" };
}

/**
 * The session window refuses a few points short of full: Anthropic turns away
 * the request that "would exceed your account's rate limit", so asked a moment
 * later the five-hour window that refused can still read 9x %. Only that
 * window, and only when nothing is full: a WEEK at 92 % is a week with room,
 * and taking an account out until its weekly reset over it would lose it for
 * days to a session window that is back in hours.
 */
const SESSION_REFUSES_PERCENT = 90;

/**
 * The reading of one `/api/oauth/usage` answer, the windows core's parser
 * reads (`parseClaudeUsage`): `five_hour`, `seven_day`, the old shape's model
 * weeks (`seven_day_opus`/`_sonnet`, read as the account's, as they always
 * were), and every active entry of `limits[]` by its `kind`. Spent: every one
 * of the ACCOUNT's windows at 100 % (or that Anthropic's `severity` calls
 * refused) — the latest of their resets is when the account answers again —
 * else the session window when it is at 90 % or more. A model's own week is
 * never the account's: it is in `models`, and `usageForModel` reads it for a
 * run on that model. Pure; every key may be missing or null.
 */
export function parseAnthropicUsage(body: unknown): AnthropicUsageReading {
  const usage = isRecord(body) ? body : {};
  const windows: AnthropicUsageWindow[] = [];
  const models: AnthropicModelWeek[] = [];
  const add = (percent: number | null, resetsAt: unknown, kind: AnthropicUsageWindow["kind"], refused = false) => {
    if (percent !== null) windows.push({ kind, percent, resetsAt: parseReset(resetsAt), ...(refused ? { refused: true as const } : {}) });
  };
  const meters = Array.isArray(usage.limits);
  for (const [window, kind] of [[usage.five_hour, "session"], [usage.seven_day, "weekly"]] as const) {
    if (isRecord(window)) add(percentOf(window.utilization), window.resets_at, kind);
  }
  // The old shape's model weeks were read as the account's own, and an answer
  // of that shape still is. Beside `limits[]` they are what they are: that
  // model's week (unless a `weekly_scoped` meter says it already).
  const legacyWeeks: AnthropicModelWeek[] = [];
  for (const [window, family, name] of [[usage.seven_day_opus, "opus", "Opus"], [usage.seven_day_sonnet, "sonnet", "Sonnet"]] as const) {
    if (!isRecord(window)) continue;
    const percent = percentOf(window.utilization);
    if (percent === null) continue;
    if (meters) legacyWeeks.push({ family, name, percent, resetsAt: parseReset(window.resets_at), spent: percent >= FULL_PERCENT });
    else add(percent, window.resets_at, "weekly");
  }
  let session: number | null = null;
  let week: number | null = null;
  for (const limit of Array.isArray(usage.limits) ? usage.limits : []) {
    if (!isRecord(limit) || limit.is_active === false) continue;
    const percent = percentOf(limit.percent) ?? percentOf(limit.utilization);
    if (percent === null) continue;
    const kind = word(limit.kind);
    const group = word(limit.group);
    const refused = SPENT_SEVERITIES.has(word(limit.severity));
    const model = scopedModel(limit.scope);
    // A kind this box does not know is placed by what it does know: a meter
    // scoped to a model is that model's week; else its group, else (as before
    // TASK-2141) the account's week.
    if (MODEL_WEEK_KINDS.has(kind) || (!SESSION_KINDS.has(kind) && !ACCOUNT_WEEK_KINDS.has(kind) && model)) {
      if (model) models.push({ ...model, percent, resetsAt: parseReset(limit.resets_at), spent: refused || percent >= FULL_PERCENT });
      continue;
    }
    const isSession = SESSION_KINDS.has(kind) || (!ACCOUNT_WEEK_KINDS.has(kind) && group === "session");
    add(percent, limit.resets_at, isSession ? "session" : "weekly", refused);
    if (isSession) session = Math.max(session ?? 0, percent);
    if (kind === "weekly_all") week = Math.max(week ?? 0, percent);
  }
  for (const legacy of legacyWeeks) {
    if (!models.some((m) => m.family === legacy.family)) models.push(legacy);
  }
  const full = windows.filter((w) => w.refused || w.percent >= FULL_PERCENT);
  const spent = full.length > 0 ? full : windows.filter((w) => w.kind === "session" && w.percent >= SESSION_REFUSES_PERCENT);
  const resets = spent.map((w) => w.resetsAt).filter((at): at is number => at !== null);
  const legacy = (window: unknown) => (isRecord(window) ? percentOf(window.utilization) : null);
  const extra = isRecord(usage.extra_usage) ? usage.extra_usage : null;
  return {
    exhausted: spent.length > 0,
    resetsAt: resets.length > 0 ? Math.max(...resets) : null,
    kind: spent.some((w) => w.kind === "weekly") ? "weekly" : "session",
    utilization: { fiveHour: legacy(usage.five_hour) ?? session, sevenDay: legacy(usage.seven_day) ?? week },
    windows,
    models,
    extraUsage: extra && (typeof extra.is_enabled === "boolean" || typeof extra.spend_limit_reached === "boolean")
      ? { enabled: extra.is_enabled === true, spendLimitReached: extra.spend_limit_reached === true }
      : null,
  };
}

/** How a run on one model meets an account's answer (usageForModel). */
export interface ModelUsage {
  /** The account's own window is spent, or this model's week is. */
  exhausted: boolean;
  /** When the run's model is answered again: the latest reset among what is spent. */
  resetsAt: number | null;
  /** The account's own spent window — every run on the account stops. Null: none is. */
  account: { kind: "session" | "weekly"; resetsAt: number | null } | null;
  /** This model's own week when it is spent — only runs on this model stop. Null: it is not (or none was read). */
  week: AnthropicModelWeek | null;
  /**
   * How full the fullest window this model counts against is: the account's
   * own and the model's week, 100 when spent; null with no window read. What
   * the "most room" pick ranks a pick for this model by.
   */
  fullness: number | null;
}

/**
 * The answer as a run on `model` meets it (TASK-2141): the account's own
 * windows, plus the `weekly_scoped` week whose model is the run's family.
 * A week scoped to ANOTHER model does not count — a run on Opus still has the
 * account when the Fable week is spent. With no model, the account's own.
 */
export function usageForModel(reading: AnthropicUsageReading, model: string | null | undefined): ModelUsage {
  const week = weekOf(reading, model);
  const spentWeek = week?.spent ? week : null;
  // The session window counts as spent a few points short of full (the 90 %
  // rule) only when nothing else explains the stop: beside a spent model week
  // it is that week, and the account keeps every other model.
  const full = (reading.windows ?? []).some((w) => w.refused || w.percent >= FULL_PERCENT);
  const account = reading.exhausted && (full || !spentWeek) ? { kind: reading.kind, resetsAt: reading.resetsAt } : null;
  const resets = [account?.resetsAt ?? null, spentWeek?.resetsAt ?? null].filter((at): at is number => at !== null);
  const percents = [...(reading.windows ?? []).map((w) => w.percent), ...(week ? [week.percent] : [])];
  return {
    exhausted: account !== null || spentWeek !== null,
    resetsAt: resets.length > 0 ? Math.max(...resets) : null,
    account,
    week: spentWeek,
    fullness: account || spentWeek ? FULL_PERCENT : percents.length > 0 ? Math.min(FULL_PERCENT, Math.max(...percents)) : null,
  };
}

/** The run's model week in the answer: of several for one family, the fullest. */
function weekOf(reading: AnthropicUsageReading, model: string | null | undefined): AnthropicModelWeek | null {
  const family = modelFamily(model);
  if (!family) return null;
  let best: AnthropicModelWeek | null = null;
  for (const week of reading.models ?? []) {
    if (week.family === family && (!best || (week.spent && !best.spent) || (week.spent === best.spent && week.percent > best.percent))) best = week;
  }
  return best;
}

/**
 * Which window a CLI stop that the answer does NOT show spent was most likely
 * on (a request refused because it WOULD cross it): the session window or the
 * run's own model week, whichever is fuller, when it is at 90 % or more
 * (SESSION_REFUSES_PERCENT). Never the account's week: a WEEK at 9x % is a
 * week with room, and parking the whole account until its weekly reset over
 * it would lose it for days — the model's week loses only that model. Null:
 * nothing is that close, and the CLI's own words decide.
 */
export function nearestFull(reading: AnthropicUsageReading, model: string | null | undefined): { window: AnthropicUsageWindow; week: AnthropicModelWeek | null } | null {
  const week = weekOf(reading, model);
  let best: { window: AnthropicUsageWindow; week: AnthropicModelWeek | null } | null = null;
  for (const window of reading.windows ?? []) {
    if (window.kind === "session" && (!best || window.percent > best.window.percent)) best = { window, week: null };
  }
  if (week && (!best || week.percent > best.window.percent)) best = { window: { kind: "weekly", percent: week.percent, resetsAt: week.resetsAt }, week };
  return best && best.window.percent >= SESSION_REFUSES_PERCENT ? best : null;
}

/** One account's windows, with its own access token. Null when Anthropic could not be asked or would not say. */
export async function fetchAnthropicUsage(access: string): Promise<AnthropicUsageReading | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${access}`,
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseAnthropicUsage(await res.json());
  } catch {
    return null;
  }
}
