export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getActiveHarness,
  getEditionSource,
  isHarness,
  isSingleHarnessEdition,
  HARNESSES,
  type Harness,
} from "@/lib/harness";
import { refreshHarnessToolsIfSwitched } from "@/lib/harness-mcp-refresh";
import {
  HARNESS_SWAP_BUSINESS_PLAN_REQUIRED,
  HARNESS_SWAP_STEP,
  SWAP_FOLLOW_TIMEOUT_MS,
  carryOverAfterSwap,
  claimSwap,
  harnessSwapUnitActive,
  preflightSwap,
  readSwapPlan,
  releaseSwap,
  removeSwapRequest,
  swapAllowed,
  swapInProgress,
  swapPhaseFollower,
  swapPhaseStatus,
  swapTargetFor,
  writeSwapRequest,
} from "@/lib/harness-swap";
import { hasOwnerSession } from "@/lib/owner-session";
import { followRootStep } from "@/lib/root-step-follow";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/harness/swap — change a locked box's agent harness (OpenClaw ↔
 * Hermes). Settings → Harness's "Switch to …" button; owner's ask 2026-09-07.
 *
 * GET is what the card draws itself from: which edition, which way a swap
 * would go, whether one is running, and the plan beside the Business-plan
 * gate. POST runs the `harness_swap` root step and streams it the way
 * `tts/install` streams the voice install — NDJSON `{status}` lines as the
 * journal moves, `{phase, status}` for the step's own markers (read out of the
 * unit's journal, since the follow forwards only its last line), and ONE
 * closing `{success, active, reload, notes}` or `{error, code}`. A failure
 * AFTER the lock flipped carries `active`, `reload: true` and `lockFlipped:
 * true` beside the error, because the box is the target edition by then and
 * the desktop has to land on it whatever the modal says. See
 * src/lib/harness-swap.ts for the boundary and the carry-over.
 */

const encoder = new TextEncoder();

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status });
}

function emit(controller: ReadableStreamDefaultController<Uint8Array>, payload: Record<string, unknown>) {
  // A cancelled stream refuses further writes; the swap itself goes on (a
  // root unit), and the follow has to reach its real end to release the claim.
  try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); } catch { /* client gone */ }
}

export async function GET() {
  const source = getEditionSource();
  const target = swapTargetFor(source);
  const [active, plan, progress] = await Promise.all([getActiveHarness(), readSwapPlan(), swapInProgress()]);
  return NextResponse.json({
    edition: source.edition,
    active,
    locked: isSingleHarnessEdition(),
    target,
    swappable: target !== null,
    inProgress: progress.inProgress,
    inProgressTarget: progress.target,
    ...(progress.unknown ? { inProgressUnknown: true } : {}),
    plan,
    businessPlanRequired: HARNESS_SWAP_BUSINESS_PLAN_REQUIRED,
    allowed: swapAllowed(plan),
  });
}

export async function POST(req: Request) {
  // OWNER ONLY, both halves. The middleware admits the MCP bearer here like
  // everywhere under /setup-api, and re-installing the box's agent as root is
  // the person's decision — not the agent's, and not another site's page
  // riding the owner's cookie.
  if (!(await hasOwnerSession(req))) {
    return refuse(403, "owner_only", "Changing the harness needs a signed-in browser session.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "The harness can only be changed from this ClawBox's own pages.");
  }

  let harness: Harness;
  try {
    const parsed: unknown = await req.json();
    const candidate = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { harness?: unknown }).harness
      : undefined;
    if (!isHarness(candidate)) {
      return refuse(400, "bad_body", "harness must be 'openclaw' or 'hermes'.");
    }
    harness = candidate;
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }

  const source = getEditionSource();
  const target = swapTargetFor(source);
  if (!target) {
    return refuse(409, "not_swappable", "This box's edition cannot be swapped from here.");
  }
  if (harness === source.edition) {
    return refuse(409, "same_harness", `This box already runs ${HARNESSES[harness].label}.`);
  }
  if (harness !== target) {
    return refuse(409, "not_swappable", `This box can only swap to ${HARNESSES[target].label}.`);
  }

  const plan = await readSwapPlan();
  if (!swapAllowed(plan)) {
    return refuse(409, "plan_required", "Changing the harness is part of the Business plan.");
  }

  const claim = await claimSwap(target);
  if (claim === "unknown") {
    return refuse(503, "unit_unknown", "Could not ask systemd whether a harness swap is already running. Try again in a moment.");
  }
  if (claim === "busy") {
    return refuse(409, "busy", "A harness swap is already in progress.");
  }

  const name = HARNESSES[target].label;

  // The follow gave up, or threw, on a unit that is still going — or on one

  // systemd could not be asked about, which the sentence says as such.

  const stillRunning = (unit: boolean | null) =>

    unit === null

      ? `Could not tell whether the swap to ${name} is still running on this box. Settings → Harness shows it as in progress while it is; the desktop reloads onto ${name} once it has ended.`

      : `The swap to ${name} is still running on this box. Settings → Harness shows it as in progress until it ends; the desktop reloads onto ${name} once it has.`;
  let previous: Harness;
  try {
    const refusal = await preflightSwap(target);
    if (refusal) {
      releaseSwap();
      return refuse(refusal.status, refusal.code, refusal.error);
    }
    // Read BEFORE the step: afterwards the lock says the target, and the tool
    // refresh at the end needs the harness this swap replaced.
    previous = await getActiveHarness();
    await writeSwapRequest(target);
  } catch (err) {
    releaseSwap();
    console.error("[harness/swap] could not stage the swap request:", err instanceof Error ? err.message : err);
    return refuse(500, "request_write_failed", "The swap request could not be saved on this device.");
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const say = (status: string) => emit(controller, { status });
      const carry = async () => {
        emit(controller, { phase: "carry", status: swapPhaseStatus("carry", target) });
        return carryOverAfterSwap(target, say);
      };
      try {
        emit(controller, { phase: "request", status: swapPhaseStatus("request", target) });
        const phases = swapPhaseFollower((phase) => emit(controller, { phase, status: swapPhaseStatus(phase, target) }));
        const result = await followRootStep(HARNESS_SWAP_STEP, {
          timeoutMs: SWAP_FOLLOW_TIMEOUT_MS,
          label: "the harness swap",
          onStatus: (line) => {
            // The step's own `done` marks the END OF THE ROOT STEP, not of the
            // swap: the carry-over still has to run, so it is forwarded as a
            // plain line and the route's own `done` closes the list below. A
            // plain line is said BEHIND the scan it started, so the phase it
            // belongs to is on the stream before it is.
            const phase = phases.onLine(line);
            if (!phase || phase === "done") void phases.settled().then(() => say(line));
          },
        });
        // A scan the last line started must not announce a phase after the
        // lines that follow the step.
        await phases.settled();
        if (!result.ok) {
          const error = result.error || `The swap to ${name} did not finish.`;
          // The follow's deadline is the unit's own, so `!ok` over a unit
          // that is still active is the follow giving up, not the step: the
          // request stays for the step to read, and GET keeps reporting the
          // swap from the unit's state.
          const unit = await harnessSwapUnitActive();
          if (unit !== false) {
            // Running — or systemd could not say, which is not "stopped":
            // the request stays for the step (its hour is the safety net).
            emit(controller, { error: stillRunning(unit), code: "still_running" });
            return;
          }
          const after = getEditionSource();
          if (after.edition === target && !after.defaulted) {
            // Provisioning failed AFTER the lock flipped: the box IS the
            // target edition, with the step's sentence naming what is
            // missing. The desktop has to land on it whatever the modal
            // says, and the credentials are carried so they are not the
            // second thing missing — a note, never a claim of success.
            const notes = await carry();
            await removeSwapRequest();
            emit(controller, { error, code: "swap_failed", active: target, reload: true, lockFlipped: true, notes });
            return;
          }
          // The step leaves the file for the route on a failure after the lock
          // flipped; a stale request must not be a standing instruction.
          await removeSwapRequest();
          emit(controller, { error, code: "swap_failed" });
          return;
        }
        // The step's exit is not the proof; the lock is. `getEditionSource`
        // re-reads the root-owned file when its mtime moved, so a step that
        // returned 0 without re-baking it is reported, never dressed as done.
        const after = getEditionSource();
        if (after.edition !== target) {
          await removeSwapRequest();
          emit(controller, {
            error: `The root step finished, but the edition lock still says ${after.edition}. See the ClawBox service log.`,
            code: "lock_unchanged",
          });
          return;
        }
        const notes = await carry();
        // The refresh reloads HERMES' MCP children — the only harness with a
        // dashboard to ask. On the way to Hermes that is the dashboard the
        // step just started; on the way to OpenClaw it is the one the step
        // just tore down, and asking it only logs a refusal under the
        // runtime switcher's tag. OpenClaw's own child is per session and
        // self-heals (harness-mcp-refresh.ts).
        if (target === "hermes") await refreshHarnessToolsIfSwitched(previous, target);
        emit(controller, { phase: "done", status: swapPhaseStatus("done", target) });
        emit(controller, { success: true, active: target, reload: true, notes });
      } catch (err) {
        const message = err instanceof Error ? err.message : `The swap to ${name} failed.`;
        // The unit outlives a follow that threw: the request the step still
        // reads must not be pulled out from under it, and GET keeps reporting
        // the swap from the unit's state until it ends.
        const unit = await harnessSwapUnitActive();
        if (unit !== false) {
          emit(controller, { error: stillRunning(unit), code: "still_running" });
        } else {
          await removeSwapRequest();
          const after = getEditionSource();
          // A throw AFTER the lock flipped (the carry-over, the refresh): the
          // box IS the target edition and the desktop has to land on it.
          if (after.edition === target && !after.defaulted) {
            emit(controller, { error: message, code: "swap_failed", active: target, reload: true, lockFlipped: true, notes: [] });
          } else {
            emit(controller, { error: message, code: "swap_failed" });
          }
        }
      } finally {
        releaseSwap();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
