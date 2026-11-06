/**
 * Is a restart of clawbox-gateway, issued by THIS server, still in flight?
 *
 * A route that restarts the gateway may answer before the restart is over
 * (TASK-1535: a model save that held its request through stop, pre-start and
 * core start-up took 125 s and was cut off by the browser or the tunnel). The
 * page then waits for the gateway itself, through `/setup-api/gateway/health`.
 * That probe is a TCP connect, and during the first part of a restart the OLD
 * process is still listening while systemd stops it — a probe that only asked
 * the port would call the gateway "back" before it had even gone. This counter
 * is what lets the health route say "not yet" for that window.
 *
 * Kept in its own module, with no imports, so the health route can read it
 * without loading `openclaw-config.ts` and everything behind it. On
 * `globalThis` so every route bundle of this one server process reads the same
 * count.
 */

const STATE_KEY = Symbol.for("clawbox.gateway-restarts-in-flight");

type TrackerState = { inFlight: number };

function state(): TrackerState {
  const holder = globalThis as unknown as Record<symbol, TrackerState | undefined>;
  let current = holder[STATE_KEY];
  if (!current) {
    current = { inFlight: 0 };
    holder[STATE_KEY] = current;
  }
  return current;
}

/**
 * Record that a restart has begun. Call the returned function exactly when it
 * is over — succeeded, refused or timed out; calling it twice is harmless.
 */
export function markGatewayRestartBegun(): () => void {
  state().inFlight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const current = state();
    current.inFlight = Math.max(0, current.inFlight - 1);
  };
}

/** True while any restart this process issued has not returned yet. */
export function gatewayRestartInFlight(): boolean {
  return state().inFlight > 0;
}
