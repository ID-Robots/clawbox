/**
 * Explicit readiness waits for the e2e-install suite (TASK-1403).
 *
 * The specs used to lean on Playwright's 60 s action timeout and fixed sleeps
 * to ride out a web server or gateway that was still coming up: a click
 * against a page served by a half-started box waited the full minute and then
 * failed with a timeout that said nothing about why. These helpers poll the
 * box's own readiness signals instead — `/setup-api/setup/status` for the web
 * server and `/setup-api/gateway/health` for the OpenClaw gateway — with one
 * bounded overall deadline and an error that names the signal that never came.
 * Once they return, UI actions run on the config's normal timeouts.
 */
import { BASE_URL } from "./container";
import { loginSessionCookie } from "./setup-api";

const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;

export interface ReadinessOptions {
  /** Overall budget for the whole wait, including the web-server wait. */
  timeoutMs?: number;
  /** Consecutive good polls required, so a server that flaps is not "ready". */
  stablePolls?: number;
  /** What the caller is about to do, for the error message. */
  context?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

async function pollUntil(
  what: string,
  deadline: number,
  stablePolls: number,
  context: string | undefined,
  probe: () => Promise<{ ok: boolean; detail: string }>,
): Promise<void> {
  const started = Date.now();
  let good = 0;
  let last = "no response yet";
  while (Date.now() < deadline) {
    try {
      const { ok, detail } = await probe();
      last = detail;
      good = ok ? good + 1 : 0;
    } catch (err) {
      last = describe(err);
      good = 0;
    }
    if (good >= stablePolls) return;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `${what} not ready after ${Math.round((Date.now() - started) / 1000)}s`
    + (context ? ` (before: ${context})` : "")
    + `; last observation: ${last}`,
  );
}

/**
 * Wait until the web server answers `/setup-api/setup/status` with 2xx on
 * `stablePolls` consecutive polls. Pre-auth by design, so no session needed.
 */
export async function waitForAppReady(opts: ReadinessOptions = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  await pollUntil("ClawBox web server", deadline, opts.stablePolls ?? 2, opts.context, async () => {
    const res = await fetch(`${BASE_URL}/setup-api/setup/status`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { ok: res.ok, detail: `GET /setup-api/setup/status → HTTP ${res.status}` };
  });
}

/**
 * Wait until the web server is up AND `/setup-api/gateway/health` reports the
 * gateway available on `stablePolls` consecutive polls. Both waits share one
 * deadline.
 *
 * Once setup is complete the health route needs a session; on a 401/403 this
 * logs in with the password the setup wizard spec sets and retries with it.
 */
export async function waitForGatewayReady(opts: ReadinessOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3 * 60_000;
  const deadline = Date.now() + timeoutMs;
  const stablePolls = opts.stablePolls ?? 2;
  await waitForAppReady({ timeoutMs, stablePolls, context: opts.context });

  let cookie: string | null = null;
  await pollUntil("OpenClaw gateway", deadline, stablePolls, opts.context, async () => {
    const get = () =>
      fetch(`${BASE_URL}/setup-api/gateway/health`, {
        headers: cookie ? { cookie } : {},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    let res = await get();
    if ((res.status === 401 || res.status === 403) && !cookie) {
      cookie = await loginSessionCookie();
      res = await get();
    }
    if (!res.ok) return { ok: false, detail: `GET /setup-api/gateway/health → HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { available?: boolean; port?: number } | null;
    return {
      ok: body?.available === true,
      detail: `gateway/health → ${JSON.stringify(body)}`,
    };
  });
}
