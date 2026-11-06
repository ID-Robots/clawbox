/**
 * One change to WHICH provider answers the chat, or to whether a provider is
 * signed in, at a time — box-wide.
 *
 * The provider sign-out (src/lib/provider-sign-out.ts) refuses the default's,
 * and that check is only worth anything if the default cannot move between it
 * and the credential's removal: a second browser making the same provider the
 * default in that window would leave the chat on a provider with nothing to
 * sign in with. So the sign-out holds this from its default check until its
 * removal has landed, and the two writers of the default take it too —
 * `/setup-api/chat/model` on OpenClaw and `/setup-api/hermes/models` on Hermes
 * (`/setup-api/providers/default` calls one of those in-process, and the box's
 * own automatic switches go through the first). A writer that waits behind a
 * sign-out then reads the box as it is afterwards: the provider signed out.
 *
 * NOT re-entrant, and nothing that holds it calls another holder: the sign-out
 * writes no default, and neither writer signs anything out.
 *
 * Kept in `processStore`: every route bundle carries its own copy of this
 * module, and two chains would be no lock at all.
 */

import { processStore } from "@/lib/process-store";

const state = processStore("clawbox.provider-change-lock", () => ({ chain: Promise.resolve() as Promise<void> }));

/** Run `fn` once every change queued before it has finished; its own result, or its own error. */
export function withProviderChangeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = state.chain.then(fn, fn);
  // Never a rejected head: the next change must not inherit this one's failure.
  state.chain = run.then(() => undefined, () => undefined);
  return run;
}
