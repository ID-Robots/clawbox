"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { copyToClipboard } from "@/lib/clipboard";
import { PORTAL_LOGIN_URL } from "@/lib/max-subscription";
import { ButtonSpinner } from "./ButtonSpinner";

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
}

export default function ClawboxAiDeviceLogin({
  deviceCode,
  verificationUrl,
  polling,
  busy,
  onStart,
}: ClawboxAiDeviceLoginProps) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel any in-flight "Copied" flash on unmount so the timer doesn't
  // call setState on an unmounted component.
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  return (
    <div className="mt-4">
      <p className="text-xs text-[var(--text-muted)] leading-relaxed mb-3">
        Open the ClawBox portal and enter the device code shown below. Your device finishes the handoff once you confirm on the portal.
      </p>
      {!deviceCode ? (
        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          className="w-full px-5 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-[rgba(249,115,22,0.25)] cursor-pointer disabled:opacity-50 disabled:hover:scale-100 flex items-center justify-center gap-2"
        >
          {busy && ButtonSpinner}
          {busy ? t("connecting") : "Get device code"}
        </button>
      ) : (
        <div>
          <div className="mb-3 p-4 bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded-lg text-center">
            <a
              href={verificationUrl ?? PORTAL_LOGIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 w-full px-4 py-3 bg-[var(--coral-bright)] hover:bg-orange-500 text-white font-medium rounded-lg transition-colors text-sm no-underline"
            >
              Open authorization page
              <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>open_in_new</span>
            </a>
            <p className="text-xs text-[var(--text-secondary)] mt-4 mb-2">Then enter this code:</p>
            <div className="px-4 py-3 bg-[var(--bg-surface)] rounded-lg inline-flex items-center gap-2">
              <span className="text-2xl font-mono font-bold text-gray-100 tracking-widest select-all">
                {deviceCode}
              </span>
              <button
                type="button"
                onClick={async () => {
                  const ok = await copyToClipboard(deviceCode);
                  if (!ok) return;
                  setCopied(true);
                  if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
                  copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
                }}
                className="ml-1 px-2 py-1 text-xs font-medium text-[var(--coral-bright)] bg-[var(--bg-deep)] border border-[var(--border-subtle)] rounded hover:bg-[var(--bg-surface)] cursor-pointer transition-colors"
              >
                {copied ? t("copied") : t("copy")}
              </button>
            </div>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Code expires in 15 minutes
            </p>
          </div>

          {polling && (
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="inline-block w-3 h-3 border-2 border-[var(--coral-bright)] border-t-transparent rounded-full animate-spin" />
              Waiting for authorization…
            </div>
          )}

          <button
            type="button"
            onClick={onStart}
            className="mt-2 bg-transparent border-none text-[var(--coral-bright)] text-xs underline cursor-pointer p-0"
          >
            Get a new code
          </button>
        </div>
      )}
    </div>
  );
}
