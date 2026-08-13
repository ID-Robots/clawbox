"use client";

import { useModalDialog } from "@/hooks/useModalDialog";
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
  // Escape, focus-in, the Tab cycle and focus-restore all come from the shared
  // hook. The trap used to be "intentionally light" — no trap at all, in
  // practice: Tab walked straight out of the modal onto the page behind it, so
  // a keyboard user could not reliably get back to "Open ClawBox Portal".
  const dialogRef = useModalDialog<HTMLDivElement>({ open, onClose });

  if (!open) return null;

  const copy = COPY[feature];

  return (
    /* Scrim: the pane's own ground at 72% rather than a literal black, so it
       follows `[data-agent="hermes"]` like everything else under
       `.settings-pane`. The blur is the one that ships today — no new
       `backdrop-filter` is introduced, and this element is never an ancestor of
       the portalled factory-reset / reboot overlays. */
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center backdrop-blur-sm p-4"
      style={{ backgroundColor: "color-mix(in srgb, var(--set-surface) 72%, transparent)" }}
      onClick={onClose}
    >
      {/* 28px = the M3 dialog shape, the top of the 4/8/12/16/28 scale. The
          border is gone: a dialog is the most elevated surface in the pane, and
          in M3 the tone IS the elevation. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="clawbox-login-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-[28px] bg-[var(--set-surface-container-high)] p-[24px] shadow-2xl"
      >
        <div className="flex items-start gap-[16px] mb-[16px]">
          <img
            src="/clawbox-crab.png"
            alt=""
            width={56}
            height={56}
            className="shrink-0 select-none pointer-events-none"
            style={{ filter: "drop-shadow(0 0 12px color-mix(in srgb, var(--set-primary) 50%, transparent))" }}
          />
          <div className="flex-1 min-w-0">
            <h2 id="clawbox-login-title" className="text-[16px] font-medium leading-[1.3] text-[var(--set-on-surface)] mb-[4px]">
              {copy.title}
            </h2>
            <p className="text-[14px] leading-[1.5] text-[var(--set-on-surface-variant)]">{copy.body}</p>
          </div>
        </div>
        <div className="flex flex-col gap-[8px]">
          <a
            href={PORTAL_LOGIN_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              // Close the modal as the new tab opens — when the user comes
              // back, the next status poll will flip them into the
              // logged-in branch.
              setTimeout(onClose, 50);
            }}
            className="inline-flex min-h-[44px] cursor-pointer items-center justify-center gap-[8px] rounded-[22px] border-none bg-[var(--set-primary)] px-[24px] text-[14px] font-medium leading-[1.2] text-[var(--set-on-primary)] no-underline transition-colors hover:bg-[color-mix(in_srgb,var(--set-on-primary)_8%,var(--set-primary))] active:bg-[color-mix(in_srgb,var(--set-on-primary)_12%,var(--set-primary))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>open_in_new</span>
            Open ClawBox Portal
          </a>
          {/* Was ~36px tall; the declared minimum target is 44px and this modal
              also renders on the narrow pane. */}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[44px] cursor-pointer items-center justify-center rounded-[22px] border-none bg-transparent px-[24px] text-[14px] font-medium leading-[1.2] text-[var(--set-on-surface-variant)] transition-colors hover:bg-[var(--set-state-hover)] hover:text-[var(--set-on-surface)] active:bg-[var(--set-state-pressed)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--set-primary)]"
          >
            Maybe later
          </button>
        </div>
        <p className="mt-[16px] text-center text-[11px] leading-[1.4] text-[var(--set-on-surface-variant)]">
          Already signed in elsewhere? The device will detect your account on its next status poll (~5s).
        </p>
      </div>
    </div>
  );
}
