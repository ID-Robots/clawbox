"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_PRIMARY, BTN_QUIET, BTN_SECONDARY, CARD_SURFACE, FIELD, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import PrimeRadiantFolderPicker from "./PrimeRadiantFolderPicker";
import { useTokensByRun } from "./PrimeRadiantUsage";
import {
  API,
  errorText,
  formatTokens,
  formatWhen,
  jsonInit,
  prJson,
  shortSha,
  type PrimeRadiantSettings as Settings,
  type RunRecord,
} from "./prime-radiant-ui";

interface SettingsAnswer {
  settings: Settings;
  defaults: Settings;
  limits: {
    ingestParallel: { min: number; max: number };
    ingestFolders: number;
    domains: number;
    opusMaxPages?: { min: number; max: number };
    /** Absent on a server from before the setting. */
    searchIndexLimitMb?: { min: number; max: number };
    /** Absent on a server from before the structure pass. */
    structureCompany?: number;
  };
  nightly: { nextRunAt: number | null };
  /** Which account the second opinion would use tonight (absent on an older server). */
  opusSource?: "api_key" | "subscription" | "none";
}

const OPUS_SOURCE_KEY = {
  api_key: "primeRadiant.settings.opusSourceApiKey",
  subscription: "primeRadiant.settings.opusSourceSubscription",
  none: "primeRadiant.settings.opusSourceNone",
} as const;

interface NightlyAnswer {
  running: string | null;
  nextRunAt: number | null;
  runs: RunRecord[];
}

/** One form's worth of edits; the exclude list is kept as typed text until it is saved. */
interface Draft {
  nightlyEnabled: boolean;
  time: string;
  contradictions: boolean;
  opusEnabled: boolean;
  opusMaxPages: string;
  parallel: string;
  searchIndexLimitMb: string;
  exclude: string;
  skipCodeProjects: boolean;
  folders: string[];
  domains: Array<{ name: string; owner: string }>;
  structure: boolean;
  company: string;
}

function draftOf(s: Settings): Draft {
  return {
    nightlyEnabled: s.nightly.enabled,
    time: s.nightly.time,
    contradictions: s.contradictions.enabled,
    opusEnabled: s.opus.enabled,
    opusMaxPages: String(s.opus.maxPages ?? ""),
    parallel: String(s.ingest.parallel),
    searchIndexLimitMb: String(s.search?.indexLimitMb ?? ""),
    exclude: s.ingest.exclude.join("\n"),
    skipCodeProjects: s.ingest.skipCodeProjects,
    folders: [...s.ingest.folders],
    domains: s.domains.map((d) => ({ ...d })),
    // Absent on a server from before the structure pass.
    structure: s.structure?.enabled ?? true,
    company: s.structure?.company ?? "",
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Settings: the nightly pass (on/off, its time, the folders it re-reads), the
 * contradiction pass, the optional Opus tier, the domains and their owners,
 * the ingest exclude list, how many model calls run at once and how big the
 * search index may grow — and the
 * nightly pass itself: Run now, the last nights with the tokens each used, and
 * a Merge button for a night that was held for review once its items are
 * settled.
 *
 * No money is shown. The Opus tier's dollar cap is a figure on the wire, so
 * it is not offered here: a save sends back the cap the box already has, and
 * the server keeps holding an API key to it. Its PAGE cap is offered — the
 * one that holds on a Claude subscription — beside which account it will use.
 */
export default function PrimeRadiantSettings({ onChanged }: { onChanged: () => void }) {
  const { t, locale } = useT();
  const [answer, setAnswer] = useState<SettingsAnswer | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    prJson<SettingsAnswer>(`${API}/settings`, { signal: ctl.signal })
      .then((a) => { setAnswer(a); setDraft(draftOf(a.settings)); })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        setError(errorText(err, t));
      });
    return () => ctl.abort();
  }, [t]);

  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const save = async () => {
    if (!draft || !answer) return;
    const parallel = Number(draft.parallel);
    if (!TIME_RE.test(draft.time)) return setError(t("primeRadiant.settings.badTime"));
    if (!Number.isInteger(parallel) || parallel < answer.limits.ingestParallel.min || parallel > answer.limits.ingestParallel.max) {
      return setError(t("primeRadiant.settings.badParallel", { min: answer.limits.ingestParallel.min, max: answer.limits.ingestParallel.max }));
    }
    // Only while the tier is on: the field is disabled otherwise, so a bad value there could not be fixed.
    const pagesLimit = draft.opusEnabled ? answer.limits.opusMaxPages : undefined;
    const maxPages = Number(draft.opusMaxPages);
    if (pagesLimit && (!Number.isInteger(maxPages) || maxPages < pagesLimit.min || maxPages > pagesLimit.max)) {
      return setError(t("primeRadiant.settings.badOpusMaxPages", { min: pagesLimit.min, max: pagesLimit.max }));
    }
    const indexLimit = answer.limits.searchIndexLimitMb;
    const indexLimitMb = Number(draft.searchIndexLimitMb);
    if (indexLimit && (!Number.isInteger(indexLimitMb) || indexLimitMb < indexLimit.min || indexLimitMb > indexLimit.max)) {
      return setError(t("primeRadiant.settings.badSearchIndexLimit", { min: indexLimit.min, max: indexLimit.max }));
    }
    const domains = draft.domains.map((d) => ({ name: d.name.trim(), owner: d.owner.trim() })).filter((d) => d.name);
    setSaving(true);
    setError(null);
    try {
      const next = await prJson<SettingsAnswer>(`${API}/settings`, jsonInit("PUT", {
        nightly: { enabled: draft.nightlyEnabled, time: draft.time },
        contradictions: { enabled: draft.contradictions },
        opus: { enabled: draft.opusEnabled, capUsd: answer.settings.opus.capUsd, ...(pagesLimit ? { maxPages } : {}) },
        ingest: {
          parallel,
          exclude: draft.exclude.split("\n").map((l) => l.trim()).filter(Boolean),
          skipCodeProjects: draft.skipCodeProjects,
          folders: draft.folders,
        },
        ...(indexLimit ? { search: { indexLimitMb } } : {}),
        ...(answer.settings.structure ? { structure: { enabled: draft.structure, company: draft.company.trim() } } : {}),
        domains,
      }));
      setAnswer(next);
      setDraft(draftOf(next.settings));
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="prime-radiant-settings">
      <PrimeRadiantNightly onChanged={onChanged} />

      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {!draft && !error && <p role="status" className="text-xs text-[var(--text-muted)]">{t("primeRadiant.loading")}</p>}

      {draft && answer && (
        <>
          <section className={`${CARD_SURFACE} p-4 space-y-3`}>
            <h3 className={SECTION_LABEL}>{t("primeRadiant.settings.scheduleTitle")}</h3>
            <Toggle label={t("primeRadiant.settings.nightlyOn")} checked={draft.nightlyEnabled} onChange={(v) => set({ nightlyEnabled: v })} testId="prime-radiant-nightly-enabled" />
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              {t("primeRadiant.settings.time")}
              <input type="time" className={`${FIELD} text-xs`} value={draft.time} onChange={(e) => set({ time: e.target.value })} disabled={!draft.nightlyEnabled} data-testid="prime-radiant-nightly-time" />
            </label>
            {!!answer.nightly.nextRunAt && draft.nightlyEnabled && (
              <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.settings.nextRun", { at: formatWhen(answer.nightly.nextRunAt, locale) })}</p>
            )}
            <Toggle label={t("primeRadiant.settings.contradictions")} checked={draft.contradictions} onChange={(v) => set({ contradictions: v })} testId="prime-radiant-contradictions" />
            {answer.settings.structure && (
              <Toggle label={t("primeRadiant.settings.structure")} checked={draft.structure} onChange={(v) => set({ structure: v })} testId="prime-radiant-structure" />
            )}
            <div>
              <p className="text-xs text-[var(--text-secondary)]">{t("primeRadiant.settings.nightlyFolders")}</p>
              <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.settings.nightlyFoldersBody")}</p>
              <div className="mt-2">
                <PrimeRadiantFolderPicker folders={draft.folders} onChange={(folders) => set({ folders })} max={answer.limits.ingestFolders} testId="prime-radiant-nightly-folders" />
              </div>
            </div>
          </section>

          <section className={`${CARD_SURFACE} p-4 space-y-3`}>
            <h3 className={SECTION_LABEL}>{t("primeRadiant.settings.opusTitle")}</h3>
            <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.settings.opusBody")}</p>
            {answer.opusSource && (
              <p
                className={`text-[11px] ${answer.opusSource === "none" ? "text-amber-200" : "text-[var(--text-secondary)]"}`}
                data-testid="prime-radiant-opus-source"
                data-source={answer.opusSource}
              >
                {t(OPUS_SOURCE_KEY[answer.opusSource])}
              </p>
            )}
            <Toggle label={t("primeRadiant.settings.opusOn")} checked={draft.opusEnabled} onChange={(v) => set({ opusEnabled: v })} testId="prime-radiant-opus-enabled" />
            {answer.limits.opusMaxPages && (
              <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                {t("primeRadiant.settings.opusMaxPages")}
                <input
                  type="number"
                  inputMode="numeric"
                  className={`${FIELD} text-xs w-24`}
                  min={answer.limits.opusMaxPages.min}
                  max={answer.limits.opusMaxPages.max}
                  value={draft.opusMaxPages}
                  onChange={(e) => set({ opusMaxPages: e.target.value })}
                  disabled={!draft.opusEnabled}
                  data-testid="prime-radiant-opus-max-pages"
                />
              </label>
            )}
          </section>

          <section className={`${CARD_SURFACE} p-4 space-y-3`}>
            <h3 className={SECTION_LABEL}>{t("primeRadiant.settings.domainsTitle")}</h3>
            {answer.settings.structure && (
              <label className="block space-y-1">
                <span className="text-xs text-[var(--text-secondary)]">{t("primeRadiant.settings.company")}</span>
                <input
                  className={`${FIELD} text-xs w-full`}
                  value={draft.company}
                  maxLength={answer.limits.structureCompany ?? 80}
                  onChange={(e) => set({ company: e.target.value })}
                  data-testid="prime-radiant-company"
                />
                <span className="block text-[11px] text-[var(--text-muted)]">{t("primeRadiant.settings.companyBody")}</span>
              </label>
            )}
            <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.settings.domainsBody")}</p>
            <ul className="space-y-1.5" data-testid="prime-radiant-domains">
              {draft.domains.map((d, i) => (
                <li key={i} className="flex gap-2">
                  <input
                    className={`${FIELD} text-xs flex-1`}
                    value={d.name}
                    placeholder={t("primeRadiant.settings.domainName")}
                    aria-label={t("primeRadiant.settings.domainName")}
                    onChange={(e) => set({ domains: draft.domains.map((x, j) => (j === i ? { ...x, name: e.target.value.toLowerCase() } : x)) })}
                  />
                  <input
                    className={`${FIELD} text-xs flex-1`}
                    value={d.owner}
                    placeholder={t("primeRadiant.settings.domainOwner")}
                    aria-label={t("primeRadiant.settings.domainOwner")}
                    onChange={(e) => set({ domains: draft.domains.map((x, j) => (j === i ? { ...x, owner: e.target.value } : x)) })}
                  />
                  <button type="button" className={BTN_QUIET} onClick={() => set({ domains: draft.domains.filter((_, j) => j !== i) })} aria-label={t("primeRadiant.settings.removeDomain")}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">close</span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={BTN_SECONDARY}
              disabled={draft.domains.length >= answer.limits.domains}
              onClick={() => set({ domains: [...draft.domains, { name: "", owner: "" }] })}
              data-testid="prime-radiant-add-domain"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">add</span>
              {t("primeRadiant.settings.addDomain")}
            </button>
          </section>

          <section className={`${CARD_SURFACE} p-4 space-y-3`}>
            <h3 className={SECTION_LABEL}>{t("primeRadiant.settings.ingestTitle")}</h3>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              {t("primeRadiant.settings.parallel")}
              <input
                type="number"
                min={answer.limits.ingestParallel.min}
                max={answer.limits.ingestParallel.max}
                className={`${FIELD} text-xs w-24`}
                value={draft.parallel}
                onChange={(e) => set({ parallel: e.target.value })}
                data-testid="prime-radiant-parallel"
              />
            </label>
            <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.settings.parallelBody", { n: answer.defaults.ingest.parallel })}</p>
            <Toggle label={t("primeRadiant.settings.skipCodeProjects")} checked={draft.skipCodeProjects} onChange={(v) => set({ skipCodeProjects: v })} testId="prime-radiant-skip-code-projects" />
            <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.settings.skipCodeProjectsBody")}</p>
            <label className="block text-xs text-[var(--text-secondary)]" htmlFor="pr-exclude">{t("primeRadiant.settings.exclude")}</label>
            <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.settings.excludeBody")}</p>
            <textarea
              id="pr-exclude"
              className={`${FIELD} w-full h-32 font-mono text-[11px]`}
              value={draft.exclude}
              onChange={(e) => set({ exclude: e.target.value })}
              data-testid="prime-radiant-exclude"
            />
            <button type="button" className={BTN_QUIET} onClick={() => set({ exclude: answer.defaults.ingest.exclude.join("\n") })}>
              {t("primeRadiant.settings.excludeDefaults")}
            </button>
          </section>

          {answer.limits.searchIndexLimitMb && (
            <section className={`${CARD_SURFACE} p-4 space-y-3`}>
              <h3 className={SECTION_LABEL}>{t("primeRadiant.settings.searchTitle")}</h3>
              <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                {t("primeRadiant.settings.searchIndexLimit")}
                <input
                  type="number"
                  inputMode="numeric"
                  min={answer.limits.searchIndexLimitMb.min}
                  max={answer.limits.searchIndexLimitMb.max}
                  step={1}
                  className={`${FIELD} text-xs w-24`}
                  value={draft.searchIndexLimitMb}
                  onChange={(e) => set({ searchIndexLimitMb: e.target.value })}
                  data-testid="prime-radiant-search-index-limit"
                />
                <span className="text-[var(--text-muted)]">MB</span>
              </label>
              <p className="text-[11px] text-[var(--text-muted)]">
                {t("primeRadiant.settings.searchIndexLimitBody", { n: answer.defaults.search.indexLimitMb })}
              </p>
            </section>
          )}

          <div className="flex items-center gap-3">
            <button type="button" className={BTN_PRIMARY} onClick={() => void save()} disabled={saving} data-testid="prime-radiant-settings-save">
              {saving ? t("primeRadiant.settings.saving") : t("primeRadiant.settings.save")}
            </button>
            {saved && <span role="status" className="text-xs text-emerald-300">{t("primeRadiant.settings.saved")}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function Toggle({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
      <input type="checkbox" className="accent-[var(--coral-bright)]" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {label}
    </label>
  );
}

/** The nightly pass: Run now, recent nights, and Merge for a held one. */
function PrimeRadiantNightly({ onChanged }: { onChanged: () => void }) {
  const { t, locale } = useT();
  const [state, setState] = useState<NightlyAnswer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    () => prJson<NightlyAnswer>(`${API}/nightly`).then(setState).catch((err) => setError(errorText(err, t))),
    [t],
  );

  useEffect(() => { void load(); }, [load]);

  // While a pass runs, look again every few seconds; nothing is polled otherwise.
  useEffect(() => {
    if (!state?.running) return;
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [state?.running, load]);

  const runNow = async () => {
    setBusy("run");
    setError(null);
    setNote(null);
    try {
      await prJson(`${API}/nightly/run`, jsonInit("POST", {}));
      setNote(t("primeRadiant.nightly.started"));
      await load();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(null);
    }
  };

  const merge = async (branch: string) => {
    setBusy(branch);
    setError(null);
    setNote(null);
    try {
      const r = await prJson<{ commit: string }>(`${API}/nightly/run`, jsonInit("POST", { merge: branch }));
      setNote(t("primeRadiant.nightly.merged", { branch, sha: shortSha(r.commit) }));
      await load();
      onChanged();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(null);
    }
  };

  const runs = state?.runs ?? [];
  // A night's own calls, and those of the import it ran for the nightly folders.
  const tokensByRun = useTokensByRun(state);
  const tokensOf = (run: RunRecord) => {
    const job = (run.summary as { ingest?: { jobId?: unknown } } | null)?.ingest?.jobId;
    return (tokensByRun?.get(run.id) ?? 0) + (typeof job === "string" ? (tokensByRun?.get(job) ?? 0) : 0);
  };
  return (
    <section className={`${CARD_SURFACE} p-4 space-y-3`} data-testid="prime-radiant-nightly">
      <div className="flex items-center justify-between gap-2">
        <h3 className={SECTION_LABEL}>{t("primeRadiant.nightly.title")}</h3>
        <button type="button" className={BTN_SECONDARY} onClick={() => void runNow()} disabled={busy !== null || !!state?.running} data-testid="prime-radiant-nightly-run">
          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">play_arrow</span>
          {state?.running ? t("primeRadiant.nightly.running") : t("primeRadiant.nightly.runNow")}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {note && <p role="status" className="text-xs text-emerald-300">{note}</p>}
      {runs.length === 0 && <p className="text-xs text-[var(--text-muted)]">{t("primeRadiant.nightly.none")}</p>}
      <ul className="space-y-1.5">
        {runs.slice(0, 10).map((run) => {
          const held = run.status === "held" && run.branch;
          const reasons = Array.isArray((run.summary as { held?: unknown } | null)?.held)
            ? ((run.summary as { held: string[] }).held)
            : [];
          return (
            <li key={run.id} className={`${INSET_SURFACE} px-3 py-2`} data-testid="prime-radiant-nightly-run-row" data-status={run.status}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={held ? "text-amber-200" : run.status === "failed" ? "text-red-300" : "text-[var(--text-primary)]"}>
                  {t(`primeRadiant.nightly.status.${run.status}`)}
                </span>
                <span className="text-[var(--text-muted)]">{formatWhen(run.startedAt, locale)}</span>
                {tokensOf(run) > 0 && (
                  <span className="text-[var(--text-muted)] tabular-nums" data-testid="prime-radiant-nightly-tokens">
                    {t("primeRadiant.tokens", { n: formatTokens(tokensOf(run), locale) })}
                  </span>
                )}
                {run.branch && <span className="font-mono text-[11px] text-[var(--text-muted)]">{run.branch}</span>}
                {held && (
                  <button
                    type="button"
                    className={`${BTN_PRIMARY} ml-auto`}
                    disabled={busy !== null}
                    onClick={() => void merge(run.branch as string)}
                    data-testid="prime-radiant-nightly-merge"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">call_merge</span>
                    {busy === run.branch ? t("primeRadiant.nightly.merging") : t("primeRadiant.nightly.merge")}
                  </button>
                )}
              </div>
              {held && reasons.length > 0 && (
                <p className="mt-0.5 text-[11px] text-amber-200/80">
                  {reasons.map((r) => t(`primeRadiant.nightly.heldReason.${r}`)).join(" · ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {runs.some((r) => r.status === "held" && r.branch) && (
        <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.nightly.heldHelp")}</p>
      )}
    </section>
  );
}
