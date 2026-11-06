"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { formatBytes } from "@/lib/format-bytes";
import StatusMessage from "./StatusMessage";
import Switch from "./CodingAgentSwitch";
import HelpTip from "./HelpTip";
import { BTN_SECONDARY, FIELD } from "./coding-agent-ui";

/**
 * "Clean up old run folders" in the Coding Agent settings — the folder
 * janitor (src/lib/coding-folder-janitor.ts) through its own route,
 * `/setup-api/coding-agent/janitor`: the switch, the retention in days, the
 * dry run (what would go now, and why each of the rest is kept) and "Clean
 * now". Its own component, fetching its own state, so the panel's status poll
 * never pays for a scan of the project folder.
 */

type Action = "remove" | "trash" | "prune" | "keep";

interface Entry {
  path: string;
  kind: "worktree" | "copy";
  branch: string | null;
  action: Action;
  reason: string;
  idleDays: number | null;
}

interface PassSummary {
  at: number;
  removed: number;
  trashed: number;
  pruned: number;
  failed: number;
  kept: number;
  freedBytes: number;
}

interface JanitorView {
  settings: { enabled: boolean; retentionDays: number };
  limits: { minRetentionDays: number; maxRetentionDays: number };
  lastPass: PassSummary | null;
  running: boolean;
  plan?: { projectFolder: string; entries: Entry[] };
}

const ROUTE = "/setup-api/coding-agent/janitor";

/** The keys spelled out, so every one is a literal a scan can find. */
const ACTION_KEY: Record<Action, string> = {
  remove: "codingAgent.janitorAction.remove",
  trash: "codingAgent.janitorAction.trash",
  prune: "codingAgent.janitorAction.prune",
  keep: "codingAgent.janitorAction.keep",
};

const REASON_KEY: Record<string, string> = {
  merged: "codingAgent.janitorReason.merged",
  pushed: "codingAgent.janitorReason.pushed",
  missing: "codingAgent.janitorReason.missing",
  protected: "codingAgent.janitorReason.protected",
  locked: "codingAgent.janitorReason.locked",
  live_run: "codingAgent.janitorReason.liveRun",
  live_team: "codingAgent.janitorReason.liveTeam",
  busy: "codingAgent.janitorReason.busy",
  lease: "codingAgent.janitorReason.lease",
  recent: "codingAgent.janitorReason.recent",
  dirty: "codingAgent.janitorReason.dirty",
  stash: "codingAgent.janitorReason.stash",
  unpushed: "codingAgent.janitorReason.unpushed",
  unmerged: "codingAgent.janitorReason.unmerged",
  unknown: "codingAgent.janitorReason.unknown",
  limit: "codingAgent.janitorReason.limit",
};

/**
 * The route's answer, or null when it is not one: an older server, a proxy's
 * error page or a stub answering `{}` must leave the section empty, never
 * take the settings panel down with it.
 */
function asView(data: unknown): JanitorView | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<JanitorView>;
  const settings = d.settings;
  if (!settings || typeof settings.enabled !== "boolean" || typeof settings.retentionDays !== "number") return null;
  const limits = d.limits && typeof d.limits.minRetentionDays === "number" && typeof d.limits.maxRetentionDays === "number"
    ? d.limits
    : { minRetentionDays: 1, maxRetentionDays: 365 };
  const plan = d.plan && typeof d.plan.projectFolder === "string" && Array.isArray(d.plan.entries) ? d.plan : undefined;
  const lastPass = d.lastPass && typeof d.lastPass.at === "number" ? d.lastPass : null;
  return { settings, limits, lastPass, running: d.running === true, ...(plan ? { plan } : {}) };
}

/** A path inside the project folder said from there; anything else in full. */
function shortPath(p: string, folder: string): string {
  return folder && p.startsWith(`${folder}/`) ? p.slice(folder.length + 1) : p;
}

type Busy = null | "enabled" | "days" | "plan" | "clean";

export default function CodingAgentJanitorSection() {
  const { t, locale } = useT();
  const [view, setView] = useState<JanitorView | null>(null);
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<JanitorView["plan"] | null>(null);
  const [result, setResult] = useState<PassSummary | null>(null);

  const load = useCallback(async (withPlan: boolean) => {
    const res = await fetch(withPlan ? `${ROUTE}?plan=1` : ROUTE, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const data = asView(await res.json());
    if (!data) throw new Error("not a clean-up answer");
    setView(data);
    setDays(String(data.settings.retentionDays));
    if (withPlan) setPlan(data.plan ?? null);
  }, []);

  // The first read, inline: state is only ever set from the answer, never in the effect body.
  useEffect(() => {
    let cancelled = false;
    fetch(ROUTE, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((raw: unknown) => {
        const data = asView(raw);
        if (cancelled || !data) return;
        setView(data);
        setDays(String(data.settings.retentionDays));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (patch: { enabled?: boolean; retentionDays?: number }, which: Busy) => {
    setBusy(which);
    setError(null);
    try {
      const res = await fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      const data = (await res.json().catch(() => ({}))) as { settings?: unknown };
      const settings = asView({ settings: data.settings })?.settings;
      if (!res.ok || !settings) throw new Error(String(res.status));
      setView((v) => (v ? { ...v, settings } : v));
      setDays(String(settings.retentionDays));
    } catch {
      setError(t("codingAgent.janitorFailed"));
      if (view) setDays(String(view.settings.retentionDays));
    } finally {
      setBusy(null);
    }
  };

  const commitDays = () => {
    if (!view) return;
    const n = Number(days);
    if (n === view.settings.retentionDays) return;
    if (!Number.isInteger(n) || n < view.limits.minRetentionDays || n > view.limits.maxRetentionDays) {
      setError(t("codingAgent.janitorFailed"));
      setDays(String(view.settings.retentionDays));
      return;
    }
    void save({ retentionDays: n }, "days");
  };

  const preview = async () => {
    setBusy("plan");
    setError(null);
    try {
      await load(true);
    } catch {
      setError(t("codingAgent.janitorRunFailed"));
    } finally {
      setBusy(null);
    }
  };

  const clean = async () => {
    setBusy("clean");
    setError(null);
    try {
      const res = await fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clean" }) });
      if (res.status === 409) {
        setError(t("codingAgent.janitorBusy"));
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { result?: PassSummary };
      if (!res.ok || !data.result || typeof data.result.removed !== "number") throw new Error(String(res.status));
      setResult(data.result);
      await load(plan !== null).catch(() => {});
    } catch {
      setError(t("codingAgent.janitorRunFailed"));
    } finally {
      setBusy(null);
    }
  };

  const going = plan ? plan.entries.filter((e) => e.action !== "keep").length : 0;
  const last = view?.lastPass ?? null;

  return (
    <div data-testid="coding-agent-janitor">
      <div className="flex items-start justify-between gap-4 mt-4">
        <div className="min-w-0 flex items-center gap-1.5">
          <span className="text-xs font-medium text-[var(--text-secondary)]">{t("codingAgent.janitorLabel")}</span>
          <HelpTip text={t("codingAgent.janitorHint")} label={t("codingAgent.janitorLabel")} testId="coding-agent-janitor-help" />
        </div>
        <Switch
          checked={view?.settings.enabled ?? true}
          busy={busy === "enabled"}
          disabled={!view || busy !== null}
          label={t("codingAgent.janitorLabel")}
          testId="coding-agent-janitor-enabled"
          onChange={(next) => void save({ enabled: next }, "enabled")}
        />
      </div>
      <div className="flex items-center justify-between gap-4 mt-3">
        <label htmlFor="coding-agent-janitor-days" className="min-w-0 text-xs font-medium text-[var(--text-secondary)]">
          {t("codingAgent.janitorRetentionLabel")}
        </label>
        <input
          id="coding-agent-janitor-days"
          type="number"
          inputMode="numeric"
          min={view?.limits.minRetentionDays ?? 1}
          max={view?.limits.maxRetentionDays ?? 365}
          value={days}
          disabled={!view || busy !== null}
          data-testid="coding-agent-janitor-days"
          onChange={(e) => setDays(e.target.value)}
          onBlur={commitDays}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitDays();
          }}
          className={`text-base sm:text-xs ${FIELD} w-28`}
        />
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <button type="button" className={BTN_SECONDARY} disabled={!view || busy !== null} onClick={() => void preview()} data-testid="coding-agent-janitor-preview">
          {busy === "plan" ? t("codingAgent.janitorChecking") : t("codingAgent.janitorPreview")}
        </button>
        <button type="button" className={BTN_SECONDARY} disabled={!view || busy !== null} onClick={() => void clean()} data-testid="coding-agent-janitor-clean">
          {busy === "clean" ? t("codingAgent.janitorCleaning") : t("codingAgent.janitorCleanNow")}
        </button>
      </div>
      {last && !result && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-janitor-last">
          {t("codingAgent.janitorLastPass", { when: new Date(last.at).toLocaleString(locale), removed: last.removed, trashed: last.trashed })}
        </p>
      )}
      {result && (
        <p className="mt-2 text-[11px] text-[var(--text-secondary)]" data-testid="coding-agent-janitor-result">
          {t("codingAgent.janitorResult", {
            removed: result.removed,
            trashed: result.trashed,
            pruned: result.pruned,
            kept: result.kept,
            size: formatBytes(result.freedBytes, locale) ?? "0 B",
          })}
        </p>
      )}
      {error && <StatusMessage type="error" message={error} />}
      {plan && (
        <div className="mt-3" data-testid="coding-agent-janitor-plan">
          <p className="text-[11px] text-[var(--text-muted)]">
            {plan.entries.length === 0
              ? t("codingAgent.janitorNothing")
              : t("codingAgent.janitorPlanSummary", { go: going, kept: plan.entries.length - going })}
          </p>
          {plan.entries.length > 0 && (
            <ul className="mt-2 max-h-64 overflow-y-auto space-y-1 pr-1">
              {plan.entries.map((e) => (
                <li
                  key={e.path}
                  className="flex items-baseline justify-between gap-3 text-[11px]"
                  data-testid="coding-agent-janitor-entry"
                  data-action={e.action}
                  data-reason={e.reason}
                >
                  <span className="min-w-0 truncate font-mono text-[var(--text-secondary)]" title={e.path}>
                    {shortPath(e.path, plan.projectFolder)}
                  </span>
                  <span className={`shrink-0 ${e.action === "keep" ? "text-[var(--text-muted)]" : "text-[var(--coral-bright)]"}`}>
                    {t(ACTION_KEY[e.action])}
                    {" · "}
                    {t(REASON_KEY[e.reason] ?? REASON_KEY.unknown)}
                    {e.idleDays !== null ? ` · ${t("codingAgent.janitorIdle", { days: e.idleDays })}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
