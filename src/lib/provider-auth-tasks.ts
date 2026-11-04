/**
 * Connecting an AI provider, and signing the box out of one, as BACKGROUND
 * TASKS of the web server (src/lib/background-tasks.ts) — TASK-2148.
 *
 * WHY. Both used to live in the Settings window that started them. The work on
 * the box mostly ran on when the window closed — the configure route never
 * read its request's signal, the sign-out was one awaited call — but the
 * progress went with the window, and nothing could ask for it again: closed
 * mid-way and reopened, Settings drew the provider "not connected" (or still
 * connected after a sign-out) while the box was finishing the job, and only a
 * page refresh told the truth.
 *
 * Now the box's half of each is a job of the box — built on the shared helper
 * for non-instant Settings actions (src/lib/settings-jobs.ts), with the same
 * record, corner card and re-attach the Local AI installs have (TASK-2056):
 *
 *  - SIGN-IN (`PROVIDER_SIGN_IN_KIND`): what follows the owner's own half (a
 *    pasted key, an approved device code, an OAuth exchange). Save it — the
 *    configure route's whole save, or ClawBox AI's link on Hermes — then wait
 *    out the assistant's restart the save started, then read the provider's
 *    row back. Its end says whether the row reads connected.
 *  - SIGN-OUT (`PROVIDER_SIGN_OUT_KIND`): `signOutOfProvider` (which removes
 *    and reads back every copy itself), then the restart it started, then the
 *    row read back — and on Hermes, Hermes' own list of who is signed in: a
 *    provider it still lists signed in fails the task (`still_signed_in`).
 *
 * ONE PROVIDER SIGN-IN OR SIGN-OUT AT A TIME. Both kinds share a group: every
 * one rewrites the harness's credentials and restarts it. Asked again for the
 * same thing while it runs — a double click, a second tab, a reopened Settings
 * — the running task is answered, never a second one started. Asked for
 * anything else, the caller is refused with the running one named — a second
 * sign-in of the SAME provider with another key or model included, which would
 * otherwise follow the first and report a save that never happened (the ask is
 * compared by a fingerprint, `ProviderAuthMeta.ask`). The Local AI routes that
 * configure the harness in-process (the llama.cpp install, the harness swap)
 * are not provider changes and are not in this group.
 *
 * Not cancellable: a sign-in half-saved or a sign-out half-removed is worse
 * than either finished, and neither has a safe stop.
 *
 * SERVER ONLY.
 */

import { NextResponse } from "next/server";
import { humanizeApiError } from "@/lib/api-error-message";
import {
  BackgroundTaskFailure,
  type BackgroundTaskContext,
  type BackgroundTaskView,
} from "@/lib/background-tasks";
import { PROVIDER_AUTH_GROUP, PROVIDER_SIGN_IN_KIND, PROVIDER_SIGN_OUT_KIND } from "@/lib/background-task-kinds";
import { waitForGatewayBack } from "@/lib/gateway-hot-apply";
import type { Harness } from "@/lib/harness";
import type { ProviderConnectionState } from "@/lib/provider-status";
import {
  askFingerprint,
  backgroundAskOf,
  jobRequest,
  outcomeOf,
  runningSettingsJob,
  settingsJobMetaOf,
  settingsJobStartResponse,
  startSettingsJob,
  type JobOutcome,
  type SettingsJobStart,
  type SettingsJobStep,
} from "@/lib/settings-jobs";

// The shared helper's pieces a provider route reaches for, under the names
// the provider routes use.
export { askFingerprint, backgroundAskOf };
export const saveRequest = jobRequest;
export const saveOutcomeOf = outcomeOf;

export type ProviderAuthAction = "sign-in" | "sign-out";

/** A provider job's meta (src/lib/settings-jobs.ts), read as the provider it is about and which way. */
export interface ProviderAuthMeta {
  /** The provider's row id, as the provider list keys it (the job's `subject`). */
  provider: string;
  action: ProviderAuthAction;
  /** The row's name, for the sentences about it. */
  label: string;
  /** The ask's fingerprint (`SettingsJobMeta.ask`). */
  ask?: string;
}

export type ProviderAuthStart = SettingsJobStart;

/**
 * How long a task waits for the assistant to come back from the restart its
 * save or sign-out started — what Settings used to wait in the window
 * (src/lib/wait-for-gateway.ts). A gateway slower than this is not a failure:
 * the change landed, and the task says it is still coming back.
 */
export const PROVIDER_GATEWAY_WAIT_MS = 180_000;
/** How long the read-back waits out a row the box is still probing. */
const VERIFY_WAIT_MS = 30_000;
const VERIFY_POLL_MS = 2_000;

/** Said when the assistant was not back within the wait. */
export const ASSISTANT_RESTARTING_NOTICE =
  "Saved. The assistant is restarting to apply it and will be back in about a minute.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The meta of a provider job, or null for any other task. */
export function providerAuthMetaOf(task: Pick<BackgroundTaskView, "kind" | "meta">): ProviderAuthMeta | null {
  if (task.kind !== PROVIDER_SIGN_IN_KIND && task.kind !== PROVIDER_SIGN_OUT_KIND) return null;
  const meta = settingsJobMetaOf(task);
  if (!meta) return null;
  return {
    provider: meta.subject,
    action: task.kind === PROVIDER_SIGN_IN_KIND ? "sign-in" : "sign-out",
    label: meta.label,
    ...(meta.ask ? { ask: meta.ask } : {}),
  };
}

/** The provider change the box is running now, if any. */
export function runningProviderAuthTask(): BackgroundTaskView | null {
  return runningSettingsJob(PROVIDER_AUTH_GROUP);
}

/** A provider job, as the shared helper starts one (see its header for "one at a time"). */
function startProviderAuthTask(
  meta: { provider: string; action: ProviderAuthAction; label: string; ask?: Record<string, unknown> },
  spec: {
    title: string;
    status: string;
    steps: SettingsJobStep[];
    run: (ctx: BackgroundTaskContext) => Promise<Record<string, unknown>>;
  },
): ProviderAuthStart {
  return startSettingsJob({
    kind: meta.action === "sign-in" ? PROVIDER_SIGN_IN_KIND : PROVIDER_SIGN_OUT_KIND,
    group: PROVIDER_AUTH_GROUP,
    subject: meta.provider,
    action: meta.action,
    label: meta.label,
    ...(meta.ask ? { ask: meta.ask } : {}),
    ...spec,
  });
}

/** The sentence a refusal names the running change in; `next` is what the owner does about it. */
export function providerAuthBusyMessage(running: BackgroundTaskView, next = "Try again when it has finished."): string {
  const meta = providerAuthMetaOf(running);
  if (!meta) return `Another AI provider change is running on this box. ${next}`;
  return meta.action === "sign-in"
    ? `${meta.label} is being connected right now. ${next}`
    : `${meta.label} is being signed out right now. ${next}`;
}

/**
 * The HTTP answer to a start: 202 with the task to follow (`started: false`
 * when it is the one already running for the same ask), or 409
 * `provider_change_running` naming the other change that runs.
 */
export function providerAuthStartResponse(start: ProviderAuthStart): NextResponse {
  return settingsJobStartResponse(start, {
    code: "provider_change_running",
    message: (running) => providerAuthBusyMessage(running),
  });
}

/**
 * The provider's row as the list will read it once the box has settled: the
 * row's state, `absent` when the box lists no such row, or `unknown` when the
 * status could not be read. A row still being probed is waited out.
 */
async function settledRowState(provider: string): Promise<ProviderConnectionState | "absent"> {
  const { readProviderStatus } = await import("@/lib/provider-status");
  const deadline = Date.now() + VERIFY_WAIT_MS;
  for (;;) {
    const summary = await readProviderStatus().catch(() => null);
    const state: ProviderConnectionState | "absent" = !summary || summary.degraded
      ? "unknown"
      : summary.providers.find((row) => row.id === provider)?.state ?? "absent";
    if ((state !== "checking" && state !== "unknown") || Date.now() >= deadline) return state;
    await sleep(VERIFY_POLL_MS);
  }
}

/**
 * Hermes' own word on whether `provider` is still signed in (see
 * `hermesStillSignedIn`), waited out while its dashboard comes back from the
 * sign-out's restart; `null` when it had not answered by `waitMs`.
 */
async function settledHermesSignIn(provider: string, waitMs: number): Promise<boolean | null> {
  const { hermesStillSignedIn } = await import("@/lib/provider-sign-out-hermes");
  const deadline = Date.now() + waitMs;
  for (;;) {
    const signedIn = await hermesStillSignedIn(provider).catch(() => null);
    if (signedIn !== null || Date.now() >= deadline) return signedIn;
    await sleep(VERIFY_POLL_MS);
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** What a save answered, as the configure route answers it (`JobOutcome`). */
export type ProviderSaveOutcome = JobOutcome;

export type ProviderSignInEnd =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

export interface ProviderSignInSpec {
  /** The provider's row id. */
  provider: string;
  label: string;
  /** What the save was asked with (see `ProviderAuthMeta.ask`); absent, any sign-in of the provider is the same ask. */
  ask?: Record<string, unknown>;
  /** The save itself. Throw (or answer `ok: false`) to fail the task. */
  save: (ctx: BackgroundTaskContext) => Promise<ProviderSaveOutcome>;
  /**
   * Told how it ended, before the task is — the ClawBox AI device login keeps
   * its own session record (src/lib/clawai-connect.ts) beside the task, for
   * the device-login card that polls it. Never fails the task.
   */
  onEnd?: (end: ProviderSignInEnd) => Promise<void> | void;
}

const SIGN_IN_STEPS = [
  { id: "save", label: "Save the sign-in on the box", weight: 3 },
  { id: "restart", label: "Restart the assistant", weight: 2 },
  { id: "verify", label: "Check the connection", weight: 1 },
];

/**
 * Connect a provider as a task (see the file header): `save`, then the
 * restart it started, then the row read back. The task's result is the
 * save's own answer with the restart already waited out (`gatewayRestarting:
 * false`, its notice folded into `warning` when the assistant was not back),
 * plus `status` — the sentence the card and Settings end on — and `verified`.
 */
export function startProviderSignInTask(spec: ProviderSignInSpec): ProviderAuthStart {
  const { provider, label } = spec;
  return startProviderAuthTask({ provider, action: "sign-in", label, ...(spec.ask ? { ask: spec.ask } : {}) }, {
    title: `Connecting ${label}`,
    status: `Setting up ${label}…`,
    steps: SIGN_IN_STEPS,
    run: async (ctx) => {
      const end = async (outcome: ProviderSignInEnd) => {
        try {
          await spec.onEnd?.(outcome);
        } catch (err) {
          console.warn("[provider-auth] the sign-in's own record could not be updated:", err instanceof Error ? err.message : err);
        }
      };
      try {
        ctx.step("save", `Saving the ${label} sign-in on the box…`);
        const saved = await spec.save(ctx);
        if (!saved.ok) {
          throw new BackgroundTaskFailure(
            saved.message ?? humanizeApiError(saved.body, `${label} could not be connected.`),
            { ...saved.body, ...(saved.httpStatus ? { httpStatus: saved.httpStatus } : {}) },
          );
        }
        let warning = text(saved.body.warning);
        if (saved.body.gatewayRestarting === true) {
          ctx.step("restart", "Restarting the assistant to use the new sign-in…");
          if (!(await waitForGatewayBack(PROVIDER_GATEWAY_WAIT_MS).catch(() => false))) {
            warning = [warning, text(saved.body.restartingNotice) ?? ASSISTANT_RESTARTING_NOTICE].filter(Boolean).join(" ");
          }
        }
        ctx.step("verify", `Checking that ${label} is connected…`);
        const state = await settledRowState(provider);
        const verified = state === "connected";
        const result: Record<string, unknown> = {
          ...saved.body,
          success: true,
          gatewayRestarting: false,
          status: verified ? `Connected to ${label}.` : `Saved the ${label} sign-in.`,
          verified,
        };
        delete result.restartingNotice;
        if (warning) result.warning = warning;
        else delete result.warning;
        await end({ ok: true, result });
        return result;
      } catch (err) {
        const message = err instanceof Error && err.message ? err.message : `${label} could not be connected.`;
        await end({ ok: false, error: message });
        throw err;
      }
    },
  });
}

/** What `signOutOfProvider` answers (src/lib/provider-sign-out.ts), as the task needs it. */
export type ProviderSignOutRun = (provider: string) => Promise<
  | { ok: true; changed: boolean; gatewayRestarting: boolean }
  | { ok: false; kind: string; error: string }
>;

const SIGN_OUT_STEPS = [
  { id: "remove", label: "Remove the sign-in from the box", weight: 3 },
  { id: "restart", label: "Restart the assistant", weight: 2 },
  { id: "verify", label: "Check it is signed out", weight: 1 },
];

/**
 * Sign out of a provider as a task (see the file header). `harness` is the one
 * the sign-out runs on: only OpenClaw's restart is a gateway this task can
 * wait for — Hermes' own restart is done inside the sign-out's apply, and its
 * dashboard coming back is waited out by the verify step, which asks it.
 */
export function startProviderSignOutTask(spec: {
  provider: string;
  label: string;
  harness: Harness;
  signOut: ProviderSignOutRun;
}): ProviderAuthStart {
  const { provider, label } = spec;
  return startProviderAuthTask({ provider, action: "sign-out", label }, {
    title: `Signing out of ${label}`,
    status: `Signing out of ${label}…`,
    steps: SIGN_OUT_STEPS,
    run: async (ctx) => {
      ctx.step("remove", `Removing the ${label} sign-in from the box…`);
      const outcome = await spec.signOut(provider);
      if (!outcome.ok) throw new BackgroundTaskFailure(outcome.error, { kind: outcome.kind });
      let note: string | null = null;
      if (outcome.gatewayRestarting && spec.harness === "openclaw") {
        ctx.step("restart", "Restarting the assistant to let go of the sign-in…");
        if (!(await waitForGatewayBack(PROVIDER_GATEWAY_WAIT_MS).catch(() => false))) {
          note = "The assistant is still restarting and will be back in about a minute.";
        }
      }
      ctx.step("verify", `Checking that ${label} is signed out…`);
      const state = await settledRowState(provider);
      // On Hermes the files being clean is not the end of it: Hermes keeps its
      // own list of who is signed in (GET /setup-api/hermes/models), and a
      // sign-out it still lists signed in did not happen, whatever was removed.
      let hermesSignedIn: boolean | null = null;
      if (spec.harness === "hermes") {
        hermesSignedIn = await settledHermesSignIn(provider, outcome.gatewayRestarting ? PROVIDER_GATEWAY_WAIT_MS : VERIFY_WAIT_MS);
        if (hermesSignedIn === true) {
          throw new BackgroundTaskFailure(
            `${label} was not signed out: Hermes still lists it as signed in. Try again; if it stays, restart the box and sign out again.`,
            { kind: "still_signed_in" },
          );
        }
        if (hermesSignedIn === null) {
          note = [note, `Hermes did not answer in time to confirm that ${label} is signed out; Settings shows it once Hermes is back.`].filter(Boolean).join(" ");
        }
      }
      return {
        signedOut: true,
        provider,
        changed: outcome.changed,
        gatewayRestarting: false,
        status: `Signed out of ${label}.`,
        // The sign-out read every copy back itself; the row is what the list
        // will say, which a status cache can still lag behind for a moment —
        // and on Hermes, Hermes' own list said it too.
        verified: state !== "connected" && (spec.harness !== "hermes" || hermesSignedIn === false),
        ...(note ? { warning: note } : {}),
      };
    },
  });
}
