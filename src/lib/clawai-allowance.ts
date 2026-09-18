/**
 * ClawBox AI's rolling allowances, as the box meets them: the refusal the
 * proxy answers when one is spent, and the "frees up at" instant it quotes.
 *
 * Pure TypeScript with no Node or React imports, because three surfaces that
 * live in different places word the same refusal — the chat bubble (browser),
 * the coding run's record (server) and the usage card (browser) — and a second
 * copy of the matching rules would drift from the first the day the proxy's
 * wording changes.
 *
 * The allowances are ROLLING windows, not calendar ones: the weekly chat pool
 * and the memory-indexing meter cover the trailing seven days, the burst
 * ceiling the trailing five hours. Nothing resets; the oldest usage ages out.
 * So the proxy's `resetAt` is "frees up at" — the next moment enough of the
 * window comes back — and it is shown in the box's own clock, never as UTC:
 * unlike the old per-UTC-day picture allowance, no zone is privileged here.
 */

export const CLAWAI_ALLOWANCE_KINDS = ["weekly", "burst", "embeddings"] as const;

export type ClawaiAllowanceKind = (typeof CLAWAI_ALLOWANCE_KINDS)[number];

/** The proxy's refusal codes (`error.code` on its 429), by the allowance each names. */
export const CLAWAI_ALLOWANCE_CODES: Record<string, ClawaiAllowanceKind> = {
  weekly_limit_exceeded: "weekly",
  burst_limit_exceeded: "burst",
  embeddings_weekly_limit_exceeded: "embeddings",
};

export interface ClawaiAllowanceRefusal {
  kind: ClawaiAllowanceKind;
  /** ISO 8601 "frees up at", or null when the refusal did not carry one. */
  resetAt: string | null;
  /** The proxy's own sentence when it could be lifted out of the text, else null. */
  message: string | null;
}

/**
 * The code as it appears in the wire text. `\b` does the work of keeping the
 * embeddings code from reading as the weekly one: `_` is a word character, so
 * "embeddings_weekly_limit_exceeded" has no boundary before "weekly".
 */
const CODE_RE = /\b(embeddings_weekly|weekly|burst)_limit_exceeded\b/;

/**
 * The proxy's own sentences, for a layer that kept the message and dropped the
 * envelope. Each is the opening of the `reason` the portal writes for that
 * window, so an unrelated "limit" line cannot match.
 */
const PHRASES: ReadonlyArray<readonly [RegExp, ClawaiAllowanceKind]> = [
  [/memory indexing allowance used up/i, "embeddings"],
  [/short-term burst limit reached/i, "burst"],
  [/weekly (?:token )?(?:allowance used up|limit reached)/i, "weekly"],
];

/**
 * `resetAt` beside the code, however the layers above quoted it: raw JSON,
 * JSON inside a JSON string (`\"resetAt\":\"…\"`), or `resetAt=…` in a log line.
 */
const RESET_AT_RE =
  /resetAt\\?"?\s*[:=]\s*\\?"?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/;

/** The longest proxy sentence carried forward; the rest is envelope. */
const MAX_MESSAGE_CHARS = 300;

/**
 * The proxy's sentence out of its `{"error":{"message":…}}` envelope: the
 * envelope parsed when the text holds one whole, else the first `"message"`
 * string read with its escapes. Null when neither is there.
 */
function liftMessage(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { error?: { message?: unknown }; message?: unknown };
      const message = parsed?.error?.message ?? parsed?.message;
      if (typeof message === "string") return message;
    } catch {
      // Not one JSON object — a prefix or a suffix around it. Try the field alone.
    }
  }
  const field = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!field) return null;
  try {
    return JSON.parse(`"${field[1]}"`) as string;
  } catch {
    return field[1];
  }
}

/**
 * Read a ClawBox AI allowance refusal out of whatever text a failing layer
 * handed over — a gateway `errorMessage`, a harness's `API Error: 429 {…}`, a
 * stderr tail — or null when the text is not one.
 *
 * Only these three windows. A per-minute rate limit, a size limit or a picture
 * allowance are different failures with different remedies and keep their own
 * wording wherever they are handled.
 */
export function parseClawaiAllowanceRefusal(raw: unknown): ClawaiAllowanceRefusal | null {
  if (typeof raw !== "string" || !raw) return null;
  const code = CODE_RE.exec(raw);
  let kind: ClawaiAllowanceKind | null = code ? CLAWAI_ALLOWANCE_CODES[`${code[1]}_limit_exceeded`] ?? null : null;
  if (!kind) {
    for (const [pattern, phraseKind] of PHRASES) {
      if (pattern.test(raw)) {
        kind = phraseKind;
        break;
      }
    }
  }
  if (!kind) return null;
  const at = RESET_AT_RE.exec(raw)?.[1] ?? null;
  const resetAt = at && !Number.isNaN(Date.parse(at)) ? at : null;
  const lifted = liftMessage(raw)?.trim() ?? "";
  return { kind, resetAt, message: lifted ? lifted.slice(0, MAX_MESSAGE_CHARS) : null };
}

export interface FreesUpOptions {
  /** BCP 47 locale the clock is written in (the desktop's UI language). */
  locale: string;
  /** IANA zone to read the instant in; the runtime's own zone when absent or invalid. */
  timeZone?: string | null;
  /** "Now", for tests. */
  now?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions, timeZone?: string | null): Intl.DateTimeFormat {
  const base: Intl.DateTimeFormatOptions = { ...options, hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  for (const candidateLocale of [locale, "en"]) {
    try {
      return new Intl.DateTimeFormat(candidateLocale, timeZone ? { ...base, timeZone } : base);
    } catch {
      // An unknown zone (a box whose zone string Intl does not know) or a bad
      // locale tag: fall through to the runtime's zone, then to English.
      try {
        return new Intl.DateTimeFormat(candidateLocale, base);
      } catch {
        // Next candidate.
      }
    }
  }
  return new Intl.DateTimeFormat(undefined, base);
}

function calendarDay(format: Intl.DateTimeFormat, at: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: format.resolvedOptions().timeZone,
  }).format(at);
  return parts;
}

/**
 * "Frees up at" as the owner reads a clock: `HH:MM` when the instant is today,
 * the weekday in front of it within six days either side, and the date in
 * front of it beyond that. Null when there is no instant to show.
 *
 * Never a bare `HH:MM` for another day. A weekly window can free up four days
 * from now, and "14:05" alone would read as this afternoon.
 */
export function formatFreesUpAt(resetAt: string | null | undefined, options: FreesUpOptions): string | null {
  if (!resetAt) return null;
  const at = Date.parse(resetAt);
  if (Number.isNaN(at)) return null;
  const now = options.now ?? Date.now();
  const clock = dateTimeFormat(options.locale, {}, options.timeZone);
  if (calendarDay(clock, at) === calendarDay(clock, now)) {
    return clock.format(at);
  }
  // Either side of now: an instant already past (a paused run looked at days
  // later) needs its day just as much as one still to come.
  if (Math.abs(at - now) < 6 * DAY_MS) {
    return dateTimeFormat(options.locale, { weekday: "short" }, options.timeZone).format(at);
  }
  return dateTimeFormat(options.locale, { day: "numeric", month: "short" }, options.timeZone).format(at);
}
