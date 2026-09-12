"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { ALLOW_RULE_REFUSAL_KEYS, isAllowRuleRefusal } from "@/lib/coding-permission-rules";
import { BTN_QUIET, BTN_SECONDARY, INSET_SURFACE } from "./coding-agent-ui";

/**
 * The "Not allowed" panel on a run's page — and the one place the owner can
 * answer a refusal.
 *
 * A delegated run is headless: Claude Code cannot ask, so anything outside the
 * list it was started with is refused outright and lands here. Until now that
 * was the whole story — the owner read the refusal and the next run met it
 * again. Each entry that CAN be answered now carries a button that saves the
 * narrowest permission rule covering it (the server derives it; see
 * `suggestAllowRule` in @/lib/coding-agent), behind one confirmation that
 * shows the exact rule first.
 *
 * A rule saved here is a STANDING permission, not a one-off, which is why the
 * button is two taps and shows the rule verbatim before saving it. The list it
 * joins is in Settings → Coding Agent, with a Remove beside every row.
 *
 * A refusal with no rule to offer says why instead of showing a button that
 * could not work: a path this box keeps every run out of can never be opened
 * by an allow rule, because a deny rule outranks an allow rule in Claude Code.
 *
 * Its own component rather than more of CodingAgentApp: this is the only part
 * of the run page that WRITES a setting, and it is the part with a state
 * machine (armed → saving → saved) worth testing on its own.
 */

/** One refused action, as the run record carries it. */
export interface RunDenial {
  /** What was refused, in the owner's words: "Read: /home/…/notes.md". */
  text: string;
  /** The narrowest rule that would allow it, or null when there is none. */
  rule: string | null;
  /** Why there is no rule, when there was a candidate to judge. */
  refusal: string | null;
}

/**
 * The entries to draw, from whichever of the two lists the record has.
 *
 * `denials` is the structured list; `deniedActions` is the strings a record
 * written before it existed still carries. The fallback deliberately offers no
 * button: deriving a rule by re-parsing "Read: /home/…" in the browser would be
 * guessing at what the tool was pointed at, and a button that widens a standing
 * permission is the last thing that may guess.
 */
export function denialRows(denials?: RunDenial[], deniedActions?: string[]): RunDenial[] {
  if (denials && denials.length > 0) return denials;
  return (deniedActions ?? []).map((text) => ({ text, rule: null, refusal: null }));
}

export default function CodingRunDenials({
  runId,
  denials,
  deniedActions,
  resumable,
  onAllowed,
  onResume,
}: {
  runId: string;
  denials?: RunDenial[];
  deniedActions?: string[];
  /** True when this run can be resumed in place — only a paused run can. */
  resumable: boolean;
  /** A rule was saved. The host refreshes anything that lists the rules. */
  onAllowed?: (rule: string) => void;
  /** Resume this run, so it carries on with the permission just granted. */
  onResume?: () => void;
}) {
  const { t } = useT();
  const rows = denialRows(denials, deniedActions);
  /**
   * Which ROW is showing its confirmation, by index — not which rule.
   *
   * Two refusals in one folder derive the SAME rule text (that is the point of
   * deriving the folder), so keying this by the rule armed both rows at once
   * and put two confirmation panels on screen for one decision.
   */
  const [armed, setArmed] = useState<number | null>(null);
  /** Rules saved from this panel, so a row can say so without a reload. */
  const [saved, setSaved] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) return null;

  const save = async (rule: string) => {
    setBusy(rule);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/permissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule }),
      });
      if (!res.ok) {
        // The route answers a rule-level `code` beside its sentence. Prefer
        // the code: it is worded in the owner's own language here, while the
        // sentence is the server's English.
        const data = await res.json().catch(() => null) as { error?: string; code?: string } | null;
        throw new Error(
          isAllowRuleRefusal(data?.code)
            ? t(ALLOW_RULE_REFUSAL_KEYS[data.code])
            : (data?.error || t("codingAgent.allowFailed")),
        );
      }
      setSaved((prev) => (prev.includes(rule) ? prev : [...prev, rule]));
      setArmed(null);
      onAllowed?.(rule);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.allowFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="mt-3 rounded-xl bg-amber-500/[0.05] border border-amber-500/30 px-4 py-3"
      data-testid="coding-agent-denied"
    >
      <p className="text-[11px] font-medium text-amber-400">{t("codingAgent.deniedTitle")}</p>
      <ul className="mt-1 space-y-1.5">
        {rows.map((row, i) => {
          // Saved is still keyed by the RULE, and deliberately: when one rule
          // covers two refusals, allowing it answers both, and saying so on
          // only one of them would be the less honest answer.
          const isSaved = row.rule !== null && saved.includes(row.rule);
          const isArmed = row.rule !== null && armed === i;
          // A refusal only gets a sentence when there was a candidate rule to
          // judge. `protected` — the owner's own case, a credential store or
          // this box's state — gets the short note the panel is built around;
          // every other code gets the validator's own wording.
          const refusalKey = isAllowRuleRefusal(row.refusal)
            ? (row.refusal === "protected" ? "codingAgent.allowProtected" : ALLOW_RULE_REFUSAL_KEYS[row.refusal])
            : null;
          return (
            <li key={`${row.text}-${i}`} data-testid="coding-agent-denied-row">
              <span className="text-[11px] font-mono text-[var(--text-muted)] break-all">{row.text}</span>

              {/* Nothing to offer and nothing to explain: an older record, a
                  refused command, a target that could not be read. */}
              {row.rule === null && refusalKey !== null && (
                <span
                  className="block mt-0.5 text-[11px] text-[var(--text-muted)] opacity-70"
                  data-testid="coding-agent-denied-protected"
                >
                  {t(refusalKey)}
                </span>
              )}

              {row.rule !== null && !isSaved && !isArmed && (
                <button
                  type="button"
                  onClick={() => { setError(null); setArmed(i); }}
                  data-testid={`coding-agent-allow-${runId}-${i}`}
                  className={`${BTN_QUIET} mt-1`}
                >
                  {t("codingAgent.allowNextTime")}
                </button>
              )}

              {/* The confirmation. The rule is shown VERBATIM, because it is
                  what will be stored and what the CLI will be started with —
                  a paraphrase would be a different permission. */}
              {row.rule !== null && isArmed && (
                <div className={`${INSET_SURFACE} mt-1.5 px-3 py-2`} data-testid="coding-agent-allow-confirm">
                  <p className="text-[11px] font-medium text-[var(--text-secondary)]">
                    {t("codingAgent.allowConfirmTitle")}
                  </p>
                  <code className="block mt-1 text-[11px] font-mono text-amber-300 break-all">{row.rule}</code>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-relaxed">
                    {t("codingAgent.allowConfirmHint")}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void save(row.rule as string)}
                      disabled={busy !== null}
                      data-testid={`coding-agent-allow-save-${runId}-${i}`}
                      className={BTN_SECONDARY}
                    >
                      {t("codingAgent.allowSave")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setArmed(null)}
                      disabled={busy !== null}
                      data-testid={`coding-agent-allow-cancel-${runId}-${i}`}
                      className={BTN_QUIET}
                    >
                      {t("codingAgent.allowCancel")}
                    </button>
                  </div>
                </div>
              )}

              {isSaved && (
                <span className="block mt-1 text-[11px] text-emerald-400" data-testid="coding-agent-allow-saved">
                  {t("codingAgent.allowSaved")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {/* `role="alert"`, the app's own pattern for an async refusal
          (ImportProjectPanel, NewAppWizardCard): this paragraph appears only
          after the save comes back, so with no live region a screen-reader
          owner presses Allow and is told nothing at all. */}
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] text-red-300" data-testid="coding-agent-allow-error">{error}</p>
      )}

      {/* ONE Resume for the run, under the whole list rather than inside a row:
          it is about the run and not about the refusal, and two refusals
          answered by one rule would otherwise have drawn it twice.
          Only a PAUSED run can carry on in place, and it is offered at all
          because the permission just granted is of no use to THIS run until it
          does — a resume re-reads the owner's list. */}
      {resumable && saved.length > 0 && (
        <div className="mt-2">
          <span className="block text-[11px] text-[var(--text-muted)] leading-relaxed">
            {t("codingAgent.allowResumeHint")}
          </span>
          <button
            type="button"
            onClick={() => onResume?.()}
            data-testid={`coding-agent-allow-resume-${runId}`}
            className={`${BTN_SECONDARY} mt-1`}
          >
            {t("codingAgent.resume")}
          </button>
        </div>
      )}
      <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-1 leading-relaxed">
        {t("codingAgent.deniedHelp")}
      </p>
    </div>
  );
}
