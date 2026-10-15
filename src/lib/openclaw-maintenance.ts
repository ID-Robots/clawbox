/**
 * OpenClaw's "the state is under offline maintenance; retry when it finishes".
 *
 * The pinned core (2026.10.3) refuses every CLI command that reads its config
 * while another process holds the state database as `sqlite-maintenance`:
 *
 *     OpenClaw state at …/openclaw.sqlite is undergoing offline maintenance;
 *     retry when it finishes.
 *
 * and, for an owner record caught half-written, "…could not be verified; retry
 * after maintenance finishes." The holders that ClawBox meets are every gateway
 * start's own CLI bootstrap (about 5 s on an x64 runner, 8.5 s measured on a
 * Jetson) and every `openclaw doctor --fix` ClawBox launches. The refusal comes
 * from the config read, before the command acts, so asking again is safe; and
 * the core retries nothing itself except cold write admission for 5 s. Its
 * config read even turns the refusal into "OpenClaw config is invalid / could
 * not be read", which a caller then reports as a broken config.
 *
 * Nothing native exists at 2026.10.3 to wait for it: no flag, no environment
 * variable, no distinct exit code (validate exits 1 like a real refusal). The
 * core's own instruction is "retry when it finishes", so this does exactly that,
 * keyed on its own words, bounded, inside the caller's timeout, and then says
 * so in a sentence an owner can act on rather than "config invalid".
 *
 * Its own module, not an export of `@/lib/openclaw-config`: fifty-nine suites
 * replace that module with a hand-written factory, and a class one of them
 * omits is `undefined` to every `instanceof` against it.
 */

/** Both of the core's admission refusals end in this instruction. */
export const OPENCLAW_MAINTENANCE_RE = /retry (?:when it|after maintenance) finishes/i;

/** How long one call keeps asking: past a Jetson gateway bootstrap, short of doctor's minutes. */
export const MAINTENANCE_RETRY_WINDOW_MS = 25_000;
/** The pause between two asks. */
export const MAINTENANCE_RETRY_PAUSE_MS = 1_500;

/** The core kept refusing for maintenance for the whole retry window. */
export class OpenclawStateMaintenanceError extends Error {
  readonly code = "openclaw_maintenance";
  constructor(readonly detail: string) {
    super("OpenClaw is finishing maintenance on its data and did not take this in time. Try again in a minute.");
    this.name = "OpenclawStateMaintenanceError";
  }
}

/** The text a failure carries: its message and, for an execFile error, what the child printed. */
function failureText(err: unknown): string {
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return "";
  const { message, stderr, stdout } = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [message, stderr, stdout]
    .map((part) => (typeof part === "string" ? part : Buffer.isBuffer(part) ? part.toString("utf8") : ""))
    .join("\n");
}

/** Whether a failure (or a text) is the core's maintenance refusal. */
export function isOpenclawMaintenanceRefusal(errOrText: unknown): boolean {
  if (errOrText instanceof OpenclawStateMaintenanceError) return true;
  return OPENCLAW_MAINTENANCE_RE.test(failureText(errOrText));
}

/** The core's own sentence, for the device log. */
function refusalLine(err: unknown): string {
  const line = failureText(err)
    .split(/\r?\n/)
    .find((text) => OPENCLAW_MAINTENANCE_RE.test(text));
  return (line ?? "").trim().slice(0, 300);
}

export interface MaintenanceRetryOptions {
  /** The caller's whole budget. Every attempt is given what is left of it. */
  timeoutMs: number;
  /** Names the command in the device log; never carries a value. */
  label: string;
  windowMs?: number;
  pauseMs?: number;
}

/**
 * Run `attempt` and ask again while the core answers that its state is under
 * offline maintenance: at most `windowMs` from the first ask, never past the
 * caller's `timeoutMs`, and only while the time left could hold another ask as
 * long as the one just refused. Anything else the attempt throws is rethrown
 * at once, untouched.
 */
export async function withOpenclawMaintenanceRetry<T>(
  attempt: (timeoutMs: number) => Promise<T>,
  options: MaintenanceRetryOptions,
): Promise<T> {
  const windowMs = options.windowMs ?? MAINTENANCE_RETRY_WINDOW_MS;
  const pauseMs = options.pauseMs ?? MAINTENANCE_RETRY_PAUSE_MS;
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  for (let tries = 1; ; tries++) {
    const askedAt = Date.now();
    try {
      // The first ask is exactly the call it always was; only a repeat is
      // given what is left.
      return await attempt(tries === 1 ? options.timeoutMs : Math.max(1, deadline - askedAt));
    } catch (err) {
      if (!isOpenclawMaintenanceRefusal(err)) throw err;
      if (err instanceof OpenclawStateMaintenanceError) throw err;
      const now = Date.now();
      const lastAskMs = now - askedAt;
      const fitsWindow = now + pauseMs - started <= windowMs;
      const fitsBudget = deadline - (now + pauseMs) > lastAskMs;
      if (!fitsWindow || !fitsBudget) {
        console.warn(
          `[openclaw] ${options.label}: the state was still under offline maintenance after ${tries} ask(s); giving up`,
        );
        throw new OpenclawStateMaintenanceError(refusalLine(err));
      }
      if (tries === 1) {
        console.warn(`[openclaw] ${options.label}: ${refusalLine(err) || "offline maintenance"} — asking again`);
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}
