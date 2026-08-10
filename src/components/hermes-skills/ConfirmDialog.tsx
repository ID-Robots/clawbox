'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { COPY } from './copy';
import { FOCUS_RING } from './primitives';

// One accessible modal for both install and uninstall confirmation.
//
// The desktop's other stores each hand-roll this and each miss something, so the
// three things that actually matter are done once here: the dialog role lives on
// the PANEL (not the backdrop, which would make the backdrop the accessible
// dialog), focus moves in on open and is restored on close, and Tab is trapped
// between the two buttons instead of walking the page behind the overlay.

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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // The handler is read through a ref so the trap below can run ONCE. Keying
  // the effect on the prop re-ran it on every parent render — and the parent
  // re-renders under the open dialog while the detail fetch resolves, which
  // pulled focus back to Cancel mid-Tab and corrupted the restore target.
  const cancelHandler = useRef(onCancel);
  useEffect(() => {
    cancelHandler.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancelHandler.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const first = cancelRef.current;
      const last = confirmRef.current;
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (active !== first && active !== last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreRef.current?.focus?.();
    };
    // Mount/unmount only — see cancelHandler above.
  }, []);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
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
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className={`px-4 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-card)] transition-colors ${FOCUS_RING}`}
          >
            {COPY.cancel}
          </button>
          <button
            ref={confirmRef}
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
