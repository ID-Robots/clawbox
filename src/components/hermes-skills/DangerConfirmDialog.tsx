'use client';

import { useState } from 'react';
import { useModalDialog } from '@/hooks/useModalDialog';
import type { SkillDangerWarning } from '@/lib/hermes-skill-capabilities';
import { useCopy } from './copy';
import { Alert, FOCUS_RING } from './primitives';

// TASK-452 — the dialog a customer sees when the device's own scanner flagged
// the skill they asked for.
//
// Krasi's ruling (2026-08-24): WARN and CONFIRM, never hard-block, and the same
// flow at every trust tier including `official`. So this is not an error state
// with an OK button — it is a decision, and it is built to be made honestly:
//
//   * the headline is what the skill CAN DO to the device, in the customer's
//     words ("run commands on your device"), derived from the scan rather than
//     quoting its pattern ids;
//   * the scanner's own findings are still there, one click away, because a
//     summary nobody can check is not evidence;
//   * the confirm button is disabled until a checkbox is ticked, so the
//     decision cannot be made by muscle memory — the plain ConfirmDialog's
//     "press Enter" affordance is exactly wrong here;
//   * Cancel is first in DOM order, so the shared focus trap lands there.

const CAPABILITY_ICONS: Record<string, string> = {
  shell: 'terminal',
  filesystem: 'folder_open',
  network: 'public',
  credentials: 'key',
  browser: 'web',
  system: 'settings',
  agentInstructions: 'smart_toy',
  other: 'help',
};

export function DangerConfirmDialog({
  warning,
  onConfirm,
  onCancel,
}: {
  warning: SkillDangerWarning;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const COPY = useCopy();
  const [understood, setUnderstood] = useState(false);
  const [showFindings, setShowFindings] = useState(false);
  const panelRef = useModalDialog<HTMLDivElement>({ onClose: onCancel });

  const { critical, high } = warning.severityCounts;
  const capabilities = warning.capabilities.filter((c) => c.id !== 'other');
  const otherCount = warning.capabilities.find((c) => c.id === 'other')?.count ?? 0;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hs-danger-title"
        data-testid="skill-danger-dialog"
        className="card-surface rounded-2xl p-6 w-full max-w-lg shadow-2xl border border-amber-500/40 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-amber-500 shrink-0">
            <span className="material-symbols-rounded text-white" style={{ fontSize: 22 }} aria-hidden="true">
              warning
            </span>
          </div>
          <h3
            id="hs-danger-title"
            className="text-lg font-semibold text-[var(--text-primary)] min-w-0 break-words"
          >
            {COPY.dangerTitle(warning.name)}
          </h3>
        </div>

        <div className="mb-5 text-sm text-[var(--text-secondary)] space-y-3">
          <Alert tone="warn" icon="shield">
            {COPY.dangerLead(warning.verdict || 'flagged')}
          </Alert>

          {(critical > 0 || high > 0) && (
            <p className="text-xs">{COPY.dangerSeverity(critical, high)}</p>
          )}

          <div>
            <p className="text-xs font-medium text-[var(--text-primary)] mb-1.5">{COPY.dangerCanDo}</p>
            {capabilities.length > 0 ? (
              <ul className="space-y-1.5 list-none p-0 m-0" data-testid="skill-danger-capabilities">
                {capabilities.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-xs">
                    <span
                      className="material-symbols-rounded shrink-0 text-amber-300"
                      style={{ fontSize: 15 }}
                      aria-hidden="true"
                    >
                      {CAPABILITY_ICONS[c.id] || 'help'}
                    </span>
                    <span className="min-w-0">
                      <span className="text-[var(--text-primary)]">{COPY.capability(c.id)}</span>
                      {c.locations.length > 0 && (
                        <span className="block font-mono text-[10px] text-[var(--text-secondary)] break-all">
                          {c.locations.join(', ')}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs">{COPY.dangerNoCapabilities}</p>
            )}
            {otherCount > 0 && <p className="mt-1.5 text-xs">{COPY.dangerOther(otherCount)}</p>}
          </div>

          {/* The trust tier is shown precisely BECAUSE it used to be the reason
              nobody was asked: an `official` skill with a dangerous verdict was
              installed silently. Naming it here makes the exemption visible. */}
          <p className="text-xs">{COPY.dangerTrustNote}</p>

          {warning.findings.length > 0 && (
            <div>
              {showFindings ? (
                <ul className="space-y-1 list-none p-0 m-0 max-h-40 overflow-y-auto" data-testid="skill-danger-findings">
                  {warning.findings.map((f, i) => (
                    <li key={`${f.patternId || 'f'}-${i}`} className="text-[11px] font-mono break-all">
                      <span className="text-amber-300">{(f.severity || 'info').toUpperCase()}</span>{' '}
                      {f.category || ''} {f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : ''}
                      {f.description && (
                        <span className="block text-[var(--text-secondary)]">{f.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowFindings(true)}
                  className={`text-xs underline text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded ${FOCUS_RING}`}
                >
                  {COPY.dangerShowFindings(warning.findings.length)}
                </button>
              )}
            </div>
          )}

          <label className="flex items-start gap-2 text-xs text-[var(--text-primary)] cursor-pointer">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              data-testid="skill-danger-understood"
              className={`mt-0.5 accent-[var(--coral-bright)] ${FOCUS_RING}`}
            />
            <span>{COPY.dangerUnderstand}</span>
          </label>
        </div>

        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className={`px-4 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-card)] transition-colors ${FOCUS_RING}`}
          >
            {COPY.dangerCancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!understood}
            data-testid="skill-danger-confirm"
            className={`px-4 py-2 rounded-lg text-sm font-semibold text-white bg-amber-600 transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`}
          >
            {COPY.dangerInstallAnyway}
          </button>
        </div>
      </div>
    </div>
  );
}
