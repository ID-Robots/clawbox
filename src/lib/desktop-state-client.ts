/**
 * The desktop's side of saving its windows (TASK-1306): read the saved state
 * once when the desktop loads, and save it again as windows open, move and
 * close.
 *
 * Two copies. The DEVICE's (`/setup-api/desktop/state`, one per ClawBox user)
 * is the one that counts: it follows the user to any browser. THIS browser's,
 * in localStorage under the user's name, is written first on every change and
 * is what a refresh restores when the device store cannot be reached — or when
 * the last save never got there (see `pickDesktopState`). Keyed by user, so two
 * people taking turns on one browser never see each other's windows; with no
 * user known, nothing is kept locally at all.
 */

import {
  pickDesktopState,
  sanitizeDesktopState,
  type DesktopState,
  type LocalDesktopCopy,
} from "@/lib/desktop-state";

export const DESKTOP_STATE_URL = "/setup-api/desktop/state";

/** How long a change settles before it is sent to the device. Every change reaches this browser's copy at once. */
export const SAVE_DELAY_MS = 400;

/** How long the desktop waits for the device's copy, per attempt, before restoring from this browser's. */
const LOAD_TIMEOUT_MS = 8000;

/** Attempts at the device's copy: a busy box that drops one request still answers the next. */
const LOAD_ATTEMPTS = 2;

/** Past this, a request cannot be `keepalive` (the browser's budget is 64 KiB for all of them). */
const KEEPALIVE_MAX_BYTES = 60_000;

const LOCAL_PREFIX = "clawbox:desktop-state:v1:";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function browserStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    // A browser with storage switched off throws on the property itself.
    return null;
  }
}

function localKey(user: string): string {
  return `${LOCAL_PREFIX}${user}`;
}

export function readLocalDesktopState(user: string, storage: StorageLike | null = browserStorage()): LocalDesktopCopy | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(localKey(user));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: unknown; synced?: unknown };
    const state = sanitizeDesktopState(parsed?.state);
    return state ? { state, synced: parsed.synced === true } : null;
  } catch {
    return null;
  }
}

export function writeLocalDesktopState(user: string, copy: LocalDesktopCopy, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(localKey(user), JSON.stringify(copy));
  } catch {
    // Quota, or storage switched off: the device's copy still stands.
  }
}

export interface LoadedDesktopState {
  /** Whose desktop this is, as the device (or `users/me`) says; null when neither answered. */
  user: string | null;
  state: DesktopState | null;
  source: "device" | "local" | "none";
  /** The device lacks what is restored (this browser's copy never reached it): send it without waiting for a change. */
  resend: boolean;
}

/**
 * The state to restore. `whoAmI` is asked only when the device store did not
 * answer — its answer names the user too.
 */
export async function loadDesktopState(opts: {
  whoAmI: () => Promise<string | null>;
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
  timeoutMs?: number;
}): Promise<LoadedDesktopState> {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  let device: { reachable: true; state: DesktopState | null } | { reachable: false } = { reachable: false };
  let user: string | null = null;
  for (let attempt = 0; attempt < LOAD_ATTEMPTS && !device.reachable; attempt++) {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => abort?.abort(), opts.timeoutMs ?? LOAD_TIMEOUT_MS);
    try {
      const res = await fetchImpl(DESKTOP_STATE_URL, { cache: "no-store", signal: abort?.signal });
      if (res.ok) {
        const body = (await res.json()) as { user?: unknown; state?: unknown };
        if (typeof body?.user === "string" && body.user) {
          user = body.user;
          device = { reachable: true, state: body.state == null ? null : sanitizeDesktopState(body.state) };
        }
      }
    } catch {
      // Unreachable this time: once more, then this browser's copy is what there is.
    } finally {
      clearTimeout(timer);
    }
  }
  if (!user) {
    try {
      user = await opts.whoAmI();
    } catch {
      user = null;
    }
  }
  const local = user ? readLocalDesktopState(user, storage) : null;
  const picked = pickDesktopState(device, local);
  return { user, state: picked.state, source: picked.source, resend: picked.resend && device.reachable };
}

export interface DesktopStateSaver {
  /** Keep `state`: in this browser now, on the device once changes settle. */
  save(state: DesktopState): void;
  /** Send what is waiting now — the page is going away (`keepalive` outlives it). */
  flush(): void;
  /** Stop: nothing more is sent. */
  dispose(): void;
}

export function createDesktopStateSaver(opts: {
  user: string | null;
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
  delayMs?: number;
}): DesktopStateSaver {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  const delayMs = opts.delayMs ?? SAVE_DELAY_MS;
  let pending: DesktopState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> = Promise.resolve();
  let disposed = false;

  const markSynced = (state: DesktopState) => {
    if (!opts.user) return;
    // Only if nothing newer has been kept since this one was sent.
    const current = readLocalDesktopState(opts.user, storage);
    if (current && current.state.savedAt === state.savedAt) writeLocalDesktopState(opts.user, { state, synced: true }, storage);
  };

  const send = (state: DesktopState, keepalive: boolean): Promise<void> => {
    const body = JSON.stringify({ state });
    return fetchImpl(DESKTOP_STATE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: keepalive && body.length <= KEEPALIVE_MAX_BYTES,
    })
      .then((res) => { if (res.ok) markSynced(state); })
      .catch(() => { /* unreachable: this browser's copy stays unsynced and wins next time */ });
  };

  const sendPending = (keepalive: boolean) => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const state = pending;
    pending = null;
    if (!state || disposed) return;
    if (keepalive) {
      // The page is going: no waiting in line behind a save still in flight.
      void send(state, true);
      return;
    }
    // One at a time, so an older picture can never land after a newer one.
    inflight = inflight.then(() => send(state, false));
  };

  return {
    save(state) {
      if (disposed) return;
      if (opts.user) writeLocalDesktopState(opts.user, { state, synced: false }, storage);
      pending = state;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => sendPending(false), delayMs);
    },
    flush() {
      sendPending(true);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
