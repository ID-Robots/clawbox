"use client";

import { useEffect, useState } from "react";

import { useT } from "@/lib/i18n";

// The route's shape, DECLARED HERE rather than imported from
// `@/lib/background-jobs`. That module reads the config and therefore drags
// `fs` and `net` in behind it, and this is a client component: even an
// `import type` puts this file one edge away from a server-only graph in the
// bundler's eyes, and the sibling panel in the same tab learned that the
// expensive way. What crosses this boundary is JSON over a fetch, so the shape
// belongs to the wire, not to the server module.
type BackgroundJobId = "checkIns" | "memoryReview" | "skillLearning";

interface BackgroundJobsStatus {
  harness: string;
  degraded: boolean;
  jobs: { id: BackgroundJobId; enabled: boolean; supported: boolean; key: string | null }[];
}

// The three things the box does on its own initiative (TASK-609).
//
// OpenClaw 2 arrives with all three on: unprompted check-ins DM'd to the owner,
// memory consolidation on the default model, and self-learning's weekly
// collection review — measured on a box as three enabled cron rows and two
// "[heartbeat] started" lines in one evening. `gateway-pre-start.sh` seeds the
// opt-outs once; this is where the owner changes his mind, and the only place
// on the device that says the jobs exist at all.
//
// EVERY ROW IS A HARNESS KEY, and the panel says which one. The switches write
// `agents.defaults.heartbeat.every`, `plugins.entries.memory-core.config.
// dreaming.enabled` and `skills.workshop.autonomous.mode` on OpenClaw, and
// `auxiliary.background_review.enabled` / `curator.enabled` on Hermes. Naming
// the key is not decoration on an appliance whose owner may also have a
// terminal open: it is how he can tell that this switch and `hermes config get`
// are talking about the same thing.
//
// A ROW HERMES DOES NOT HAVE IS NOT AN OFF SWITCH. Nothing in Hermes wakes
// itself to message the owner — its only `heartbeat` keys are transport-level —
// so that row says so in words and draws no control. An off switch for
// something that cannot happen is a lie in the shape of a control.

const ROWS: { id: BackgroundJobId; labelKey: string; hintKey: string }[] = [
  { id: "checkIns", labelKey: "settings.bgCheckIns", hintKey: "settings.bgCheckInsHint" },
  { id: "memoryReview", labelKey: "settings.bgMemory", hintKey: "settings.bgMemoryHint" },
  { id: "skillLearning", labelKey: "settings.bgLearning", hintKey: "settings.bgLearningHint" },
];

// SHAPE-CHECKED DOWN TO THE ELEMENT. `Array.isArray` says yes to `[null]`, and
// the row lookup below then reads `.id` off it — a throw inside Settings, which
// is the whole window down again rather than one missing card. The array-ness
// used to be checked and the element shape was not.
function isStatus(body: unknown): body is BackgroundJobsStatus {
  const jobs = (body as { jobs?: unknown } | null | undefined)?.jobs;
  return Array.isArray(jobs) && jobs.every(isJob);
}

// EVERY FIELD THE ROW IS DRAWN FROM, not just the id. A half-row with `id` and
// nothing else passes an id-only check, and `supported` then reads `undefined`
// — so the panel draws "This edition has no such job" on a box that has it,
// which is the same lie as a dead switch, pointing the other way.
function isJob(job: unknown): boolean {
  if (!job || typeof job !== "object") return false;
  const row = job as Record<string, unknown>;
  return (
    typeof row.id === "string"
    && typeof row.enabled === "boolean"
    && typeof row.supported === "boolean"
    && (typeof row.key === "string" || row.key === null)
  );
}

export default function BackgroundJobsPanel() {
  const { t } = useT();
  const [status, setStatus] = useState<BackgroundJobsStatus | null>(null);
  const [busy, setBusy] = useState<BackgroundJobId | null>(null);
  const [failed, setFailed] = useState<BackgroundJobId | null>(null);
  // The config is right and the running process has not been told: the two are
  // different facts, and collapsing them into one green tick is the false
  // success this panel exists to avoid.
  const [pending, setPending] = useState<BackgroundJobId | null>(null);

  // Read once, on mount. `alive` because the answer comes back after an await
  // and a Settings tab is closed by clicking another one; the switches also
  // stay where they are on a box that cannot answer, rather than flipping to a
  // guess about what it is doing in the background.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/setup-api/background-jobs", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const body: unknown = await r.json();
        // SHAPE-CHECKED, not cast. This panel is mounted inside Settings, so a
        // body without usable `jobs` — an older server, a proxy's error page, a
        // mock that answers `{}` — turned `status.jobs.find(...)` into a throw
        // that took the whole Settings WINDOW down, not just this card. Three
        // e2e specs caught exactly that.
        if (alive && isStatus(body)) setStatus(body);
      } catch {
        // Nothing to say and nothing to draw: the panel stays hidden.
      }
    })();
    return () => { alive = false; };
  }, []);

  async function toggle(id: BackgroundJobId, enabled: boolean) {
    setBusy(id);
    setFailed(null);
    try {
      const r = await fetch("/setup-api/background-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      const body: unknown = await r.json().catch(() => null);
      // Only a device-verified change moves the switch. The route reads its own
      // write back off the config before it answers, so an `ok` here is the box
      // saying it changed — not this component assuming it did.
      if (r.ok && (body as { ok?: unknown } | null)?.ok === true && isStatus(body)) {
        setStatus(body);
        // `false` means the restart was tried and did not happen. `null` means
        // none was applicable — see `applyBackgroundJobRestart` for which of
        // the Hermes rows that was actually traced and which was not; the point
        // here is only that `null` must not draw the "wait for a restart" line
        // that `false` draws.
        setPending((body as { restarted?: boolean | null }).restarted === false ? id : null);
      } else setFailed(id);
    } catch {
      setFailed(id);
    } finally {
      setBusy(null);
    }
  }

  if (!status) return null;

  return (
    <div className="max-w-xl" data-testid="settings-background-jobs">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">
          bedtime
        </span>
        {/* A heading, not a `label`: there is no control for it to name, and a
            `label` without one is read out as a form label for whatever follows. */}
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.bgTitle")}
        </h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">{t("settings.bgHelper")}</p>

      {status.degraded && (
        <p className="text-[11px] text-[var(--amber-ink)] mb-2" data-testid="bg-jobs-degraded">
          {t("settings.bgDegraded")}
        </p>
      )}

      <div className="rounded-xl border border-white/[0.08] overflow-hidden divide-y divide-white/[0.06]">
        {ROWS.map((row) => {
          const job = status.jobs.find((j) => j.id === row.id);
          if (!job) return null;
          return (
            <div key={row.id} className="flex items-start gap-3 px-3 py-3" data-testid={`bg-job-${row.id}`}>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-[var(--text-primary)] font-medium">{t(row.labelKey)}</span>
                <span className="block text-[11px] text-[var(--text-secondary)] leading-relaxed">
                  {t(row.hintKey)}
                </span>
                {job.key && (
                  <span className="block text-[10px] text-[var(--text-muted)] font-mono mt-0.5 break-all">
                    {job.key}
                  </span>
                )}
                {pending === row.id && (
                  <span className="block text-[11px] text-[var(--text-secondary)] mt-1" data-testid={`bg-job-pending-${row.id}`}>
                    {t("settings.bgPending")}
                  </span>
                )}
                {failed === row.id && (
                  <span className="block text-[11px] text-[var(--amber-ink)] mt-1" data-testid={`bg-job-failed-${row.id}`}>
                    {t("settings.bgFailed")}
                  </span>
                )}
              </span>
              {job.supported ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={job.enabled}
                  aria-label={t(row.labelKey)}
                  aria-busy={busy === row.id}
                  // EVERY switch, not only the clicked one: the POST writes the
                  // key, reads it back and restarts the gateway — seconds on an
                  // Orin — and each answer replaces the whole status, so a
                  // second write started meanwhile can land its older answer
                  // last and leave a switch showing a state the box is not in.
                  disabled={busy !== null}
                  data-testid={`bg-job-switch-${row.id}`}
                  onClick={() => void toggle(row.id, !job.enabled)}
                  className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${job.enabled ? "bg-[var(--coral-bright)]" : "bg-white/15"}`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${job.enabled ? "left-[22px]" : "left-0.5"}`}
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <span
                  className="shrink-0 text-[11px] text-[var(--text-muted)] self-center"
                  data-testid={`bg-job-unsupported-${row.id}`}
                >
                  {t("settings.bgUnsupported")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
