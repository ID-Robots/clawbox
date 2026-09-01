"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * One device-authorisation card, for every RFC 8628 flow on the box.
 *
 * There were two of these: the ClawBox AI subscription card (a big
 * "Open authorization page" button, the code in a box with Copy, an expiry
 * line and a spinner) and the GitHub one in the coding agent, which showed the
 * bare code above a text link and had no Copy button at all — the owner had to
 * select eight characters by hand on a touch screen. Same protocol, same job,
 * two looks and one of them worse. This is the good one, shared.
 *
 * The code is copied AUTOMATICALLY when it appears: the very next thing anyone
 * does with it is paste it, and the copy is attempted inside the click that
 * asked for the code, which is the gesture browsers want. It can still fail
 * silently (a locked-down WebView, a denied permission) — hence the Copy
 * button stays, and the flash only appears when the copy actually landed.
 */
export default function DeviceCodeCard({
  code,
  verificationUrl,
  polling = false,
  onNewCode,
  actions,
  testId = "device-code",
}: {
  code: string;
  verificationUrl: string;
  /** Show the "Waiting for authorization…" spinner. */
  polling?: boolean;
  /** Re-request a code. Omitted when the host has no way to start over. */
  onNewCode?: () => void;
  /** Host-specific extras under the card (Cancel, a terminal fallback…). */
  actions?: ReactNode;
  testId?: string;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = () => {
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const copy = async () => {
    if (await copyToClipboard(code)) flash();
  };

  // Auto-copy each NEW code, once. Keyed on the code itself so a re-issued one
  // copies again and the same one never re-copies on an unrelated re-render.
  useEffect(() => {
    let alive = true;
    void copyToClipboard(code).then((ok) => {
      if (ok && alive) flash();
    });
    return () => { alive = false; };
    // `flash` is a stable closure over setState only; keying on `code` is the
    // point — one auto-copy per issued code, and a re-issued one copies again.
  }, [code]);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  return (
    <div data-testid={testId}>
      <div className="mb-3 p-4 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg text-center">
        <a
          href={verificationUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`${testId}-open`}
          className="inline-flex items-center justify-center gap-2 w-full px-4 py-3 bg-[var(--coral-bright)] hover:bg-orange-500 text-white font-medium rounded-lg transition-colors text-sm no-underline"
        >
          {t("ai.openAuthPage")}
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>open_in_new</span>
        </a>
        <p className="text-xs text-[var(--text-secondary)] mt-4 mb-2">{t("ai.thenEnterCode")}</p>
        <div className="px-4 py-3 bg-[var(--bg-surface)] rounded-lg inline-flex items-center gap-2">
          <span data-testid={`${testId}-value`} className="text-2xl font-mono font-bold text-gray-100 tracking-widest select-all">
            {code}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            data-testid={`${testId}-copy`}
            className="ml-1 px-2 py-1 text-xs font-medium text-[var(--coral-bright)] bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded hover:bg-[var(--bg-surface)] cursor-pointer transition-colors"
          >
            {copied ? t("copied") : t("copy")}
          </button>
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]">{t("ai.codeExpires")}</p>
      </div>

      {polling && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]" data-testid={`${testId}-waiting`}>
          {/* motion-safe, not a bare animate-spin: an owner who turned
              animation off in the OS must not get a spinner that keeps
              turning. The GitHub card pinned this; the subscription card it
              now shares markup with never did. */}
          <span
            data-testid={`${testId}-spinner`}
            className="inline-block w-3 h-3 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full motion-safe:animate-spin"
          />
          {t("ai.waitingAuth")}
        </div>
      )}

      <div className="mt-2 flex items-center gap-3">
        {onNewCode && (
          <button
            type="button"
            onClick={onNewCode}
            data-testid={`${testId}-new`}
            className="bg-transparent border-none text-[var(--coral-bright)] text-xs underline cursor-pointer p-0"
          >
            {t("ai.getNewCode")}
          </button>
        )}
        {actions}
      </div>
    </div>
  );
}
