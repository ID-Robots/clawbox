/**
 * The owner-notice ring: how the server tells every open desktop that
 * something happened — a coding run finished, a web app got its icon, "an
 * email is waiting for you", the `ui_notify` toast.
 *
 * It used to be ONE KV slot, `ui:pending-action`, and the first desktop to
 * poll it deleted it before acting on it. With a laptop and a phone open (or
 * the remote-control tunnel polling alongside), every other screen missed the
 * notice — on a real box the owner's two desktops each received none of four
 * finish cards, because a headless client kept winning the race.
 *
 * `ui:pending-actions` is instead a JSON array of `{ id, ts, ...action }`,
 * newest last, that readers NEVER delete or rewrite. Each desktop remembers
 * the timestamp it has seen up to and the ids it has processed, and acts on
 * what is newer; the coding-finish card is deduped by run id and
 * `register_webapp` is idempotent, so a replay is harmless. The WRITER keeps
 * the ring small: entries older than a minute are dropped (a desktop that was
 * not open within a minute has nothing to act on) and at most twenty are
 * kept.
 *
 * Every in-process writer goes through `pushPendingAction`. Writers in other
 * processes — the MCP tools and `clawbox notify` — post the legacy key to
 * /setup-api/kv, and that route folds the value into this ring, so the ring
 * is the only thing ever stored.
 */

import { randomUUID } from "crypto";
import { kvGet, kvSet } from "@/lib/kv-store";

export const PENDING_ACTIONS_KEY = "ui:pending-actions";
export const PENDING_ACTIONS_MAX = 20;
export const PENDING_ACTION_TTL_MS = 60_000;

export interface PendingActionEntry {
  id: string;
  ts: number;
  [field: string]: unknown;
}

function readRing(): PendingActionEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(kvGet(PENDING_ACTIONS_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is PendingActionEntry =>
      typeof e === "object" && e !== null && typeof (e as PendingActionEntry).id === "string"
      && typeof (e as PendingActionEntry).ts === "number",
  );
}

function appendNow(action: Record<string, unknown>, id: string | undefined): PendingActionEntry {
  const now = Date.now();
  const entry: PendingActionEntry = { ...action, id: id ?? randomUUID(), ts: now };
  const ring = readRing()
    // A repeated id is the same notice again (a re-nudge for the same app);
    // the newer one is the one to keep.
    .filter((e) => e.id !== entry.id && e.ts >= now - PENDING_ACTION_TTL_MS);
  ring.push(entry);
  kvSet(PENDING_ACTIONS_KEY, JSON.stringify(ring.slice(-PENDING_ACTIONS_MAX)));
  return entry;
}

// The store is synchronous today, so one push cannot interleave with another
// in this process; the chain keeps that true should kv-store ever grow an
// await, at the price of one promise.
let chain: Promise<unknown> = Promise.resolve();

/**
 * Append one action to the ring. `id` should be given when the notice has a
 * natural identity (`coding:<runId>`), so a desktop can recognise it across
 * polls; anything else gets a random one. Resolves with the entry as written.
 */
export function pushPendingAction(action: Record<string, unknown>, id?: string): Promise<PendingActionEntry> {
  const next = chain.then(() => appendNow(action, id));
  chain = next.catch(() => undefined);
  return next;
}
