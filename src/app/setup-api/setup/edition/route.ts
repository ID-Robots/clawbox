export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  EDITION_SELECT_STEP,
  SELECT_FOLLOW_TIMEOUT_MS,
  claimEditionSelect,
  editionSelectUnitActive,
  readEditionChoice,
  releaseEditionSelect,
  removeEditionSelectRequest,
  selectInProgress,
  selectPhaseFollower,
  serverStartedAt,
  writeEditionSelectRequest,
} from "@/lib/edition-select";
import { readEditionSource } from "@/lib/edition-source";
import { HARNESSES, isHarness, type Harness } from "@/lib/harness";
import { followRootStep } from "@/lib/root-step-follow";
import { readSetupGateFacts, requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { isUpdateLocked } from "@/lib/update-lock";

/**
 * /setup-api/setup/edition — the first-setup wizard's "Choose your assistant"
 * step on a unified-image box (TASK-1149; reports/clawbox/unified-image-design-2026-09.md §3).
 *
 * GET says whether the wizard has to ask at all: `needed` is true only while
 * the root-owned lock reads `unselected`, or while an activation that already
 * locked the box was cut short (`pending`, which the step can only finish for
 * that same agent). Every box with a fixed edition — every deployed one, every
 * box flashed for a Hermes order — answers `needed: false`, and the wizard
 * goes straight on to the Update step.
 *
 * POST `{edition: "openclaw" | "hermes"}` writes `data/edition-select.env` and
 * runs the `edition_select` root step, streaming NDJSON the way the harness
 * swap does: `{phase}` for each phase, ONE closing `{success, edition,
 * restarting}` or `{error, code}`. The step ends by restarting this server, so
 * a client that loses the stream asks GET until `serverStartedAt` changes.
 *
 * Bootstrap allow-listed (setup-api-gate.ts): it runs between WiFi and the
 * password step, so before any credential exists. Bounded the way
 * `update/run` is — `requireSession({ allowBootstrap: true })` closes it the
 * moment a password exists unless the caller holds the session — and by its
 * own one-shot rule: it refuses once setup is complete and on any box whose
 * lock is not `unselected` (409), so it is never a way to swap a provisioned
 * box's agent. That is Settings → Harness, on the Max plan.
 */

const encoder = new TextEncoder();

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

function emit(controller: ReadableStreamDefaultController<Uint8Array>, payload: Record<string, unknown>) {
  // A cancelled stream refuses further writes; the step itself goes on (a root
  // unit) and the follow has to reach its real end to release the claim.
  try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); } catch { /* client gone */ }
}

export async function GET(request: Request) {
  const unauthorized = await requireSession(request, { allowBootstrap: true });
  if (unauthorized) return unauthorized;

  const choice = readEditionChoice();
  const progress = await selectInProgress();
  return NextResponse.json(
    {
      needed: choice.needed,
      unselected: choice.unselected,
      pending: choice.pending,
      edition: choice.edition,
      hint: choice.hint,
      inProgress: progress.inProgress,
      inProgressTarget: progress.target,
      ...(progress.unknown ? { inProgressUnknown: true } : {}),
      serverStartedAt: serverStartedAt(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const unauthorized = await requireSession(request, { allowBootstrap: true });
  if (unauthorized) return unauthorized;
  if (!isSameOriginRequest(request)) {
    return refuse(403, "cross_origin", "The assistant can only be chosen from this ClawBox's own setup page.");
  }

  let target: Harness;
  try {
    const parsed: unknown = await request.json();
    const candidate = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { edition?: unknown }).edition
      : undefined;
    if (!isHarness(candidate)) {
      return refuse(400, "bad_body", "edition must be 'openclaw' or 'hermes'.");
    }
    target = candidate;
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }

  if (readSetupGateFacts().setupComplete) {
    return refuse(409, "setup_complete", "Setup is already complete. The assistant can be changed in Settings → Harness.");
  }
  const choice = readEditionChoice();
  if (!choice.needed) {
    const name = choice.edition === "openclaw" || choice.edition === "hermes" ? HARNESSES[choice.edition].label : null;
    return refuse(409, "already_chosen", name ? `This box already runs ${name}.` : "This box's assistant is already set.");
  }
  if (choice.pending && choice.pending !== target) {
    return refuse(
      409,
      "pending_other",
      `This box is already being set up with ${HARNESSES[choice.pending].label}. Finish that first.`,
    );
  }

  let updating = false;
  try {
    updating = await isUpdateLocked();
  } catch {
    updating = false;
  }
  if (updating) {
    return refuse(409, "update_in_progress", "An update is running on this box. Wait for it to finish, then try again.");
  }

  const claim = await claimEditionSelect(target);
  if (claim === "unknown") {
    return refuse(503, "unit_unknown", "Could not check whether the assistant is already being set up. Try again in a moment.");
  }
  if (claim === "busy") {
    return refuse(409, "busy", "The assistant is already being set up.");
  }

  try {
    await writeEditionSelectRequest(target);
  } catch (err) {
    releaseEditionSelect();
    console.error("[setup/edition] could not stage the request:", err instanceof Error ? err.message : err);
    return refuse(500, "request_write_failed", "The choice could not be saved on this device.");
  }

  const name = HARNESSES[target].label;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        emit(controller, { phase: "request" });
        // Before the follow starts the unit, so the phase scans' window holds
        // everything this run writes.
        const sinceMs = Date.now();
        const phases = selectPhaseFollower((phase) => emit(controller, { phase }), sinceMs);
        const result = await followRootStep(EDITION_SELECT_STEP, {
          timeoutMs: SELECT_FOLLOW_TIMEOUT_MS,
          label: `setting up ${name}`,
          onStatus: (line) => { phases.onLine(line); },
        });
        await phases.settled();

        if (!result.ok) {
          const unit = await editionSelectUnitActive();
          if (unit !== false) {
            // The follow gave up on a unit that is still going (or systemd
            // could not say): the request stays for the step, and GET keeps
            // reporting it from the unit's state.
            emit(controller, {
              error: `Setting up ${name} is still running on this box.`,
              code: "still_running",
            });
            return;
          }
          await removeEditionSelectRequest();
          const after = readEditionChoice();
          emit(controller, {
            error: result.error || `Setting up ${name} did not finish.`,
            code: "select_failed",
            // Where the box is now: still undecided (choose again, either
            // agent), or locked to the target with the job half done (retry
            // finishes THAT agent).
            unselected: after.unselected,
            pending: after.pending,
          });
          return;
        }

        // The step's exit is not the proof; the lock and the marker are.
        const source = readEditionSource();
        const after = readEditionChoice();
        if (source.unselected || source.defaulted || source.edition !== target) {
          await removeEditionSelectRequest();
          emit(controller, {
            error: `The setup step finished, but this box is still not set up for ${name}.`,
            code: "lock_unchanged",
            unselected: after.unselected,
            pending: after.pending,
          });
          return;
        }
        if (after.pending) {
          emit(controller, {
            error: `${name} was chosen, but its setup did not finish.`,
            code: "select_incomplete",
            unselected: false,
            pending: after.pending,
          });
          return;
        }
        emit(controller, { phase: "done" });
        emit(controller, { success: true, edition: target, restarting: true });
      } catch (err) {
        const unit = await editionSelectUnitActive();
        if (unit !== false) {
          emit(controller, { error: `Setting up ${name} is still running on this box.`, code: "still_running" });
        } else {
          await removeEditionSelectRequest();
          const after = readEditionChoice();
          emit(controller, {
            error: err instanceof Error ? err.message : `Setting up ${name} failed.`,
            code: "select_failed",
            unselected: after.unselected,
            pending: after.pending,
          });
        }
      } finally {
        releaseEditionSelect();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}
