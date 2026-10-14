"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { BTN_PRIMARY, BTN_QUIET, BTN_SECONDARY, CARD_SURFACE, FIELD, INSET_SURFACE, SEGMENTED_TRACK, SEGMENT_OFF, SEGMENT_ON } from "./coding-agent-ui";
import {
  API,
  errorText,
  formatWhen,
  jsonInit,
  keyPart,
  pageLabel,
  prJson,
  type ReviewItem,
  type ReviewStatus,
  type RunRecord,
} from "./prime-radiant-ui";

interface ReviewList {
  total: number;
  counts: Record<ReviewStatus, number>;
  items: ReviewItem[];
}

const STATUSES: ReviewStatus[] = ["open", "later", "resolved"];

/** One fact a verified answer may be at most this long (the server's own cap). */
const MAX_ANSWER = 240;

/**
 * Review: the questions the vault cannot settle alone — two pages that
 * disagree, a nightly change to a verified page, a lint finding, an Opus
 * proposal. Each shows the disputed fact, the candidate answers with their
 * evidence, and three ways out: keep one candidate, write the right answer,
 * or come back later. Keeping or writing an answer is a VERIFICATION — one
 * commit that replaces the claim and retires the losing ids — so it is the
 * owner's word only (the resolve route refuses the agent).
 */
export default function PrimeRadiantReview({ revision, onChanged, onOpenPage, onOpenSettings }: {
  revision: number;
  onChanged: () => void;
  onOpenPage: (path: string) => void;
  onOpenSettings: () => void;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<ReviewStatus>("open");
  const [list, setList] = useState<ReviewList | null>(null);
  const [held, setHeld] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /** One read of the queue and of the held nights, applied together. */
  const load = useCallback((signal?: AbortSignal) => {
    const queue = prJson<ReviewList>(`${API}/review?status=${status}&limit=100`, { signal });
    // The banner is a pointer; without the nightly list there is nothing to point at.
    const nightly = prJson<{ runs: RunRecord[] }>(`${API}/nightly`, { signal }).catch(() => null);
    return Promise.all([queue, nightly])
      .then(([answer, night]) => {
        setList(answer);
        setError(null);
        if (night) setHeld((night.runs ?? []).filter((r) => r.status === "held" && r.branch).length);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError") return;
        setError(errorText(err, t));
      });
  }, [status, t]);

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load, revision]);

  const settled = () => {
    onChanged();
    void load();
  };

  return (
    <div className="space-y-3" data-testid="prime-radiant-review">
      {held > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100" data-testid="prime-radiant-held-banner">
          <span>{t("primeRadiant.review.heldNights", { n: held })}</span>
          <button type="button" className={BTN_SECONDARY} onClick={onOpenSettings}>{t("primeRadiant.review.openNightly")}</button>
        </div>
      )}

      <div className={SEGMENTED_TRACK} role="radiogroup" aria-label={t("primeRadiant.review.filter")}>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={status === s}
            className={status === s ? SEGMENT_ON : SEGMENT_OFF}
            onClick={() => setStatus(s)}
            data-testid={`prime-radiant-review-status-${s}`}
          >
            {t(`primeRadiant.review.status.${s}`)}
            {list && <span className="tabular-nums text-[var(--text-muted)]">{list.counts[s] ?? 0}</span>}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}

      {list && list.items.length === 0 && (
        <p className="py-8 text-center text-sm text-[var(--text-muted)]" data-testid="prime-radiant-review-empty">
          {status === "open" ? t("primeRadiant.review.emptyOpen") : t("primeRadiant.review.empty")}
        </p>
      )}

      <ul className="space-y-3">
        {list?.items.map((item) => (
          <li key={item.id}>
            <ReviewCard item={item} onSettled={settled} onOpenPage={onOpenPage} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewCard({ item, onSettled, onOpenPage }: {
  item: ReviewItem;
  onSettled: () => void;
  onOpenPage: (path: string) => void;
}) {
  const { t, locale } = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [answer, setAnswer] = useState("");
  const open = item.status !== "resolved";
  const canVerify = open && !!item.claimId;

  const resolve = async (body: Record<string, unknown>, label: string) => {
    if (busy) return;
    setBusy(label);
    setError(null);
    try {
      await prJson(`${API}/review/${encodeURIComponent(item.id)}/resolve`, jsonInit("POST", body));
      onSettled();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`${CARD_SURFACE} p-4 space-y-3`} data-testid="prime-radiant-review-item" data-kind={item.kind}>
      <header className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider rounded-full border border-white/15 px-2 py-0.5 text-[var(--text-secondary)]">
          {t(`primeRadiant.review.kind.${keyPart(item.kind)}`)}
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">{formatWhen(item.createdAt, locale)}</span>
        {item.status === "resolved" && item.resolution && (
          <span className="ml-auto text-[11px] text-emerald-300">{t(`primeRadiant.review.resolved.${item.resolution.action}`)}</span>
        )}
      </header>

      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">{t("primeRadiant.review.disputed")}</h3>
        <p className="mt-0.5 font-mono text-xs text-[var(--text-primary)] break-all" data-testid="prime-radiant-review-claim">
          {item.claimId ?? t("primeRadiant.review.noClaim")}
        </p>
        {item.pages.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-2 text-[11px]">
            {item.pages.map((p) => (
              <button key={p} type="button" onClick={() => onOpenPage(p)} className="text-[var(--coral-bright)] hover:underline cursor-pointer">
                {pageLabel(p)}
              </button>
            ))}
          </p>
        )}
      </div>

      {item.evidence.length > 0 && (
        <ul className="text-[11px] text-[var(--text-secondary)] space-y-0.5">
          {item.evidence.map((e, i) => (
            <li key={i}>{[e.kind, e.verdict, e.note, e.page, e.source].filter(Boolean).join(" · ")}</li>
          ))}
        </ul>
      )}

      {item.candidates.length > 0 && (
        <div>
          <h3 className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">{t("primeRadiant.review.candidates")}</h3>
          <ol className="mt-1.5 space-y-2">
            {item.candidates.map((c, i) => (
              <li key={i} className={`${INSET_SURFACE} px-3 py-2`} data-testid="prime-radiant-review-candidate">
                <p className="text-sm text-[var(--text-primary)]">{c.text}</p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)] flex flex-wrap gap-x-3">
                  {c.page ? (
                    <button type="button" onClick={() => onOpenPage(c.page as string)} className="text-[var(--coral-bright)] hover:underline cursor-pointer">
                      {pageLabel(c.page)}
                    </button>
                  ) : (
                    <span>{t("primeRadiant.review.newAnswer")}</span>
                  )}
                  {c.claimId && <span className="font-mono">{c.claimId}</span>}
                </p>
                {c.evidence.length > 0 && (
                  <ul className="mt-1 text-[11px] text-[var(--text-secondary)] space-y-0.5">
                    {c.evidence.map((e, j) => (
                      <li key={j}>{[e.kind, e.verdict, e.note, e.source].filter(Boolean).join(" · ")}</li>
                    ))}
                  </ul>
                )}
                {canVerify && (
                  <button
                    type="button"
                    className={`${BTN_SECONDARY} mt-2`}
                    disabled={busy !== null}
                    onClick={() => void resolve({ action: "pick", candidate: i }, `pick-${i}`)}
                    data-testid="prime-radiant-review-pick"
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">check</span>
                    {busy === `pick-${i}` ? t("primeRadiant.review.saving") : t("primeRadiant.review.pick")}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {open && writing && canVerify && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = answer.trim();
            if (text) void resolve({ action: "new", text }, "new");
          }}
        >
          <label className="block text-[11px] text-[var(--text-muted)]" htmlFor={`pr-answer-${item.id}`}>
            {t("primeRadiant.review.answerLabel")}
          </label>
          <input
            id={`pr-answer-${item.id}`}
            className={`${FIELD} w-full text-sm`}
            value={answer}
            maxLength={MAX_ANSWER}
            onChange={(e) => setAnswer(e.target.value)}
            data-testid="prime-radiant-review-answer"
          />
          <div className="flex gap-2">
            <button type="submit" className={BTN_PRIMARY} disabled={busy !== null || !answer.trim()} data-testid="prime-radiant-review-save-new">
              {busy === "new" ? t("primeRadiant.review.saving") : t("primeRadiant.review.saveNew")}
            </button>
            <button type="button" className={BTN_QUIET} onClick={() => setWriting(false)}>{t("primeRadiant.cancel")}</button>
          </div>
        </form>
      )}

      {open && (
        <div className="flex flex-wrap gap-2 pt-1">
          {canVerify && !writing && (
            <button type="button" className={BTN_SECONDARY} onClick={() => setWriting(true)} disabled={busy !== null} data-testid="prime-radiant-review-add-new">
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">add</span>
              {t("primeRadiant.review.addNew")}
            </button>
          )}
          {item.status === "open" && (
            <button type="button" className={BTN_SECONDARY} onClick={() => void resolve({ action: "later" }, "later")} disabled={busy !== null} data-testid="prime-radiant-review-later">
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">schedule</span>
              {t("primeRadiant.review.later")}
            </button>
          )}
          <button type="button" className={BTN_QUIET} onClick={() => void resolve({ action: "dismiss" }, "dismiss")} disabled={busy !== null} data-testid="prime-radiant-review-dismiss">
            {t("primeRadiant.review.dismiss")}
          </button>
        </div>
      )}
      {open && canVerify && <p className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.review.verifyNote")}</p>}

      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
    </article>
  );
}
