"use client";

import { useEffect, useRef } from "react";
import { PORTAL_LOGIN_URL } from "@/lib/max-subscription";

// Reusable "Sign in to ClawBox" modal. Surfaced when a user tries to use a
// feature that requires a ClawBox AI account (Remote Control, ClawKeep, etc.)
// without one. The actual sign-in happens on the portal — we open it in a
// new tab so the user can come back to the device once authenticated.
//
// The `feature` prop only changes the headline and the body copy; the action
// is always the same (open the portal). Keep the per-feature copy short — the
// modal is a redirect prompt, not an explainer.

export type ClawBoxLoginFeature = "remote" | "clawkeep" | "generic";

interface Props {
  open: boolean;
  onClose: () => void;
  feature?: ClawBoxLoginFeature;
}

const COPY: Record<ClawBoxLoginFeature, { title: string; body: string }> = {
  remote: {
    title: "Sign in to use Remote Control",
    body: "Remote Control needs your ClawBox account so the portal can publish a secure tunnel back to this device. Sign in and come back — it'll just work.",
  },
  clawkeep: {
    title: "Sign in to use ClawKeep",
    body: "ClawKeep stores your OpenClaw backups in the ClawBox cloud. You need a ClawBox account to claim a private prefix. Sign in and come back to pair.",
  },
  generic: {
    title: "Sign in to ClawBox",
    body: "This feature needs a ClawBox account. Sign in to the portal and come back — the device will pick it up automatically.",
  },
};

export default function ClawBoxLoginModal({ open, onClose, feature = "generic" }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc closes; focus trap is intentionally light (single primary button).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    // Defer the focus to next tick so the button is mounted.
    requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>("[data-primary]")?.focus();
    });
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const copy = COPY[feature];

  return (
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clawbox-login-title"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1219] p-6 shadow-2xl"
      >
        <div className="flex items-start gap-4 mb-4">
          <img
            src="/clawbox-crab.png"
            alt=""
            width={56}
            height={56}
            className="shrink-0 select-none pointer-events-none drop-shadow-[0_0_12px_rgba(249,115,22,0.5)]"
          />
          <div className="flex-1 min-w-0">
            <h2 id="clawbox-login-title" className="text-base font-semibold text-white mb-1">
              {copy.title}
            </h2>
            <p className="text-sm text-white/60 leading-relaxed">{copy.body}</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <a
            data-primary
            href={PORTAL_LOGIN_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              // Close the modal as the new tab opens — when the user comes
              // back, the next status poll will flip them into the
              // logged-in branch.
              setTimeout(onClose, 50);
            }}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl btn-gradient text-sm font-medium text-white cursor-pointer"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>open_in_new</span>
            Open ClawBox Portal
          </a>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm text-white/60 hover:text-white/85 hover:bg-white/[0.04] cursor-pointer"
          >
            Maybe later
          </button>
        </div>
        <p className="mt-4 text-[11px] text-white/35 text-center">
          Already signed in elsewhere? The device will detect your account on its next status poll (~5s).
        </p>
      </div>
    </div>
  );
}
