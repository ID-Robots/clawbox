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
 * fills, once per limit core records, never on a timer.
 *
 * Never throws. Null is "Anthropic could not be asked" — a caller must not read
 * it as "not limited".
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_TIMEOUT_MS = 10_000;

export interface AnthropicUsageReading {
  /** At least one window the account's usage counts against is spent. */
  exhausted: boolean;
  /** The latest reset among the spent windows, when Anthropic gave one. */
  resetsAt: number | null;
  /** `weekly` when a weekly window is among the spent ones, else `session`. */
  kind: "session" | "weekly";
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function parseReset(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** A window that counts as spent: Anthropic's own percentage at or over 100. */
const SPENT_PERCENT = 100;

/**
 * The reading of one `/api/oauth/usage` answer, the windows core's parser
 * reads (`parseClaudeUsage`): `five_hour`, `seven_day`, the model weeks, and
 * every active entry of `limits[]`. Pure.
 */
export function parseAnthropicUsage(body: unknown): AnthropicUsageReading {
  const usage = isRecord(body) ? body : {};
  const spent: { resetsAt: number | null; weekly: boolean }[] = [];
  const windows: [unknown, boolean][] = [
    [usage.five_hour, false],
    [usage.seven_day, true],
    [usage.seven_day_opus, true],
    [usage.seven_day_sonnet, true],
  ];
  for (const [window, weekly] of windows) {
    if (!isRecord(window)) continue;
    const percent = window.utilization;
    if (typeof percent === "number" && Number.isFinite(percent) && percent >= SPENT_PERCENT) spent.push({ resetsAt: parseReset(window.resets_at), weekly });
  }
  for (const limit of Array.isArray(usage.limits) ? usage.limits : []) {
    if (!isRecord(limit) || limit.is_active === false) continue;
    const percent = typeof limit.percent === "number" ? limit.percent : limit.utilization;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < SPENT_PERCENT) continue;
    const kind = typeof limit.kind === "string" ? limit.kind.toLowerCase() : "";
    spent.push({ resetsAt: parseReset(limit.resets_at), weekly: kind !== "session" && kind !== "five_hour" });
  }
  const resets = spent.map((s) => s.resetsAt).filter((at): at is number => at !== null);
  return {
    exhausted: spent.length > 0,
    resetsAt: resets.length > 0 ? Math.max(...resets) : null,
    kind: spent.some((s) => s.weekly) ? "weekly" : "session",
  };
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
