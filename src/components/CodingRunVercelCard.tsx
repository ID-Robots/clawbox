"use client";

/**
 * The deployment a run's push caused, on the run's own page.
 *
 * WHY IT IS A COMPONENT AND NOT ANOTHER LOCAL HELPER IN CodingAgentApp.tsx. It
 * is the only card in that app that PERFORMS an irreversible outward-facing
 * action — promoting a build to production — and that deserves a file whose
 * whole content can be read in one go, with its own test. The chip (a phase and
 * a colour) stays inline with the run's other chips, the way `prChip` does.
 *
 * IT IMPORTS ONLY ./vercel-state, never ./vercel: this is a client component,
 * and the module with the REST client reaches the secret store, `fs` and
 * `crypto` through ./vercel-link. Pulling that into the browser bundle does not
 * resolve and the build fails outright — the same reason ./coding-pr-state
 * exists.
 */

import { useState } from "react";
import { BTN_DANGER, BTN_SECONDARY, CARD_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import type { VercelPhase, VercelState } from "@/lib/vercel-state";

/** One key per phase: what the owner is told has happened. */
const PHASE_KEY: Record<VercelPhase, string> = {
  looking: "codingAgent.deployLooking",
  building: "codingAgent.deployBuilding",
  ready: "codingAgent.deployReady",
  failed: "codingAgent.deployFailed",
  canceled: "codingAgent.deployCanceled",
  abandoned: "codingAgent.deployAbandoned",
};

/**
 * The colour of the phase.
 *
 * `abandoned` is AMBER and not red, for the reason the `gave_up` run status is:
 * nothing broke — this box stopped looking — and red would say the owner's
 * deployment failed when it may be up and fine.
 */
const PHASE_TONE: Record<VercelPhase, string> = {
  looking: "text-sky-300",
  building: "text-sky-300",
  ready: "text-emerald-300",
  failed: "text-red-300",
  canceled: "text-[var(--text-muted)]",
  abandoned: "text-amber-300",
};

export interface CodingRunVercelCardProps {
  runId: string;
  vercel: VercelState;
  t: (key: string, params?: Record<string, string | number>) => string;
  /**
   * Promote this deployment. Answers an owner-facing sentence on refusal, or
   * null when it worked — the page owns the fetch, the way it owns every other
   * write, so this component has no opinion about routes.
   *
   * Absent on the STANDALONE page and anywhere else a promotion is not offered.
   */
  onPromote?: (deploymentId: string) => Promise<string | null>;
  /** A run this card may not act on (another run's chip, a read-only view). */
  onOpenRun?: (runId: string) => void;
}

export default function CodingRunVercelCard({ runId, vercel, t, onPromote, onOpenRun }: CodingRunVercelCardProps) {
  /** `idle` → `asking` → `working`. The confirmation is a STATE, not a window:
   *  a browser `confirm()` is not styleable, not translatable and is blocked in
   *  some embedded views, and the desktop's modal is more machinery than one
   *  question needs. */
  const [stage, setStage] = useState<"idle" | "asking" | "working">("idle");
  const [error, setError] = useState<string | null>(null);

  const pending = vercel.phase === "looking" || vercel.phase === "building";
  // Held in a local so the click handler closes over a `string` rather than
  // casting a nullable field the JSX has already tested.
  const fixRunId = vercel.fixRunId;
  const promotable = vercel.phase === "ready" && vercel.deploymentId !== null && !vercel.promotion && onPromote;

  const promote = async () => {
    if (!onPromote || !vercel.deploymentId) return;
    setStage("working");
    setError(null);
    const refused = await onPromote(vercel.deploymentId);
    setError(refused);
    setStage("idle");
  };

  return (
    <div
      className={`mt-3 ${CARD_SURFACE} px-4 py-3`}
      data-testid="coding-agent-deploy"
      data-phase={vercel.phase}
      data-run={runId}
    >
      <p className={SECTION_LABEL}>{t("codingAgent.deployTitle")}</p>
      <p className="mt-1.5 text-xs flex items-center gap-1.5 flex-wrap">
        {pending && (
          <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-sky-300 motion-safe:animate-pulse" />
        )}
        <span className={PHASE_TONE[vercel.phase]} data-testid="coding-agent-deploy-phase">
          {t(PHASE_KEY[vercel.phase])}
        </span>
        <span className="text-[var(--text-muted)]">· {vercel.projectId}</span>
      </p>

      {/* The preview, which is the whole point of the card. A plain link, and
          only when there IS one: a `looking` deployment has no address yet. */}
      {vercel.url && (
        <a
          href={vercel.url}
          target="_blank"
          rel="noreferrer"
          data-testid="coding-agent-deploy-preview"
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-mono break-all text-sky-300 hover:text-white underline decoration-sky-300/30"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 13 }} aria-hidden="true">open_in_new</span>
          {vercel.url}
        </a>
      )}

      {/* Why it failed, or why the box stopped looking — in the record's own
          words, because nothing else on the page says it. */}
      {vercel.detail && (
        <p
          className={`mt-1.5 text-[11px] break-words ${vercel.phase === "failed" ? "text-red-300/90" : "text-amber-300/90"}`}
          data-testid="coding-agent-deploy-detail"
        >
          {vercel.detail}
        </p>
      )}

      {vercel.promotion && (
        <p className="mt-1.5 text-[11px] text-emerald-300/90" data-testid="coding-agent-deploy-promoted">
          {t("codingAgent.deployPromotedBy")}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {vercel.inspectorUrl && (
          <a
            href={vercel.inspectorUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="coding-agent-deploy-inspect"
            className={BTN_SECONDARY}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">description</span>
            {t("codingAgent.deployOpenBuild")}
          </a>
        )}
        {/* The fix turn, when the box handed the failed build's log back. A
            chip to it rather than a repeat of its story. */}
        {fixRunId && onOpenRun && (
          <button
            type="button"
            onClick={() => onOpenRun(fixRunId)}
            data-testid="coding-agent-deploy-fix-run"
            className={BTN_SECONDARY}
          >
            {t("codingAgent.deployFixRun", { id: fixRunId })}
          </button>
        )}

        {promotable && stage === "idle" && (
          <button
            type="button"
            onClick={() => { setError(null); setStage("asking"); }}
            data-testid="coding-agent-deploy-promote"
            className={BTN_SECONDARY}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">rocket_launch</span>
            {t("codingAgent.deployPromote")}
          </button>
        )}
        {stage === "working" && (
          <span className="text-[11px] text-[var(--text-secondary)]" data-testid="coding-agent-deploy-promoting">
            {t("codingAgent.deployPromoting")}
          </span>
        )}
      </div>

      {/* The question, spelled out. What makes this a consent rather than a
          button is that the sentence says what the world will see. */}
      {stage === "asking" && promotable && (
        <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2" data-testid="coding-agent-deploy-confirm">
          <p className="text-[11px] text-amber-200">{t("codingAgent.deployPromoteAsk")}</p>
          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
            {t("codingAgent.deployPromoteWarn", { project: vercel.projectId })}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void promote()}
              data-testid="coding-agent-deploy-promote-confirm"
              className={BTN_DANGER}
            >
              {t("codingAgent.deployPromoteYes")}
            </button>
            <button
              type="button"
              onClick={() => setStage("idle")}
              data-testid="coding-agent-deploy-promote-cancel"
              className={BTN_SECONDARY}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* A live region: the refusal arrives after a network call with no focus
          change, so without `role="alert"` a screen reader announces nothing at
          all and the owner is left looking at an unchanged card. */}
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] text-red-300/90 break-words" data-testid="coding-agent-deploy-promote-error">
          {t("codingAgent.deployPromoteFailed", { reason: error })}
        </p>
      )}
    </div>
  );
}
