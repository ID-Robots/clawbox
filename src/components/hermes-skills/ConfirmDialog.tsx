'use client';

import { type ReactNode } from 'react';
import { useModalDialog } from '@/hooks/useModalDialog';
import { COPY } from './copy';
import { FOCUS_RING } from './primitives';

// One accessible modal for both install and uninstall confirmation.
//
// The three things that actually matter — the dialog role on the PANEL (not the
// backdrop, which would make the backdrop the accessible dialog), focus moving
// in on open and restored on close, and Tab trapped inside instead of walking
// the page behind the overlay — now live in useModalDialog, so the app store
// and the rest of the desktop share exactly this behaviour.

export function ConfirmDialog({
  title,
  icon,
  tone = 'brand',
  confirmLabel,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  icon: string;
  tone?: 'brand' | 'danger';
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  // Cancel is first in DOM order, so the shared trap focuses it on open — a
  // stray Enter cannot confirm an install the user never read.
  const panelRef = useModalDialog<HTMLDivElement>({ onClose: onCancel });

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hs-dialog-title"
        className="card-surface rounded-2xl p-6 w-full max-w-md shadow-2xl border border-[var(--border-subtle)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              tone === 'danger' ? 'bg-red-500' : 'bg-[var(--coral-bright)]'
            }`}
          >
            <span className="material-symbols-rounded text-white" style={{ fontSize: 22 }} aria-hidden="true">
              {icon}
            </span>
          </div>
          <h3 id="hs-dialog-title" className="text-lg font-semibold text-[var(--text-primary)] min-w-0 break-words">
            {title}
          </h3>
        </div>

        <div className="mb-5 text-sm text-[var(--text-secondary)] space-y-3">{children}</div>

        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className={`px-4 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-card)] transition-colors ${FOCUS_RING}`}
          >
            {COPY.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 ${FOCUS_RING} ${
              tone === 'danger' ? 'bg-red-500' : 'bg-[var(--coral-bright)]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
