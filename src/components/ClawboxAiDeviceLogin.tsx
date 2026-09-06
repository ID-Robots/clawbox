"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { PORTAL_LOGIN_URL } from "@/lib/max-subscription";
import { ButtonSpinner } from "./ButtonSpinner";
import DeviceCodeCard from "./DeviceCodeCard";

// ClawBox AI device-authorisation CTA (RFC 8628 style), shared by the OpenClaw
// wizard and the Hermes provider panel. Moved verbatim out of AIModelsStep; the
// only change is that the transient "Copied" flash now lives here instead of in
// the host component, since nothing else ever read it.
//
// Hermes needs this: before the extraction its panel only showed a ClawBox AI
// row when a token already existed, so a Hermes user with no token had no way
// in at all.

interface ClawboxAiDeviceLoginProps {
  deviceCode: string | null;
  verificationUrl: string | null;
  polling: boolean;
  /** Kick-off in flight (OpenClaw passes its `saving` flag). */
  busy: boolean;
  onStart: () => void;
  /**
   * Apply a token the user pasted from the portal. Optional: a host that hasn't
   * wired the manual path simply doesn't render it. Rejecting with an Error
   * shows its message inline.
   */
  onSubmitToken?: (token: string) => Promise<void>;
}

export default function ClawboxAiDeviceLogin({
  deviceCode,
  verificationUrl,
  polling,
  busy,
  onStart,
  onSubmitToken,
}: ClawboxAiDeviceLoginProps) {
  const { t } = useT();
  // English is the floor for a key the locale packs do not carry yet: `t`
  // answers with the raw key when it is missing, and this card is the one every
  // owner meets on the Providers page — a raw `ai.clawaiGetCode` on the button
  // would be worse than the English it replaces.
  const tr = (key: string, english: string) => {
    const value = t(key);
    return value === key ? english : value;
  };
  // The manual path is collapsed by default: the device-code flow is the one
  // we want people on, and showing a token field next to it invites pasting
  // the wrong string. It matters for the cases the code flow can't serve —
  // no browser to hand off to, a handoff that failed, or a token issued
  // elsewhere in the portal.
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const submitToken = async () => {
    if (!onSubmitToken) return;
    const value = token.trim();
    if (!value) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      await onSubmitToken(value);
      setToken("");
      setTokenOpen(false);
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : tr("ai.clawaiTokenFailed", "Could not apply that token."));
    } finally {
      setTokenBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <p className="text-xs text-[var(--text-muted)] leading-relaxed mb-3">
        {tr("ai.clawaiDeviceIntro", "Open the ClawBox portal and enter the device code shown below. Your device finishes the handoff once you confirm on the portal.")}
      </p>
      {!deviceCode ? (
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          className="w-full px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
        >
          {busy && ButtonSpinner}
          {busy ? t("connecting") : tr("ai.clawaiGetCode", "Get device code")}
        </button>
      ) : (
        <DeviceCodeCard
          code={deviceCode}
          verificationUrl={verificationUrl ?? PORTAL_LOGIN_URL}
          polling={polling}
          onNewCode={onStart}
        />
      )}

      {onSubmitToken && (
        <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
          {!tokenOpen ? (
            <button
              type="button"
              onClick={() => setTokenOpen(true)}
              className="bg-transparent border-none text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-xs underline cursor-pointer p-0 transition-colors"
            >
              {tr("ai.clawaiHaveToken", "Have an API token? Enter it instead")}
            </button>
          ) : (
            <div>
              <label
                htmlFor="clawai-token"
                className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5"
              >
                {tr("ai.clawaiTokenLabel", "ClawBox AI API token")}
              </label>
              <div className="flex gap-2">
                <input
                  id="clawai-token"
                  type="password"
                  value={token}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={tr("ai.clawaiTokenPlaceholder", "Paste the token from the portal")}
                  onChange={(e) => { setToken(e.target.value); setTokenError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void submitToken(); }}
                  className="flex-1 min-w-0 rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--coral-bright)]"
                />
                <button
                  type="button"
                  onClick={() => void submitToken()}
                  disabled={tokenBusy || token.trim().length < 16}
                  className="shrink-0 px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[var(--coral-bright)] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2"
                >
                  {tokenBusy && ButtonSpinner}
                  {tokenBusy ? t("connecting") : t("save")}
                </button>
              </div>
              {tokenError && <p className="mt-1.5 text-xs text-red-400">{tokenError}</p>}
              <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                {tr("ai.clawaiTokenHint", "Find it in the ClawBox portal under your device’s settings.")}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
