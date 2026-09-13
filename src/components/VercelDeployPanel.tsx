"use client";

/**
 * The two Deploy buttons — a preview to test with, and production — for a
 * coding-agent project.
 *
 * ONE COMPONENT, TWO HOSTS, for the reason `CodingRunVercelCard` is its own
 * file: these are the buttons that put something on the internet, and the
 * question production is gated behind is the same question wherever it is
 * asked. The project's page hosts the full panel (the last deployment, and the
 * owner's standing permission for the assistant); a run's page hosts it
 * `compact`, where it is the two buttons and nothing else, because the run's
 * own deployment card is already telling that story right above it.
 *
 * IT IMPORTS ONLY ./vercel-state — never ./vercel or ./vercel-deploy. This is a
 * client component, and those modules reach the secret store, `fs` and
 * `child_process`; pulling them into the browser bundle does not resolve and
 * the build fails outright.
 *
 * THE PRODUCTION QUESTION NAMES WHAT WILL CHANGE. Not "are you sure" — the
 * Vercel project, and the domain when this box could learn it. A confirmation
 * that does not say what the world will see is a button with an extra click in
 * front of it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BTN_DANGER, BTN_SECONDARY, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import {
  isProjectDeployPending,
  VERCEL_POLL_INTERVAL_MS,
  type DeployTarget,
  type ProjectDeploy,
  type VercelPhase,
} from "@/lib/vercel-state";

/** What the route answers. */
export interface DeployPayload {
  linked: boolean;
  deploy: ProjectDeploy | null;
  autoProduction: boolean;
  production: { left: number; max: number; nextAt: number | null };
  project?: { name: string | null; productionDomain: string | null } | null;
}

export interface VercelDeployPanelProps {
  /** `projectId=…` or `directory=…` — the project these buttons deploy. */
  query: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** The run the deploy belongs to, when the buttons are on a run's page. */
  runId?: string;
  /** Buttons only: the host is already showing the deployment's state. */
  compact?: boolean;
  /** Something changed on the server that the host's own poll should pick up. */
  onDeployed?: () => void;
}

/** The same phase words the run's card uses; one catalogue, one vocabulary. */
const PHASE_KEY: Record<VercelPhase, string> = {
  looking: "codingAgent.deployLooking",
  building: "codingAgent.deployBuilding",
  ready: "codingAgent.deployReady",
  failed: "codingAgent.deployFailed",
  canceled: "codingAgent.deployCanceled",
  abandoned: "codingAgent.deployAbandoned",
};

const PHASE_TONE: Record<VercelPhase, string> = {
  looking: "text-sky-300",
  building: "text-sky-300",
  ready: "text-emerald-300",
  failed: "text-red-300",
  canceled: "text-[var(--text-muted)]",
  abandoned: "text-amber-300",
};

/**
 * How often the panel asks what became of a deployment that is still building.
 *
 * The SAME number the run watcher polls Vercel on, imported rather than chosen
 * again: it is one fact — how often this box asks another company's API about a
 * build — and two of them drift into a card that costs more than the watcher it
 * sits beside. Only while a deployment is pending and only while the card is
 * open, so a project page nobody is looking at costs nothing.
 */
const POLL_MS = VERCEL_POLL_INTERVAL_MS;

export default function VercelDeployPanel({ query, t, runId, compact, onDeployed }: VercelDeployPanelProps) {
  const [data, setData] = useState<DeployPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<DeployTarget | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The domain lookup is asked for ONCE, on mount.
   *
   * A ref rather than state: it decides what the next fetch asks for and must
   * not itself cause one. The plain read is a config read and costs nothing;
   * `domain=1` is a call to Vercel, and a poll that made one every five seconds
   * while a build ran is exactly the cost the link card's `check=1` was split
   * out to avoid.
   */
  const wantDomain = useRef(true);

  const load = useCallback(async () => {
    try {
      const ask = wantDomain.current;
      wantDomain.current = false;
      const res = await fetch(`/setup-api/coding-agent/vercel/deploy?${query}${ask ? "&domain=1" : ""}`);
      if (!res.ok) {
        // A project no link can be attached to is not an error to shout about:
        // the panel simply has nothing to offer, and the page around it is fine.
        setData(null);
        return;
      }
      const body = await res.json() as DeployPayload;
      // The domain is only in the first answer; keeping it across the polls is
      // what lets the confirmation go on naming it.
      setData((before) => ({ ...body, project: body.project ?? before?.project ?? null }));
    } catch {
      /* offline: the panel keeps what it has */
    } finally {
      setLoaded(true);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  // Poll only while a deployment is actually in flight, and only in the host
  // that draws it: the compact panel shows no state, so it has nothing to
  // refresh and its run's own card is already polling.
  const pending = !compact && isProjectDeployPending(data?.deploy);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  const deploy = async (target: DeployTarget) => {
    setBusy(target);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/vercel/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...Object.fromEntries(new URLSearchParams(query)),
          target,
          ...(runId ? { runId } : {}),
          // The owner's intent, on the wire, so the button and the route agree
          // about what the gesture is — the promote route's own rule.
          ...(target === "production" ? { confirm: true } : {}),
        }),
      });
      const body = await res.json().catch(() => null) as (DeployPayload & { error?: string }) | null;
      if (!res.ok) {
        setError(body?.error ?? t("codingAgent.deployStartFailed", { reason: String(res.status) }));
        return;
      }
      if (body) setData((before) => ({ ...body, project: body.project ?? before?.project ?? null }));
      setAsking(false);
      onDeployed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const setAuto = async (enabled: boolean) => {
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/vercel/deploy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...Object.fromEntries(new URLSearchParams(query)), autoProduction: enabled }),
      });
      const body = await res.json().catch(() => null) as (DeployPayload & { error?: string }) | null;
      if (!res.ok) {
        setError(body?.error ?? t("codingAgent.deployStartFailed", { reason: String(res.status) }));
        return;
      }
      if (body) setData((before) => ({ ...body, project: body.project ?? before?.project ?? null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Nothing to deploy TO. Drawn as nothing rather than as a disabled button:
  // the link card right above says how to attach a project, and a greyed
  // Deploy would be a second, wordless way of saying the same thing.
  if (!loaded || !data?.linked) return null;

  const latest = data.deploy;
  const projectName = data.project?.name ?? latest?.projectId ?? "";
  const domain = data.project?.productionDomain ?? null;

  return (
    <div className={compact ? "mt-2" : `mt-3 ${INSET_SURFACE} px-3 py-2.5`} data-testid="coding-agent-deploy-actions">
      {!compact && <p className={SECTION_LABEL}>{t("codingAgent.deployActionsTitle")}</p>}

      <div className={`${compact ? "" : "mt-2"} flex items-center gap-2 flex-wrap`}>
        <button
          type="button"
          onClick={() => void deploy("preview")}
          disabled={busy !== null}
          data-testid="coding-agent-deploy-preview-btn"
          className={BTN_SECONDARY}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">cloud_upload</span>
          {busy === "preview" ? t("codingAgent.deployStarting") : t("codingAgent.deployPreviewAction")}
        </button>
        <button
          type="button"
          onClick={() => { setError(null); setAsking(true); }}
          disabled={busy !== null}
          data-testid="coding-agent-deploy-production-btn"
          className={BTN_SECONDARY}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">rocket_launch</span>
          {busy === "production" ? t("codingAgent.deployStarting") : t("codingAgent.deployProductionAction")}
        </button>
      </div>

      {/* The question, spelled out: what goes live, and where. */}
      {asking && (
        <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2" data-testid="coding-agent-deploy-production-confirm">
          <p className="text-[11px] text-amber-200">{t("codingAgent.deployProductionAsk")}</p>
          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
            {domain
              ? t("codingAgent.deployProductionWarnDomain", { project: projectName, domain })
              : t("codingAgent.deployProductionWarn", { project: projectName })}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void deploy("production")}
              disabled={busy !== null}
              data-testid="coding-agent-deploy-production-confirm-yes"
              className={BTN_DANGER}
            >
              {t("codingAgent.deployProductionYes")}
            </button>
            <button
              type="button"
              onClick={() => setAsking(false)}
              disabled={busy !== null}
              data-testid="coding-agent-deploy-production-cancel"
              className={BTN_SECONDARY}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* The last deployment this box made for the project — the project page's
          half. A run's page says it in the run's own card instead. */}
      {!compact && latest && (
        <div className="mt-2" data-testid="coding-agent-project-deploy" data-phase={latest.phase} data-target={latest.target}>
          <p className="text-[11px] flex items-center gap-1.5 flex-wrap">
            {isProjectDeployPending(latest) && (
              <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-sky-300 motion-safe:animate-pulse" />
            )}
            <span className={PHASE_TONE[latest.phase]} data-testid="coding-agent-project-deploy-phase">
              {t(PHASE_KEY[latest.phase])}
            </span>
            <span className="text-[var(--text-muted)]">
              · {t(latest.target === "production" ? "codingAgent.deployTargetProduction" : "codingAgent.deployTargetPreview")}
              {/* Who asked. After the fact there is no other way to tell the
                  owner's own press from one the assistant made. */}
              {latest.by === "agent" && <> · {t("codingAgent.deployByAgent")}</>}
            </span>
          </p>
          {latest.url && (
            <a
              href={latest.url}
              target="_blank"
              rel="noreferrer"
              data-testid="coding-agent-project-deploy-url"
              className="mt-1 inline-flex items-center gap-1 text-[11px] font-mono break-all text-sky-300 hover:text-white underline decoration-sky-300/30"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 13 }} aria-hidden="true">open_in_new</span>
              {latest.url}
            </a>
          )}
          {latest.detail && (
            <p
              className={`mt-1 text-[11px] break-words ${latest.phase === "failed" ? "text-red-300/90" : "text-amber-300/90"}`}
              data-testid="coding-agent-project-deploy-detail"
            >
              {latest.detail}
            </p>
          )}
        </div>
      )}

      {/* The owner's standing permission for the assistant. On the project page
          only: it is a setting, and a setting belongs beside the thing it
          governs rather than on every run that happens to be open. */}
      {!compact && (
        <label className="mt-2.5 flex items-start gap-2 text-[11px] text-[var(--text-secondary)]" data-testid="coding-agent-deploy-auto-label">
          <input
            type="checkbox"
            checked={data.autoProduction}
            onChange={(e) => void setAuto(e.target.checked)}
            data-testid="coding-agent-deploy-auto"
            className="mt-0.5"
          />
          <span>
            {t("codingAgent.deployAutoProduction")}
            <span className="block text-[var(--text-muted)]">{t("codingAgent.deployAutoProductionHint")}</span>
          </span>
        </label>
      )}

      {/* A live region: a refusal arrives after a network call with no focus
          change, so without `role="alert"` a screen reader announces nothing. */}
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] text-red-300/90 break-words" data-testid="coding-agent-deploy-error">
          {t("codingAgent.deployStartFailed", { reason: error })}
        </p>
      )}
    </div>
  );
}
