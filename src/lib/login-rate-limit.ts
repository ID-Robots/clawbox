import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "./config-store";

const STATE_PATH = path.join(DATA_DIR, ".login-attempts.json");

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const MIN_RESPONSE_MS = 300;
// Hard cap on tracked keys. Past this we evict the oldest record so an
// attacker rotating cf-connecting-ip can't grow the on-disk state file
// without bound.
const MAX_TRACKED_KEYS = 5000;

// Escalating lockout schedule. Each tier is `failureCount → lock duration`:
// brute-force attackers see exponential backoff up to a 24h ceiling, while
// the real owner who fat-fingers their password 3 times in a row barely
// feels it. Reset on any successful login.
const LOCKOUT_TIERS: Array<{ failures: number; lockMs: number }> = [
  { failures: 5, lockMs: 5 * 60 * 1000 },
  { failures: 10, lockMs: 30 * 60 * 1000 },
  { failures: 20, lockMs: 24 * 60 * 60 * 1000 },
];

interface AttemptRecord {
  failures: number;
  // First failure timestamp in the current window (ms since epoch). Used
  // to drop the counter back to zero after RATE_LIMIT_WINDOW_MS of quiet.
  firstFailureAtMs: number;
  // Wall-clock time the lock expires, or 0 when not locked.
  lockedUntilMs: number;
}

interface State {
  byKey: Record<string, AttemptRecord>;
}

let cached: State | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function loadState(): Promise<State> {
  if (cached) return cached;
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    cached = {
      byKey: parsed && typeof parsed.byKey === "object" && parsed.byKey ? parsed.byKey : {},
    };
  } catch {
    cached = { byKey: {} };
  }
  return cached;
}

async function persist(state: State): Promise<void> {
  // Serialize writes so concurrent failed logins don't race on the same
  // file (last-write-wins would silently undo a counter bump).
  writeChain = writeChain.then(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmpPath = `${STATE_PATH}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(tmpPath, STATE_PATH);
    } catch (err) {
      console.error("[login-rate-limit] persist failed:", err);
    }
  });
  return writeChain;
}

function pruneExpired(state: State, nowMs: number): void {
  for (const [key, rec] of Object.entries(state.byKey)) {
    const idleFor = nowMs - rec.firstFailureAtMs;
    if (rec.lockedUntilMs <= nowMs && idleFor > RATE_LIMIT_WINDOW_MS) {
      delete state.byKey[key];
    }
  }
  // Defensive cap: even after expiry-pruning, an attacker could keep
  // every record "fresh" by rotating IPs faster than the window. Drop
  // the oldest-by-firstFailure entries until we're under the hard cap.
  const keys = Object.keys(state.byKey);
  if (keys.length > MAX_TRACKED_KEYS) {
    const sorted = keys
      .map((k) => [k, state.byKey[k].firstFailureAtMs] as const)
      .sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < sorted.length - MAX_TRACKED_KEYS; i++) {
      delete state.byKey[sorted[i][0]];
    }
  }
}

export interface LockoutCheck {
  locked: boolean;
  retryAfterSeconds: number;
}

/**
 * Returns whether the caller is currently locked out. Does not mutate
 * counters — call recordFailure / recordSuccess after the auth attempt
 * resolves. Pure read so the caller can decline early.
 */
export async function checkLockout(key: string): Promise<LockoutCheck> {
  const state = await loadState();
  const now = Date.now();
  const rec = state.byKey[key];
  if (!rec || rec.lockedUntilMs <= now) {
    return { locked: false, retryAfterSeconds: 0 };
  }
  return {
    locked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((rec.lockedUntilMs - now) / 1000)),
  };
}

/**
 * Record a failed attempt. Bumps the counter, applies the next lockout
 * tier when reached, and persists. Returns the post-update lockout state
 * so the caller can return a single Retry-After response without an
 * extra round-trip.
 */
export async function recordFailure(key: string): Promise<LockoutCheck> {
  const state = await loadState();
  const now = Date.now();
  pruneExpired(state, now);

  let rec = state.byKey[key];
  if (!rec || (now - rec.firstFailureAtMs > RATE_LIMIT_WINDOW_MS && rec.lockedUntilMs <= now)) {
    rec = { failures: 0, firstFailureAtMs: now, lockedUntilMs: 0 };
  }
  rec.failures += 1;

  // Apply the highest-tier lock the new failure count satisfies. Walk the
  // tiers low-to-high and keep the last match so each subsequent breach
  // refreshes the lock window from "now".
  for (const tier of LOCKOUT_TIERS) {
    if (rec.failures >= tier.failures) {
      rec.lockedUntilMs = now + tier.lockMs;
    }
  }

  state.byKey[key] = rec;
  await persist(state);

  if (rec.lockedUntilMs > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((rec.lockedUntilMs - now) / 1000)),
    };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

/** Wipe the counter for this key — called on a successful login. */
export async function recordSuccess(key: string): Promise<void> {
  const state = await loadState();
  if (state.byKey[key]) {
    delete state.byKey[key];
    await persist(state);
  }
}

/**
 * Pads a response so the wall-clock time-to-respond is at least
 * MIN_RESPONSE_MS regardless of whether the password check was a fast
 * "missing password" reject or a slow PAM round-trip. Closes the timing
 * oracle that otherwise lets an attacker distinguish "no such user / fast
 * fail" from "real PAM call / slow fail".
 */
export async function padResponseTime(startedAtMs: number, minMs: number = MIN_RESPONSE_MS): Promise<void> {
  const elapsed = Date.now() - startedAtMs;
  const wait = minMs - elapsed;
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Test-only: reset cached state so tests aren't order-dependent. */
export function _resetForTest(): void {
  cached = null;
  writeChain = Promise.resolve();
}
