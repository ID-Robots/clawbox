/**
 * Per-session model overrides on an OpenClaw 2 agent, applied through the
 * gateway's own API — `sessions.patchMany` with `{ model }` — and never by
 * writing the agent store. The store's `session_nodes` table is trigger-owned
 * by the core (see openclaw-session-store.ts): a row rewritten by anything
 * but the gateway is invalid at the next start, and chat is dead until
 * `openclaw doctor --fix`.
 *
 * What the gateway does with a `model` patch (2026.8.1, sessions-patch.ts +
 * sessions/model-overrides.ts in the core): resolves `<provider>/<model>`
 * against its catalog, writes `providerOverride` / `modelOverride` /
 * `modelOverrideSource: "user"` / `modelOverrideRouteResolution` itself, drops
 * an auth-profile override the new provider cannot use, and folds a sticky
 * `thinkingLevel` the new model cannot honour down to one it can. `model: null`
 * clears the override so the session follows the agent default again. Every
 * field ClawBox's old sweeps wrote by hand is therefore set by the owner of
 * the row, in the shape that owner validates.
 *
 * One consequence worth knowing: when the patched model IS the agent's new
 * default — which it is on both model-switch routes, because they write
 * `agents.defaults.model.primary` first — the core records that by DELETING
 * the per-session override rather than writing one. That reaches the same
 * place the old hand-written sweep aimed for (the session resolves to the new
 * primary), expressed the core's way, which is why nothing here asserts on
 * particular override fields afterwards.
 *
 * Pure: the transport is injected, so the callers (openclaw-config's model
 * sweep, the Local-only toggle) wire the CLI-backed `callGatewayRpc` and the
 * tests wire a fake.
 */

/** One gateway RPC round trip; resolves with the method's result object. */
export type GatewayRpcCall = (
  method: string,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<Record<string, unknown>>;

/** The core's SESSIONS_PATCH_MANY_MAX_TARGETS: a larger `targets` array is rejected outright. */
export const SESSIONS_PATCH_MANY_MAX_TARGETS = 100;

const DEFAULT_RETRY_DELAY_MS = 2_000;

export interface SessionPatchTarget {
  key: string;
  agentId: string;
}

export interface SessionPatchOutcome extends SessionPatchTarget {
  ok: boolean;
  /** The gateway's own words when `ok` is false. */
  error?: string;
  /**
   * With `ok` false: the refusal was transient — the catalog still loading,
   * a gateway that was not reachable — and has already had its one retry
   * here, so a caller with a "try again later" of its own can honour it.
   * False means the answer will not change (a locked selection, an unknown
   * model, a session the gateway does not know), and waiting is pointless.
   */
  retryable?: boolean;
}

export interface PatchSessionModelsOptions {
  call: GatewayRpcCall;
  /** Pause before the one retry of a transient refusal. Default {@link DEFAULT_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  /** Forwarded to `call` unchanged. */
  timeoutMs?: number;
}

/**
 * A row the gateway can patch. Entries without a session id are placeholder
 * aliases the core keeps for a retention window; patching one would give it
 * an id — i.e. create a session — which no model switch means to do.
 */
export function isPatchableSession(entry: Record<string, unknown>): boolean {
  return typeof entry.sessionId === "string" && entry.sessionId.length > 0;
}

/**
 * The `<provider>/<model>` an entry (or a snapshot of one) is pinned to, or
 * null when it carries no complete override — the value to hand back to
 * `sessions.patch` so the session returns to exactly that pin, or to the
 * agent default when it had none.
 */
export function sessionModelRef(entry: Record<string, unknown>): string | null {
  return (
    modelRef(entry.providerOverride, entry.modelOverride) ??
    // The pre-2026.8 spelling, still present on entries the doctor migrated.
    modelRef(entry.modelProvider, entry.model)
  );
}

function modelRef(provider: unknown, model: unknown): string | null {
  if (typeof provider !== "string" || !provider) return null;
  if (typeof model !== "string" || !model) return null;
  return `${provider}/${model}`;
}

/** Map key for one target. Exact by construction: a session key may contain any separator we could pick. */
function outcomeId(target: SessionPatchTarget): string {
  return JSON.stringify([target.agentId, target.key]);
}

function describeError(error: unknown): { message: string; retryable: boolean } {
  // The protocol's ErrorShape is `{ code, message }`; a bare string is
  // accepted too, so a build that flattens it still names its reason.
  const shape: { code?: unknown; message?: unknown } =
    typeof error === "string" ? { message: error } : error && typeof error === "object" ? error : {};
  const message = typeof shape.message === "string" && shape.message ? shape.message : "the gateway refused the patch";
  // "model catalog is still loading; retry in a few seconds" is the one the
  // core documents; it arrives as UNAVAILABLE.
  const retryable = shape.code === "UNAVAILABLE" || /still loading/i.test(message);
  return { message, retryable };
}

async function patchChunk(
  chunk: SessionPatchTarget[],
  model: string | null,
  opts: PatchSessionModelsOptions,
): Promise<Map<string, SessionPatchOutcome>> {
  const results = new Map<string, SessionPatchOutcome>();
  let payload: Record<string, unknown>;
  try {
    payload = await opts.call(
      "sessions.patchMany",
      {
        targets: chunk.map((t) => ({ key: t.key, agentId: t.agentId })),
        patch: { model },
      },
      { timeoutMs: opts.timeoutMs },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const target of chunk) {
      results.set(outcomeId(target), { ...target, ok: false, error: message, retryable: true });
    }
    return results;
  }

  const reported = new Map<string, { ok: boolean; error?: unknown }>();
  const outcomes = Array.isArray(payload.outcomes) ? payload.outcomes : [];
  for (const raw of outcomes) {
    if (!raw || typeof raw !== "object") continue;
    const outcome = raw as { key?: unknown; agentId?: unknown; ok?: unknown; error?: unknown };
    if (typeof outcome.key !== "string") continue;
    // The gateway echoes agentId only when the target named one; every target
    // here does, so a missing echo still resolves through the target's own.
    const agentId =
      typeof outcome.agentId === "string" ? outcome.agentId : chunk.find((t) => t.key === outcome.key)?.agentId;
    if (!agentId) continue;
    reported.set(outcomeId({ key: outcome.key, agentId }), { ok: outcome.ok === true, error: outcome.error });
  }
  if (reported.size === 0) {
    // N indistinguishable per-session lines would hide the real news: the
    // envelope is not the one this code knows. Say so once, with its keys.
    console.error(
      `[session-model] sessions.patchMany answered with no recognisable outcome for any of ${chunk.length} session(s); response keys: ${Object.keys(payload).join(", ") || "(none)"}`,
    );
  }
  for (const target of chunk) {
    const id = outcomeId(target);
    const outcome = reported.get(id);
    if (!outcome) {
      results.set(id, {
        ...target,
        ok: false,
        error: "the gateway reported no outcome for this session",
        retryable: false,
      });
    } else if (outcome.ok) {
      results.set(id, { ...target, ok: true });
    } else {
      const { message, retryable } = describeError(outcome.error);
      results.set(id, { ...target, ok: false, error: message, retryable });
    }
  }
  return results;
}

/** Every target, in gateway-sized calls, keyed by {@link outcomeId}. */
async function patchInChunks(
  targets: SessionPatchTarget[],
  model: string | null,
  opts: PatchSessionModelsOptions,
): Promise<Map<string, SessionPatchOutcome>> {
  const results = new Map<string, SessionPatchOutcome>();
  for (let i = 0; i < targets.length; i += SESSIONS_PATCH_MANY_MAX_TARGETS) {
    const chunk = targets.slice(i, i + SESSIONS_PATCH_MANY_MAX_TARGETS);
    for (const [id, outcome] of await patchChunk(chunk, model, opts)) results.set(id, outcome);
  }
  return results;
}

/**
 * Pin every target session to `model` (`<provider>/<model>`), or clear the
 * pin with null, through `sessions.patchMany`. One outcome per target, in
 * target order; a target the gateway refused (a locked selection, an unknown
 * model, a session that no longer exists) is reported, never forced. A
 * transient refusal — the catalog still loading right after a config change,
 * or a gateway that was not reachable — gets exactly one retry after a pause.
 */
export async function patchSessionModels(
  targets: SessionPatchTarget[],
  model: string | null,
  opts: PatchSessionModelsOptions,
): Promise<SessionPatchOutcome[]> {
  const results = await patchInChunks(targets, model, opts);

  const retry = targets.filter((t) => results.get(outcomeId(t))?.retryable);
  if (retry.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    for (const [id, outcome] of await patchInChunks(retry, model, opts)) results.set(id, outcome);
  }

  // Every target has an entry: patchChunk writes one per target on both paths.
  return targets.map((target) => results.get(outcomeId(target)) as SessionPatchOutcome);
}
