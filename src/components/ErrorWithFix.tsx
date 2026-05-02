"use client";

import { dispatchFixError, type FixErrorContext } from "@/lib/ui-events";
import { useT } from "@/lib/i18n";

interface ErrorWithFixProps {
  /** Error text shown to the user. */
  message: string;
  /** Source identifier handed to the agent ("browser", "store", "setup-wifi", …). */
  source: string;
  /** Optional extra context for the agent (subprocess output, file paths). */
  details?: string;
  /** Tone — defaults to red banner. "subtle" renders inline next to other text. */
  variant?: "banner" | "subtle";
  /** Custom className for the outer wrapper. */
  className?: string;
}

/**
 * Error display with a "Fix My Error" button. Clicking the button hands the
 * error context to the OpenClaw agent (via the mascot chat) so it can
 * investigate and apply a fix.
 */
export default function ErrorWithFix({ message, source, details, variant = "banner", className = "" }: ErrorWithFixProps) {
  const { t } = useT();
  if (!message) return null;

  const onFix = () => {
    const ctx: FixErrorContext = { source, message, details };
    dispatchFixError(ctx);
  };

  const label = t("chat.fixMyError");
  if (variant === "subtle") {
    return (
      <div className={`flex items-center gap-2 text-sm text-red-300/80 ${className}`}>
        <span className="material-symbols-rounded text-red-400" style={{ fontSize: 16 }} aria-hidden="true">error</span>
        <span className="flex-1">{message}</span>
        <FixButton onClick={onFix} label={label} />
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-red-500/30 bg-red-500/10 p-3 flex items-start gap-3 ${className}`}>
      <span className="material-symbols-rounded text-red-400 shrink-0 mt-0.5" style={{ fontSize: 20 }} aria-hidden="true">error</span>
      <p className="flex-1 text-sm text-red-200/90 leading-relaxed">{message}</p>
      <FixButton onClick={onFix} label={label} />
    </div>
  );
}

function FixButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0a0f1a] border border-orange-500/30 text-xs font-medium text-orange-300 hover:bg-orange-500/10 hover:border-orange-500/50 transition-colors cursor-pointer"
      title={label}
      aria-label={label}
    >
      <img src="/clawbox-crab.png" alt="" className="w-4 h-4 object-contain" />
      <span>{label}</span>
    </button>
  );
}
