"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { onCodingAgentChanged } from "@/lib/ui-events";
import { ALLOW_RULE_REFUSAL_KEYS, isAllowRuleRefusal, MAX_ALLOW_RULES } from "@/lib/coding-permission-rules";
import { BTN_QUIET, BTN_SECONDARY, CARD, FIELD, INSET_SURFACE } from "./coding-agent-ui";
import HelpTip from "./HelpTip";

/**
 * Settings → Coding Agent → "Allowed from now on": the owner's standing
 * permission rules, read and edited in one place.
 *
 * The list is filled mostly from the OTHER end — "Allow next time" on a refused
 * action, on the run's own page (CodingRunDenials) — because that is where the
 * owner finds out a permission was wanted at all. This card is where they see
 * everything they have granted and take any of it back, and it accepts a typed
 * rule for the owner who knows what they want before a run asks for it.
 *
 * Its own component, and its own reads and writes, rather than part of the
 * settings panel's status: the panel serialises its setting writes through one
 * chain so two answers cannot land out of order, and a list with its own add
 * and remove does not belong in that chain. It reloads on the same
 * "coding agent changed" event the app raises when a rule is saved from a run,
 * so a Settings window left open does not go stale.
 */

/** What the permissions route answers a GET with. */
interface RulesPayload {
  allowRules?: unknown;
  maxAllowRules?: unknown;
}

function rulesFrom(payload: RulesPayload): string[] {
  return Array.isArray(payload.allowRules)
    ? payload.allowRules.filter((r): r is string => typeof r === "string")
    : [];
}

export default function CodingAgentRulesCard() {
  const { t } = useT();
  const [rules, setRules] = useState<string[]>([]);
  const [max, setMax] = useState<number>(MAX_ALLOW_RULES);
  /** False until the first read comes back, so an empty list is not claimed early. */
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/coding-agent/permissions", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json() as RulesPayload;
      setRules(rulesFrom(payload));
      if (typeof payload.maxAllowRules === "number" && payload.maxAllowRules > 0) setMax(payload.maxAllowRules);
    } catch {
      // Not new information about the rules — the card keeps what it last
      // knew rather than claiming the list is empty, which would invite the
      // owner to re-add a rule that is already in force.
      setError(t("codingAgent.rulesFailed"));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);
  // A rule saved from a run's page is the commonest way this list grows, and
  // it happens in another window.
  useEffect(() => onCodingAgentChanged(() => { void load(); }), [load]);

  /**
   * The rule-level refusal, worded here rather than taken from the server.
   *
   * The route answers a stable `code` beside its own English sentence; the code
   * is what this card can say in the owner's language. The sentence is the
   * fallback for a code this build does not know — an older box, a newer route.
   */
  const refusalText = (data: { error?: string; code?: string } | null, fallback: string) =>
    isAllowRuleRefusal(data?.code) ? t(ALLOW_RULE_REFUSAL_KEYS[data.code]) : (data?.error || fallback);

  /** Both writes answer with the whole re-read status, so the list is the box's. */
  const write = async (init: RequestInit, url: string, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, init);
      const payload = await res.json().catch(() => null) as (RulesPayload & { error?: string; code?: string }) | null;
      if (!res.ok) throw new Error(refusalText(payload, fallback));
      if (payload) setRules(rulesFrom(payload));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const rule = draft.trim();
    if (!rule) {
      setError(t("codingAgent.ruleRefusedEmpty"));
      return;
    }
    const ok = await write(
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule }) },
      "/setup-api/coding-agent/permissions",
      t("codingAgent.rulesFailed"),
    );
    if (ok) setDraft("");
  };

  const remove = (rule: string) => write(
    { method: "DELETE" },
    `/setup-api/coding-agent/permissions?rule=${encodeURIComponent(rule)}`,
    t("codingAgent.rulesFailed"),
  );

  const full = rules.length >= max;

  return (
    <div className={CARD} data-testid="coding-agent-rules-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium text-[var(--text-secondary)]">{t("codingAgent.rulesTitle")}</span>
          <HelpTip
            text={t("codingAgent.rulesHint")}
            label={t("codingAgent.rulesTitle")}
            testId="coding-agent-rules-help"
          />
        </div>
        <span className="text-[11px] text-[var(--text-muted)] shrink-0" data-testid="coding-agent-rules-count">
          {t("codingAgent.rulesCount", { n: rules.length, max })}
        </span>
      </div>

      {loaded && rules.length === 0 ? (
        <p className="mt-2 text-[11px] text-[var(--text-muted)] leading-relaxed" data-testid="coding-agent-rules-empty">
          {t("codingAgent.rulesEmpty")}
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rules.map((rule) => (
            <li
              key={rule}
              className={`${INSET_SURFACE} px-3 py-2 flex items-center justify-between gap-3`}
              data-testid="coding-agent-rule-row"
            >
              <code className="text-[11px] font-mono text-[var(--text-secondary)] break-all min-w-0">{rule}</code>
              <button
                type="button"
                onClick={() => void remove(rule)}
                disabled={busy}
                aria-label={t("codingAgent.rulesRemoveOne", { rule })}
                data-testid="coding-agent-rule-remove"
                className={`${BTN_QUIET} shrink-0`}
              >
                {t("codingAgent.rulesRemove")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Typing one by hand. Disabled at the cap rather than hidden, so the
          count beside the title explains why nothing can be added. */}
      <div className="mt-3">
        <label htmlFor="coding-agent-rule-input" className="text-xs font-medium text-[var(--text-secondary)]">
          {t("codingAgent.rulesLabel")}
        </label>
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            id="coding-agent-rule-input"
            type="text"
            value={draft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={t("codingAgent.rulesPlaceholder")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            disabled={busy || full}
            data-testid="coding-agent-rule-input"
            className={`flex-1 min-w-0 text-base sm:text-xs ${FIELD}`}
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || full}
            data-testid="coding-agent-rule-add"
            className={`${BTN_SECONDARY} shrink-0`}
          >
            {t("codingAgent.rulesAdd")}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-2 text-[11px] text-red-300" data-testid="coding-agent-rules-error">{error}</p>
      )}
    </div>
  );
}
