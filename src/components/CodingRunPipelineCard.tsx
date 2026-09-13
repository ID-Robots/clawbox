"use client";

/**
 * The delivery pipeline on a run's own page: the stages as a strip, each with
 * its own state, its evidence and, when it went wrong, the reason.
 *
 * WHY A STRIP AND NOT A LOG. The owner asked for the whole flow to run by
 * itself, which means the question they actually have is "where has it got to,
 * and is it stuck on me?" — one glance, not a reading. So the stages are drawn
 * in the order they happen, the one in flight is the only thing that moves, and
 * the two states that need a person (waiting for the production button, and a
 * pipeline that stopped) are the two that get words.
 *
 * IT IMPORTS ONLY ./coding-pipeline, never ./coding-pipeline-verify: this is a
 * client component, and the module that does the looking reaches `fs`, Playwright
 * and the vision proxy. Pulling that into the browser bundle does not resolve
 * and the build fails outright — the same reason ./coding-pr-state and
 * ./vercel-state exist.
 */

import { useState } from "react";
import { BTN_DANGER, BTN_SECONDARY, CARD_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import {
  PIPELINE_STAGES,
  type PipelineStage,
  type PipelineStageState,
  type PipelineState,
} from "@/lib/coding-pipeline";

/** One key per stage: what the owner calls it. */
const STAGE_KEY: Record<PipelineStage, string> = {
  build: "codingAgent.pipelineStageBuild",
  review: "codingAgent.pipelineStageReview",
  improvement: "codingAgent.pipelineStageImprovement",
  deploy_preview: "codingAgent.pipelineStageDeployPreview",
  verify_preview: "codingAgent.pipelineStageVerifyPreview",
  deploy_production: "codingAgent.pipelineStageDeployProduction",
  verify_production: "codingAgent.pipelineStageVerifyProduction",
  complete: "codingAgent.pipelineStageComplete",
};

const STAGE_ICON: Record<PipelineStageState, string> = {
  pending: "radio_button_unchecked",
  running: "progress_activity",
  passed: "check_circle",
  failed: "cancel",
  // Not a tick: a stage that did not need to run has not passed, and drawing
  // the two the same would claim work this box did not do.
  skipped: "remove_circle_outline",
  waiting_owner: "pan_tool",
};

/**
 * The state as a WORD, for the screen reader that gets nothing from an icon.
 *
 * A table rather than `codingAgent.pipelineState.${state}` because the catalogue
 * forbids an underscore in a key and `waiting_owner` has one — and because a
 * key built by interpolation is a key no parity test can find.
 */
const STATE_KEY: Record<PipelineStageState, string> = {
  pending: "codingAgent.pipelineState.pending",
  running: "codingAgent.pipelineState.running",
  passed: "codingAgent.pipelineState.passed",
  failed: "codingAgent.pipelineState.failed",
  skipped: "codingAgent.pipelineState.skipped",
  waiting_owner: "codingAgent.pipelineState.waitingOwner",
};

const STAGE_TONE: Record<PipelineStageState, string> = {
  pending: "text-[var(--text-muted)]",
  running: "text-sky-300",
  passed: "text-emerald-300",
  failed: "text-red-300",
  skipped: "text-[var(--text-muted)]",
  waiting_owner: "text-amber-300",
};

/** The headline: one sentence saying whether anything is owed, and by whom. */
const STATUS_KEY: Record<PipelineState["status"], string> = {
  running: "codingAgent.pipelineRunning",
  waiting_owner: "codingAgent.pipelineWaitingOwner",
  complete: "codingAgent.pipelineComplete",
  failed: "codingAgent.pipelineFailed",
  blocked: "codingAgent.pipelineBlocked",
  stopped: "codingAgent.pipelineStopped",
};

const STATUS_TONE: Record<PipelineState["status"], string> = {
  running: "text-sky-300",
  waiting_owner: "text-amber-300",
  complete: "text-emerald-300",
  failed: "text-red-300",
  // AMBER and not red, the rule `abandoned` is drawn by: nothing broke — the
  // box could not run a stage because something is not set up — and red would
  // say the work failed when it did not.
  blocked: "text-amber-300",
  stopped: "text-[var(--text-muted)]",
};

export interface CodingRunPipelineCardProps {
  runId: string;
  pipeline: PipelineState;
  t: (key: string, params?: Record<string, string | number>) => string;
  /**
   * Approve the production deployment. Answers an owner-facing sentence on
   * refusal, or null when it worked — the page owns the fetch, the way it owns
   * every other write.
   *
   * Absent on the STANDALONE page and anywhere the button is not offered.
   */
  onApproveProduction?: () => Promise<string | null>;
  /** Call the rest of the flow off. Absent where it is not offered. */
  onStopPipeline?: () => Promise<string | null>;
  /** Open one of this run's evidence files (a verification screenshot). */
  artifactUrl?: (name: string) => string;
}

export default function CodingRunPipelineCard({
  runId,
  pipeline,
  t,
  onApproveProduction,
  onStopPipeline,
  artifactUrl,
}: CodingRunPipelineCardProps) {
  /** `idle` → `asking` → `working`, the promote button's shape and for its
   *  reasons: a browser `confirm()` is not styleable, not translatable and is
   *  blocked in some embedded views. */
  const [phase, setPhase] = useState<"idle" | "asking" | "working">("idle");
  const [error, setError] = useState<string | null>(null);

  // The production half is not drawn at all on a pipeline that was asked to
  // stop at a verified preview: two greyed-out stages that will never run read
  // as something that went wrong.
  const stages = PIPELINE_STAGES.filter(
    (stage) => pipeline.production || (stage !== "deploy_production" && stage !== "verify_production"),
  );
  const stepFor = (stage: PipelineStage) => pipeline.steps.find((s) => s.stage === stage);
  const waiting = pipeline.status === "waiting_owner";
  const checked = pipeline.lastVerification;

  const act = async (run: () => Promise<string | null>) => {
    setPhase("working");
    setError(null);
    const refused = await run();
    setError(refused);
    setPhase("idle");
  };

  return (
    <div
      className={`mt-3 ${CARD_SURFACE} px-4 py-3`}
      data-testid="coding-agent-pipeline"
      data-status={pipeline.status}
      data-stage={pipeline.stage}
      data-run={runId}
    >
      <p className={SECTION_LABEL}>{t("codingAgent.pipelineTitle")}</p>

      <p className="mt-1.5 text-xs flex items-center gap-1.5 flex-wrap">
        {pipeline.status === "running" && (
          <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-sky-300 motion-safe:animate-pulse" />
        )}
        <span className={STATUS_TONE[pipeline.status]} data-testid="coding-agent-pipeline-status">
          {t(STATUS_KEY[pipeline.status])}
        </span>
        {pipeline.maxRounds > 0 && pipeline.round > 0 && (
          <span className="text-[var(--text-muted)]">
            · {t("codingAgent.pipelineRounds", { round: pipeline.round, max: pipeline.maxRounds })}
          </span>
        )}
      </p>

      {/* The strip. An ordered list, because the order is the meaning and a
          screen reader gets nothing from a row of icons. */}
      <ol className="mt-2 flex flex-col gap-1" data-testid="coding-agent-pipeline-stages">
        {stages.map((stage) => {
          const step = stepFor(stage);
          const state: PipelineStageState = step?.state ?? "pending";
          return (
            <li
              key={stage}
              className="flex items-start gap-1.5 text-[11px]"
              data-testid={`coding-agent-pipeline-stage-${stage}`}
              data-state={state}
            >
              <span
                className={`material-symbols-rounded ${STAGE_TONE[state]} ${state === "running" ? "motion-safe:animate-spin" : ""}`}
                style={{ fontSize: 14, lineHeight: "16px" }}
                aria-hidden="true"
              >
                {STAGE_ICON[state]}
              </span>
              <span className="flex-1 min-w-0">
                <span className={state === "pending" ? "text-[var(--text-muted)]" : "text-[var(--text-secondary)]"}>
                  {t(STAGE_KEY[stage])}
                </span>
                {/* The screen-reader half of the icon: the state as a word. */}
                <span className="sr-only"> — {t(STATE_KEY[state])}</span>
                {step?.detail && (
                  <span
                    className={`block break-words ${state === "failed" ? "text-red-300/90" : "text-[var(--text-muted)]"}`}
                    data-testid={`coding-agent-pipeline-detail-${stage}`}
                  >
                    {step.detail}
                  </span>
                )}
                {/* The evidence: what the box actually looked at. Links where
                    there is something to open, plain text where there is not. */}
                {step?.evidence.map((item, i) => (
                  <span key={`${item.at}-${i}`} className="block text-[var(--text-muted)] break-words">
                    {item.kind === "url" && item.ref ? (
                      <a
                        href={item.ref}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-sky-300 hover:text-white underline decoration-sky-300/30"
                      >
                        {item.ref}
                      </a>
                    ) : item.kind === "screenshot" && item.ref && artifactUrl ? (
                      <a
                        href={artifactUrl(item.ref)}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="coding-agent-pipeline-screenshot"
                        className="text-sky-300 hover:text-white underline decoration-sky-300/30"
                      >
                        {t("codingAgent.pipelineScreenshot")}
                      </a>
                    ) : (
                      item.detail
                    )}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ol>

      {/* What the last check actually established, said as the claim it is:
          the page contained the strings, or a model looked at a picture. */}
      {checked && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)] break-words" data-testid="coding-agent-pipeline-checked">
          {t(
            checked.judgedBy === "expectations"
              ? "codingAgent.pipelineJudgedByExpectations"
              : checked.judgedBy === "vision"
                ? "codingAgent.pipelineJudgedByVision"
                : "codingAgent.pipelineJudgedByNothing",
            { url: checked.url },
          )}
        </p>
      )}

      {/* Why it is not going on — the one thing a stopped pipeline owes. */}
      {pipeline.failure && (
        <p
          role="status"
          className={`mt-2 text-[11px] break-words ${pipeline.status === "blocked" ? "text-amber-300/90" : "text-red-300/90"}`}
          data-testid="coding-agent-pipeline-failure"
        >
          {pipeline.failure.reason}
        </p>
      )}

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {waiting && onApproveProduction && phase === "idle" && (
          <button
            type="button"
            onClick={() => { setError(null); setPhase("asking"); }}
            data-testid="coding-agent-pipeline-deploy-production"
            className={BTN_SECONDARY}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">rocket_launch</span>
            {t("codingAgent.pipelineDeployProduction")}
          </button>
        )}
        {waiting && onStopPipeline && phase === "idle" && (
          <button
            type="button"
            onClick={() => void act(onStopPipeline)}
            data-testid="coding-agent-pipeline-stop"
            className={BTN_SECONDARY}
          >
            {t("codingAgent.pipelineStop")}
          </button>
        )}
        {phase === "working" && (
          <span className="text-[11px] text-[var(--text-secondary)]" data-testid="coding-agent-pipeline-working">
            {t("codingAgent.pipelineWorking")}
          </span>
        )}
      </div>

      {/* The question, spelled out. What makes this a consent rather than a
          button is that the sentence says what the world will see. */}
      {phase === "asking" && waiting && onApproveProduction && (
        <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2" data-testid="coding-agent-pipeline-confirm">
          <p className="text-[11px] text-amber-200">{t("codingAgent.pipelineProductionAsk")}</p>
          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{t("codingAgent.pipelineProductionWarn")}</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void act(onApproveProduction)}
              data-testid="coding-agent-pipeline-production-confirm"
              className={BTN_DANGER}
            >
              {t("codingAgent.pipelineProductionYes")}
            </button>
            <button
              type="button"
              onClick={() => setPhase("idle")}
              data-testid="coding-agent-pipeline-production-cancel"
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
        <p role="alert" className="mt-1.5 text-[11px] text-red-300/90 break-words" data-testid="coding-agent-pipeline-error">
          {error}
        </p>
      )}
    </div>
  );
}
