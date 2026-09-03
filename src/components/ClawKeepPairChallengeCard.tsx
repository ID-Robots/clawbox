"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { CARD } from "./clawkeep-ui";

/** What POST /setup-api/clawkeep/pair/start answers: the device code to type. */
export interface PairStartResponse {
  user_code: string;
  verification_url: string;
  interval: number;
  code_length: number;
}

/**
 * The device-code card: the portal link, the code (copied to the clipboard on
 * arrival), and the polling state underneath. Shared by the ClawKeep dashboard
 * and the setup wizard — one implementation, so the two cannot drift.
 */
export function PairChallengeCard({
  challenge,
  phase,
  onCancel,
  onGetNewCode,
  busy,
}: {
  challenge: PairStartResponse;
  phase: "" | "pending" | "configuring";
  onCancel: () => void;
  onGetNewCode: () => void;
  busy: boolean;
}) {
  const { t } = useT();
  const code = challenge.user_code;
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const flashCopied = useCallback(() => {
    setCopied(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }, []);

  // Auto-copy when a fresh code lands. Mirrors what the user just told the
  // portal to expect — they can paste straight into the portal field
  // without re-typing. Re-runs only when the code itself changes so a
  // re-render (e.g. phase transition) doesn't keep stomping the clipboard.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void copyToClipboard(code).then((ok) => {
      if (!cancelled && ok) flashCopied();
    });
    return () => {
      cancelled = true;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, [code, flashCopied]);

  const onCopyClick = useCallback(async () => {
    const ok = await copyToClipboard(code);
    if (ok) flashCopied();
  }, [code, flashCopied]);

  return (
    <div className={`${CARD} space-y-3`}>
      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        {t("clawkeep.pair.intro")}
      </p>
      <div className="p-4 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg text-center">
        <a
          href={challenge.verification_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 w-full px-4 py-3 bg-[var(--coral-bright)] hover:bg-orange-500 text-white font-medium rounded-lg transition-colors text-sm no-underline"
        >
          {t("ai.openAuthPage")}
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>
            open_in_new
          </span>
        </a>
        <p className="text-xs text-[var(--text-secondary)] mt-4 mb-2">
          {t("clawkeep.pair.thenEnterCode")}
        </p>
        <div className="px-4 py-3 bg-[var(--bg-surface)] rounded-lg inline-flex items-center gap-2">
          <span
            className="text-2xl font-mono font-bold text-gray-100 tracking-widest select-all"
            aria-label={`${t("clawkeep.pair.codeAriaLabel")}: ${code}`}
          >
            {code}
          </span>
          <button
            type="button"
            onClick={onCopyClick}
            aria-label={copied ? t("clawkeep.pair.codeCopied") : t("clawkeep.pair.copyCode")}
            className="ml-1 px-2 py-1 text-xs font-medium text-[var(--coral-bright)] bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded hover:bg-[var(--bg-surface)] cursor-pointer transition-colors"
          >
            {copied ? t("clawkeep.pair.copied") : t("clawkeep.pair.copy")}
          </button>
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          {t("clawkeep.pair.codeExpires")}
        </p>
      </div>

      {phase && (
        <div
          className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"
          role="status"
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            className="inline-block w-3 h-3 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin"
          />
          {phase === "configuring"
            ? t("clawkeep.pair.savingToken")
            : t("clawkeep.pair.waitingAuthorization")}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onGetNewCode}
          disabled={busy}
          className="bg-transparent border-none text-[var(--coral-bright)] text-xs underline cursor-pointer p-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t("clawkeep.pair.getNewCode")}
        </button>
        <span className="text-xs text-[var(--text-muted)]">·</span>
        <button
          type="button"
          onClick={onCancel}
          className="bg-transparent border-none text-xs text-[var(--text-muted)] hover:text-gray-200 cursor-pointer p-0"
        >
          {t("clawkeep.cancel")}
        </button>
      </div>
    </div>
  );
}
