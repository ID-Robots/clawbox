"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { DAILY_LANGUAGE_NAMES, DAILY_LANGUAGES, type DailyLanguage } from "@/lib/prime-radiant/daily";
import { BTN_DANGER, BTN_PRIMARY, BTN_QUIET, BTN_SECONDARY, CARD_SURFACE, FIELD, INSET_SURFACE, SECTION_LABEL } from "./coding-agent-ui";
import {
  API,
  errorText,
  formatWhen,
  jsonInit,
  pageLabel,
  prJson,
  type DailyAnswerBody,
  type GoldenListAnswer,
  type GoldenQuestion,
  type GoldenStatus,
  type GoldenVerdict,
  type PrimeRadiantSettings,
} from "./prime-radiant-ui";

/**
 * Questions: how well the wiki answers the owner's own test, and what each
 * owner is asked to confirm today.
 *
 *  - Accuracy: the latest nightly check of the golden questions — % correct,
 *    its change and a trend line — with how many came back right, wrong,
 *    missing or out of date.
 *  - Golden questions: each with its expected answer, owner and last verdict;
 *    add, edit and delete them (one commit each, undone by its id).
 *  - Daily questions: one owner at a time, in their language — open review
 *    items, unverified key facts, pages due a re-check — each opening the
 *    page or the Review tab, where it is answered like any other question.
 *    The owner's switch for the assistant sending them over chat sits here,
 *    off until turned on; nothing is ever sent on its own.
 */

interface Props {
  revision: number;
  domains: string[];
  golden: GoldenStatus | null | undefined;
  onChanged: () => void;
  onOpenPage: (path: string) => void;
  onOpenReview: () => void;
}

const VERDICT_TONE: Record<GoldenVerdict | "none", string> = {
  correct: "border-emerald-400/30 text-emerald-300",
  wrong: "border-red-400/30 text-red-300",
  missing: "border-amber-400/30 text-amber-200",
  stale: "border-sky-400/30 text-sky-200",
  none: "border-white/15 text-[var(--text-muted)]",
};

/** The trend as a small line, oldest point on the left, 0–100 % bottom to top. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 120;
  const h = 32;
  const step = w / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - (Math.max(0, Math.min(100, p)) / 100) * h).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" aria-hidden="true" data-testid="prime-radiant-accuracy-trend">
      <path d={d} fill="none" stroke="var(--coral-bright)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Accuracy({ score }: { score: GoldenStatus | null | undefined }) {
  const { t, locale } = useT();
  const last = score?.last ?? null;
  const change = score?.change ?? null;
  return (
    <section className={`${CARD_SURFACE} p-4`} data-testid="prime-radiant-accuracy">
      <h3 className={SECTION_LABEL}>{t("primeRadiant.questions.accuracy")}</h3>
      {!last || last.percent === null ? (
        <p className="mt-2 text-sm text-[var(--text-muted)]">{t("primeRadiant.questions.accuracyNone")}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]" data-testid="prime-radiant-accuracy-percent">
              {t("primeRadiant.questions.percentCorrect", { percent: last.percent.toLocaleString(locale) })}
            </p>
            <p className="mt-1 text-[11px] text-[var(--text-muted)] flex flex-wrap gap-x-3">
              {change !== null && (
                <span className={change > 0 ? "text-emerald-300" : change < 0 ? "text-red-300" : undefined} data-testid="prime-radiant-accuracy-change">
                  {t("primeRadiant.questions.change", { change: `${change > 0 ? "+" : ""}${change.toLocaleString(locale)}` })}
                </span>
              )}
              <span>{t("primeRadiant.questions.lastChecked", { when: formatWhen(last.at, locale) })}</span>
            </p>
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
              {t("primeRadiant.questions.tally", { correct: last.correct, wrong: last.wrong, missing: last.missing, stale: last.stale })}
            </p>
          </div>
          <Sparkline points={(score?.trend ?? []).map((p) => p.percent)} />
        </div>
      )}
    </section>
  );
}

interface Draft {
  question: string;
  expected: string;
  domain: string;
  owner: string;
  claimId: string;
  page: string;
}

const emptyDraft = (domain: string): Draft => ({ question: "", expected: "", domain, owner: "", claimId: "", page: "" });

/** The owner as the list shows it: the store's "unassigned" is no name. */
const ownerLabel = (owner: string, t: (key: string) => string) => (owner === "unassigned" ? t("primeRadiant.questions.noOwner") : owner);

function GoldenForm({ initial, domains, onSave, onCancel, busy }: { initial: Draft; domains: string[]; onSave: (d: Draft) => void; onCancel: () => void; busy: boolean }) {
  const { t } = useT();
  const [d, setD] = useState<Draft>(initial);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  const ready = d.question.trim() !== "" && d.expected.trim() !== "" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d.domain);
  return (
    <form
      className={`${INSET_SURFACE} p-3 space-y-2`}
      data-testid="prime-radiant-golden-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onSave(d);
      }}
    >
      <label className="block text-[11px] text-[var(--text-muted)]">
        {t("primeRadiant.questions.question")}
        <input className={`${FIELD} mt-1 w-full`} value={d.question} onChange={set("question")} maxLength={300} data-testid="prime-radiant-golden-question" />
      </label>
      <label className="block text-[11px] text-[var(--text-muted)]">
        {t("primeRadiant.questions.expected")}
        <input className={`${FIELD} mt-1 w-full`} value={d.expected} onChange={set("expected")} maxLength={500} data-testid="prime-radiant-golden-expected" />
      </label>
      <div className="grid gap-2 @md:grid-cols-2">
        <label className="block text-[11px] text-[var(--text-muted)]">
          {t("primeRadiant.questions.domain")}
          <input className={`${FIELD} mt-1 w-full`} value={d.domain} onChange={set("domain")} list="prime-radiant-golden-domains" maxLength={64} data-testid="prime-radiant-golden-domain" />
          <datalist id="prime-radiant-golden-domains">
            {domains.map((x) => <option key={x} value={x} />)}
          </datalist>
        </label>
        <label className="block text-[11px] text-[var(--text-muted)]">
          {t("primeRadiant.questions.ownerOptional")}
          <input className={`${FIELD} mt-1 w-full`} value={d.owner} onChange={set("owner")} maxLength={80} data-testid="prime-radiant-golden-owner" />
        </label>
        <label className="block text-[11px] text-[var(--text-muted)]">
          {t("primeRadiant.questions.pageOptional")}
          <input className={`${FIELD} mt-1 w-full`} value={d.page} onChange={set("page")} maxLength={512} data-testid="prime-radiant-golden-page" />
        </label>
        <label className="block text-[11px] text-[var(--text-muted)]">
          {t("primeRadiant.questions.claimOptional")}
          <input className={`${FIELD} mt-1 w-full font-mono`} value={d.claimId} onChange={set("claimId")} maxLength={200} spellCheck={false} data-testid="prime-radiant-golden-claim" />
        </label>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" className={BTN_QUIET} onClick={onCancel}>{t("primeRadiant.questions.cancel")}</button>
        <button type="submit" className={BTN_PRIMARY} disabled={!ready || busy} data-testid="prime-radiant-golden-save">{t("primeRadiant.questions.save")}</button>
      </div>
    </form>
  );
}

function GoldenRow({
  q,
  verdict,
  domains,
  busy,
  onSave,
  onDelete,
  onOpenPage,
}: {
  q: GoldenQuestion;
  verdict: GoldenVerdict | null;
  domains: string[];
  busy: boolean;
  onSave: (d: Draft) => Promise<boolean>;
  onDelete: () => void;
  onOpenPage: (path: string) => void;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // The armed confirm takes the focus, so leaving it (a click or Tab elsewhere) disarms it.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  if (editing) {
    return (
      <li>
        <GoldenForm
          initial={{ question: q.question, expected: q.expected, domain: q.domain, owner: q.owner === "unassigned" ? "" : q.owner, claimId: q.claimId ?? "", page: q.page ?? "" }}
          domains={domains}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(d) => {
            // The form stays open (with what was typed) until the change is saved.
            void onSave(d).then((ok) => {
              if (ok) setEditing(false);
            });
          }}
        />
      </li>
    );
  }
  return (
    <li className={`${INSET_SURFACE} px-3 py-2 flex flex-wrap items-start gap-3`} data-testid="prime-radiant-golden-row" data-verdict={verdict ?? "none"}>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text-primary)]">{q.question}</p>
        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">→ {q.expected}</p>
        <p className="mt-1 text-[11px] text-[var(--text-muted)] flex flex-wrap gap-x-3">
          <span>{ownerLabel(q.owner, t)}</span>
          <span>{q.domain}</span>
          {q.claimId && <span className="font-mono" data-testid="prime-radiant-golden-row-claim">{q.claimId}</span>}
          {q.page && (
            <button type="button" onClick={() => onOpenPage(q.page as string)} className="text-[var(--coral-bright)] hover:underline cursor-pointer">
              {pageLabel(q.page)}
            </button>
          )}
        </p>
      </div>
      <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider rounded-full border px-2 py-0.5 ${VERDICT_TONE[verdict ?? "none"]}`}>
        {t(`primeRadiant.questions.verdict.${verdict ?? "none"}`)}
      </span>
      <div className="shrink-0 flex gap-1">
        <button type="button" className={BTN_QUIET} onClick={() => setEditing(true)} disabled={busy} data-testid="prime-radiant-golden-edit">
          {t("primeRadiant.questions.edit")}
        </button>
        {confirming ? (
          // Armed only while it has the focus: a click elsewhere, or the delete itself, asks again next time.
          <button
            ref={confirmRef}
            type="button"
            className={BTN_DANGER}
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
            onBlur={() => setConfirming(false)}
            disabled={busy}
            data-testid="prime-radiant-golden-delete-confirm"
          >
            {t("primeRadiant.questions.deleteConfirm")}
          </button>
        ) : (
          <button type="button" className={BTN_QUIET} onClick={() => setConfirming(true)} disabled={busy} data-testid="prime-radiant-golden-delete">
            {t("primeRadiant.questions.delete")}
          </button>
        )}
      </div>
    </li>
  );
}

function bodyOf(d: Draft, editing: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { question: d.question.trim(), expected: d.expected.trim(), domain: d.domain.trim() };
  const owner = d.owner.trim();
  const page = d.page.trim();
  const claimId = d.claimId.trim();
  if (owner) out.owner = owner;
  else if (editing) out.owner = null;
  if (page) out.page = page;
  else if (editing) out.page = null;
  if (claimId) out.claimId = claimId;
  else if (editing) out.claimId = null;
  return out;
}

function Golden({ revision, domains, onChanged, onOpenPage }: Pick<Props, "revision" | "domains" | "onChanged" | "onOpenPage">) {
  const { t } = useT();
  const [list, setList] = useState<GoldenListAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    prJson<GoldenListAnswer>(`${API}/golden`, { signal: ctl.signal })
      .then((r) => {
        setList(r);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        setError(errorText(err, t));
      });
    return () => ctl.abort();
  }, [revision, t]);

  /** One change; whether it was saved (a refused one keeps its form open). */
  const write = async (url: string, init: RequestInit): Promise<boolean> => {
    setBusy(true);
    try {
      await prJson(url, init);
      setError(null);
      setAdding(false);
      onChanged();
      return true;
    } catch (err) {
      setError(errorText(err, t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const questions = list?.questions ?? [];
  return (
    <section className="space-y-2" data-testid="prime-radiant-golden">
      <div className="flex items-center justify-between gap-2">
        <h3 className={SECTION_LABEL}>{t("primeRadiant.questions.golden")}</h3>
        {!adding && (
          <button type="button" className={BTN_SECONDARY} onClick={() => setAdding(true)} data-testid="prime-radiant-golden-add">
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">add</span>
            {t("primeRadiant.questions.add")}
          </button>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.questions.goldenHint")}</p>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {(list?.skipped ?? 0) > 0 && (
        <p role="status" className="text-xs text-amber-200" data-testid="prime-radiant-golden-unreadable">
          {t("primeRadiant.questions.unreadable")}
        </p>
      )}
      {adding && (
        <GoldenForm
          initial={emptyDraft(domains[0] ?? "")}
          domains={domains}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={(d) => void write(`${API}/golden`, jsonInit("POST", bodyOf(d, false)))}
        />
      )}
      {list && questions.length === 0 && !adding && (
        <p className="text-sm text-[var(--text-muted)]" data-testid="prime-radiant-golden-empty">{t("primeRadiant.questions.goldenEmpty")}</p>
      )}
      {questions.length > 0 && (
        <ul className="space-y-2">
          {questions.map((q) => (
            <GoldenRow
              key={q.id}
              q={q}
              verdict={list?.verdicts[q.id]?.verdict ?? null}
              domains={domains}
              busy={busy}
              onOpenPage={onOpenPage}
              onSave={(d) => write(`${API}/golden/${encodeURIComponent(q.id)}`, jsonInit("PATCH", bodyOf(d, true)))}
              onDelete={() => void write(`${API}/golden/${encodeURIComponent(q.id)}`, { method: "DELETE" })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Daily({ revision, onOpenPage, onOpenReview }: Pick<Props, "revision" | "onOpenPage" | "onOpenReview">) {
  const { t } = useT();
  const [owner, setOwner] = useState<string | null>(null);
  const [answer, setAnswer] = useState<DailyAnswerBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const latest = useRef(0);

  const load = useCallback(
    (who: string | null, signal?: AbortSignal) => {
      const n = ++latest.current;
      const url = who ? `${API}/daily?owner=${encodeURIComponent(who)}` : `${API}/daily`;
      prJson<DailyAnswerBody>(url, { signal })
        .then((r) => {
          if (n !== latest.current) return;
          setAnswer(r);
          setError(null);
          // The first owner with something to ask is the one shown first.
          if (!who && r.owners.length > 0) {
            const first = r.owners.find((o) => o.waiting > 0) ?? r.owners[0];
            setOwner(first.owner);
          }
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError" || n !== latest.current) return;
          setError(errorText(err, t));
        });
    },
    [t],
  );

  useEffect(() => {
    const ctl = new AbortController();
    load(owner, ctl.signal);
    return () => ctl.abort();
  }, [owner, revision, load]);

  /** Settings the owner changes here: the language of one owner's questions, and whether the assistant may send them. */
  const saveSettings = async (patch: (s: PrimeRadiantSettings) => Record<string, unknown>) => {
    setSaving(true);
    try {
      const current = await prJson<{ settings: PrimeRadiantSettings }>(`${API}/settings`);
      await prJson(`${API}/settings`, jsonInit("PUT", patch(current.settings)));
      setError(null);
      load(owner);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setSaving(false);
    }
  };

  const setLanguage = (language: DailyLanguage) => {
    if (!owner) return;
    void saveSettings((s) => {
      const others = s.verification.languages.filter((l) => l.owner.toLowerCase() !== owner.toLowerCase());
      return { verification: { languages: language === "en" ? others : [...others, { owner, language }] } };
    });
  };

  const owners = useMemo(() => answer?.owners ?? [], [answer]);
  const current = useMemo(() => owners.find((o) => o.owner === owner) ?? null, [owners, owner]);
  const outbound = answer?.outbound ?? false;

  return (
    <section className="space-y-2" data-testid="prime-radiant-daily">
      <h3 className={SECTION_LABEL}>{t("primeRadiant.questions.daily")}</h3>
      <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.questions.dailyHint")}</p>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {answer && owners.length === 0 && <p className="text-sm text-[var(--text-muted)]" data-testid="prime-radiant-daily-none">{t("primeRadiant.questions.dailyNone")}</p>}
      {owners.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-[var(--text-muted)]">
            {t("primeRadiant.questions.dailyOwner")}
            <select className={`${FIELD} mt-1 block`} value={owner ?? ""} onChange={(e) => setOwner(e.target.value)} data-testid="prime-radiant-daily-owner">
              {owners.map((o) => (
                <option key={o.owner} value={o.owner}>{`${o.owner} (${o.waiting})`}</option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-[var(--text-muted)]">
            {t("primeRadiant.questions.language")}
            <select
              className={`${FIELD} mt-1 block`}
              value={current?.language ?? "en"}
              disabled={!current || saving}
              onChange={(e) => setLanguage(e.target.value as DailyLanguage)}
              data-testid="prime-radiant-daily-language"
            >
              {DAILY_LANGUAGES.map((l) => (
                <option key={l} value={l}>{DAILY_LANGUAGE_NAMES[l]}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {answer && owner && answer.owner === owner && (
        answer.questions.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]" data-testid="prime-radiant-daily-empty">{t("primeRadiant.questions.dailyEmpty", { owner })}</p>
        ) : (
          <ol className="space-y-2">
            {answer.questions.map((q, i) => (
              <li key={`${q.kind}-${q.reviewId ?? q.claimId ?? q.page}`} className={`${INSET_SURFACE} px-3 py-2 flex items-start gap-3`} data-testid="prime-radiant-daily-question" data-kind={q.kind}>
                <span className="shrink-0 mt-0.5 text-[11px] tabular-nums text-[var(--text-muted)]">{i + 1}.</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--text-primary)]" lang={answer.language ?? undefined}>{q.question}</p>
                  {q.options && q.options.length > 1 && (
                    <ul className="mt-1 text-xs text-[var(--text-secondary)] list-disc pl-4">
                      {q.options.map((o, j) => <li key={j}>{o}</li>)}
                    </ul>
                  )}
                  {/* The question itself names the day in every language it is worded in; a second line would repeat it. */}
                  {q.due && !q.question.includes(q.due) && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{t("primeRadiant.questions.due", { date: q.due })}</p>}
                </div>
                {q.kind === "review" ? (
                  <button type="button" className={BTN_QUIET} onClick={onOpenReview} data-testid="prime-radiant-daily-open-review">{t("primeRadiant.questions.openReview")}</button>
                ) : (
                  <button type="button" className={BTN_QUIET} onClick={() => onOpenPage(q.page)} data-testid="prime-radiant-daily-open">{t("primeRadiant.questions.open")}</button>
                )}
              </li>
            ))}
          </ol>
        )
      )}
      {answer?.initialised && (
        <label className={`${INSET_SURFACE} mt-2 px-3 py-2 flex items-start gap-3 cursor-pointer`}>
          <input
            type="checkbox"
            className="mt-0.5 accent-[var(--coral-bright)]"
            checked={outbound}
            disabled={saving}
            onChange={(e) => {
              const on = e.target.checked;
              void saveSettings(() => ({ verification: { outbound: on } }));
            }}
            data-testid="prime-radiant-daily-outbound"
          />
          <span>
            <span className="block text-xs text-[var(--text-primary)]">{t("primeRadiant.questions.sendLabel")}</span>
            <span className="block text-[11px] text-[var(--text-muted)]">{t(outbound ? "primeRadiant.questions.sendOn" : "primeRadiant.questions.sendOff")}</span>
          </span>
        </label>
      )}
    </section>
  );
}

/** A whole number typed in a small field, saved when the field is left with a new value in range. */
function NumberSetting({ label, value, min, max, disabled, onSave, testId }: { label: string; value: number; min: number; max: number; disabled: boolean; onSave: (n: number) => Promise<boolean>; testId: string }) {
  const [text, setText] = useState(String(value));
  // A new saved value replaces what the field shows, adjusted while rendering rather than in an effect.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(String(value));
  }
  const commit = () => {
    const n = Number(text);
    if (Number.isInteger(n) && n >= min && n <= max && n !== value) {
      // A refused save shows the value that is still in force, not the one typed.
      void onSave(n).then((ok) => {
        if (!ok) setText(String(value));
      });
    } else setText(String(value));
  };
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-[var(--text-primary)]">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        className={`${FIELD} w-20 text-right tabular-nums`}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        data-testid={testId}
      />
    </label>
  );
}

/** The bounds GET settings answers for these fields (an older server answers none: the fields keep the ones it had). */
interface CheckLimits {
  goldenMaxQuestions?: { min: number; max: number };
  dailyPerOwner?: { min: number; max: number };
}

/** The two checks' own settings: the nightly golden check (on, its cap) and the daily questions an owner gets. */
function Checks({ revision, onChanged }: Pick<Props, "revision" | "onChanged">) {
  const { t } = useT();
  const [settings, setSettings] = useState<PrimeRadiantSettings | null>(null);
  const [limits, setLimits] = useState<CheckLimits>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    prJson<{ settings: PrimeRadiantSettings; limits?: CheckLimits }>(`${API}/settings`, { signal: ctl.signal })
      .then((r) => {
        setSettings(r.settings);
        setLimits(r.limits ?? {});
        setError(null);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        setError(errorText(err, t));
      });
    return () => ctl.abort();
  }, [revision, t]);

  /** One change; whether it was saved. */
  const save = async (patch: Record<string, unknown>): Promise<boolean> => {
    setSaving(true);
    try {
      const r = await prJson<{ settings: PrimeRadiantSettings }>(`${API}/settings`, jsonInit("PUT", patch));
      if (r?.settings) setSettings(r.settings);
      setError(null);
      onChanged();
      return true;
    } catch (err) {
      setError(errorText(err, t));
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return error ? <p role="alert" className="text-xs text-red-300">{error}</p> : null;
  // An older server's settings have neither section: nothing to set here.
  if (!settings.golden || !settings.verification) return null;
  return (
    <section className={`${CARD_SURFACE} p-4 space-y-3`} data-testid="prime-radiant-checks">
      <h3 className={SECTION_LABEL}>{t("primeRadiant.questions.checks")}</h3>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <label className="flex items-center justify-between gap-3 text-xs text-[var(--text-primary)] cursor-pointer">
        <span>{t("primeRadiant.questions.goldenNightly")}</span>
        <input
          type="checkbox"
          className="accent-[var(--coral-bright)]"
          checked={settings.golden.enabled}
          disabled={saving}
          onChange={(e) => void save({ golden: { enabled: e.target.checked } })}
          data-testid="prime-radiant-golden-enabled"
        />
      </label>
      <NumberSetting
        label={t("primeRadiant.questions.goldenMax")}
        value={settings.golden.maxQuestions}
        min={limits.goldenMaxQuestions?.min ?? 1}
        max={limits.goldenMaxQuestions?.max ?? 500}
        disabled={saving || !settings.golden.enabled}
        onSave={(n) => save({ golden: { maxQuestions: n } })}
        testId="prime-radiant-golden-max"
      />
      <NumberSetting
        label={t("primeRadiant.questions.perOwner")}
        value={settings.verification.perOwner}
        min={limits.dailyPerOwner?.min ?? 1}
        max={limits.dailyPerOwner?.max ?? 20}
        disabled={saving}
        onSave={(n) => save({ verification: { perOwner: n } })}
        testId="prime-radiant-daily-per-owner"
      />
    </section>
  );
}

export default function PrimeRadiantQuestions({ revision, domains, golden, onChanged, onOpenPage, onOpenReview }: Props) {
  return (
    <div className="space-y-6" data-testid="prime-radiant-questions">
      <Accuracy score={golden} />
      <Golden revision={revision} domains={domains} onChanged={onChanged} onOpenPage={onOpenPage} />
      <Daily revision={revision} onOpenPage={onOpenPage} onOpenReview={onOpenReview} />
      <Checks revision={revision} onChanged={onChanged} />
    </div>
  );
}
