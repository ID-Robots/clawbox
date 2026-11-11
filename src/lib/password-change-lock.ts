/**
 * A ClawBox user's own password change, as the sign-in sees it (TASK-2435).
 *
 * Settings → Account ends every other session BEFORE it changes the password
 * (src/app/setup-api/users/me/password/route.ts): a new session version, then
 * chpasswd. Between the two the OLD password still works, so a sign-in in that
 * window would be issued a cookie under the NEW version that outlives the
 * change. So the two routes share this: while a change is in progress the
 * sign-in is refused, and a sign-in that began before a change and finishes
 * after it (the `epoch` moved) is refused as well — it was checked against a
 * password that may no longer be the account's.
 *
 * In the process store, not module state: route handlers can be compiled into
 * separate module instances inside the one web server (src/lib/process-store.ts).
 */

import { processStore } from "@/lib/process-store";

interface ChangeState {
  inProgress: Set<string>;
  epochs: Map<string, number>;
}

function state(): ChangeState {
  return processStore("password-change-lock", () => ({ inProgress: new Set<string>(), epochs: new Map<string, number>() }));
}

function bump(username: string): void {
  const s = state();
  s.epochs.set(username, (s.epochs.get(username) ?? 0) + 1);
}

/** Start a change for `username`; false when one is already in progress (one at a time per account). */
export function beginPasswordChange(username: string): boolean {
  const s = state();
  if (s.inProgress.has(username)) return false;
  s.inProgress.add(username);
  bump(username);
  return true;
}

/** The change is over, whatever it came to. */
export function endPasswordChange(username: string): void {
  state().inProgress.delete(username);
  bump(username);
}

export function passwordChangeInProgress(username: string): boolean {
  return state().inProgress.has(username);
}

/** Moves whenever a change begins or ends: a sign-in compares it before and after its own check. */
export function passwordChangeEpoch(username: string): number {
  return state().epochs.get(username) ?? 0;
}
