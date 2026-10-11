"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { MAX_CI_FIX_ATTEMPTS } from "@/lib/coding-ci-limits";
import { BTN_SECONDARY, INSET_SURFACE } from "./coding-agent-ui";

/** A run's failed CI, as the record carries it (src/lib/coding-agent.ts RunCi). */
export interface RunCiView {
  prNumber: number;
  checks: string[];
  tests: string[];
  files: string[];
  excerpt: string;
  unread: string[];
  attempt: number;
  fixRunId: string | null;
}

/**
 * "CI failed" on a run's page: which checks, which tests, which files, the
 * tail of the failed jobs' logs — and the one gesture that helps, a "Fix CI"
 * continuation of this run (POST /setup-api/coding-agent/run with
 * `resumeRunId` and `fixCi`), the box appending what failed to the task.
 *
 * Bounded like the server: offered while attempts are left along the chain
 * (MAX_CI_FIX_ATTEMPTS) and no Fix CI was started from this failure — then the
 * card links that run instead, or says the rest is the owner's.
 */
export default function CodingRunCiCard({
  runId,
  ci,
  settled,
  onStarted,
  runChip,
}: {
  runId: string;
  ci: RunCiView;
  /** The run is over: a continuation cannot start while it works. */
  settled: boolean;
  /** A Fix CI run started; the host opens it. */
  onStarted: (newRunId: string) => void;
  /** A chip naming another run — the host's, so it opens the run's page. */
  runChip: (id: string) => React.ReactNode;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = ci.attempt + 1;
  const canFix = settled && !ci.fixRunId && next <= MAX_CI_FIX_ATTEMPTS;

  const fix = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The task is the harness's, in its language; the failure itself is
        // appended by the box from this run's record.
        body: JSON.stringify({ task: `Fix the failing CI checks on pull request #${ci.prNumber}.`, resumeRunId: runId, fixCi: true }),
      });
      const data = await res.json().catch(() => null) as { run?: { id?: string }; error?: string } | null;
      if (!res.ok || !data?.run?.id) throw new Error(data?.error ?? t("codingAgent.ci.fixFailed"));
      onStarted(data.run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.ci.fixFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`mt-3 ${INSET_SURFACE} border border-red-400/30 px-4 py-3`} data-testid="coding-agent-run-ci">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="material-symbols-rounded text-red-300" style={{ fontSize: 16 }} aria-hidden="true">error</span>
        <p className="text-xs font-medium text-red-200">{t("codingAgent.ci.title", { n: ci.prNumber })}</p>
        {canFix && (
          <button type="button" onClick={() => void fix()} disabled={busy} data-testid="coding-agent-ci-fix" className={`${BTN_SECONDARY} ml-auto`}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">build</span>
            {t("codingAgent.ci.fix", { n: next, max: MAX_CI_FIX_ATTEMPTS })}
          </button>
        )}
      </div>
      {ci.checks.length > 0 && (
        <p className="mt-1 text-[11px] text-[var(--text-secondary)] break-words" data-testid="coding-agent-ci-checks">
          {t("codingAgent.ci.checks", { checks: ci.checks.join(", ") })}
        </p>
      )}
      {ci.tests.length > 0 && (
        <div className="mt-1" data-testid="coding-agent-ci-tests">
          <p className="text-[11px] text-[var(--text-secondary)]">{t("codingAgent.ci.tests", { n: ci.tests.length })}</p>
          <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-red-200/90">
            {ci.tests.map((test) => <li key={test} className="break-words">{test}</li>)}
          </ul>
        </div>
      )}
      {ci.files.length > 0 && (
        <p className="mt-1 text-[11px] text-[var(--text-muted)] break-words font-mono">{ci.files.join(", ")}</p>
      )}
      {ci.unread.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-300/90">{t("codingAgent.ci.unread", { checks: ci.unread.join(", ") })}</p>
      )}
      {ci.excerpt && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-[var(--text-muted)] hover:text-white">{t("codingAgent.ci.log")}</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] text-[var(--text-secondary)]" data-testid="coding-agent-ci-log">{ci.excerpt}</pre>
        </details>
      )}
      {ci.fixRunId && (
        <p className="mt-1.5 text-[11px] text-[var(--text-secondary)] flex items-center gap-1" data-testid="coding-agent-ci-fix-run">
          {t("codingAgent.ci.fixRun")} {runChip(ci.fixRunId)}
        </p>
      )}
      {!ci.fixRunId && next > MAX_CI_FIX_ATTEMPTS && (
        <p className="mt-1.5 text-[11px] text-amber-300/90" data-testid="coding-agent-ci-exhausted">{t("codingAgent.ci.exhausted", { max: MAX_CI_FIX_ATTEMPTS })}</p>
      )}
      {error && <p className="mt-1.5 text-[11px] text-red-300" role="alert">{error}</p>}
    </div>
  );
}
