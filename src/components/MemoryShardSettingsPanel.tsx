"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { notifyMemoryShardChanged } from "@/lib/ui-events";
import HelpTip from "./HelpTip";
import StatusMessage from "./StatusMessage";
import { BTN_DANGER, BTN_SECONDARY, CARD } from "./coding-agent-ui";

/**
 * Memory Shard's settings page, embedded in its own window.
 *
 * The same page the Coding Agent has, for the same reason: the two switches an
 * owner is asked to think about — "may this box run a shell for the assistant"
 * and "may this box read my documents into an index" — belong beside the thing
 * they govern, not in a Settings window that would then have to explain what
 * they refer to. Everything here is the owner's consent, so every write goes
 * through an owner-only route and none of it is optimistic.
 */

/** What the app knows about the feature, and what a save answers with. */
export interface MemoryShardSettingsState {
  enabled: boolean;
  setupComplete: boolean;
}

/** How long the reset stays armed after the first tap. */
const CONFIRM_MS = 5_000;

/**
 * The desktop's switch. Drawn here rather than imported because the Coding
 * Agent's identical control is private to its own settings file; the two are
 * built from the same tokens, and lifting one into a shared kit is a change
 * that has to own both files.
 */
function Switch({ checked, busy, label, onChange }: {
  checked: boolean;
  busy: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {busy && (
        // motion-safe: a spinner that keeps turning for an owner who asked the
        // OS for reduced motion is the one thing a spinner must not do.
        <span
          className="material-symbols-rounded motion-safe:animate-spin text-[var(--text-muted)]"
          style={{ fontSize: 18 }}
          aria-hidden="true"
          data-testid="memory-shard-switch-busy"
        >
          progress_activity
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        aria-busy={busy}
        disabled={busy}
        onClick={() => onChange(!checked)}
        data-testid="memory-shard-switch"
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
          checked ? "bg-[var(--coral-bright)]" : "bg-gray-600"
        }`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
}

export default function MemoryShardSettingsPanel({ state, onChanged, onReset }: {
  state: MemoryShardSettingsState;
  /** The state the route answered with — the host owns it, so the header chip
   *  and this switch cannot disagree about what was saved. */
  onChanged: (next: MemoryShardSettingsState) => void;
  /** Called after a successful reset, so the host can leave this page: the
   *  setup it describes no longer exists and the window's front door is the
   *  wizard again. */
  onReset: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const save = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/clawkeep/memory/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error("enable");
      // What the ROUTE says, never what was clicked: this switch is the
      // owner's consent for the box to read their documents, and a switch that
      // showed On over a write the box refused would be a lie about that.
      const body = await res.json() as { enabled?: unknown; setupComplete?: unknown };
      onChanged({
        enabled: typeof body.enabled === "boolean" ? body.enabled : next,
        setupComplete: typeof body.setupComplete === "boolean" ? body.setupComplete : state.setupComplete,
      });
      // Another Memory Shard window — or the same app open at
      // /app/memory-shard on a phone — follows the switch it did not flip.
      notifyMemoryShardChanged();
    } catch {
      setError(t("clawkeep.memory.settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const armReset = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setConfirmReset(false); }, CONFIRM_MS);
    setConfirmReset(true);
  };

  // Two taps, like every other step on this box that cannot be undone by
  // pressing it again. Nothing it clears is expensive to re-enter — the
  // folders, the model and the index all stay — but it does take the owner
  // back through onboarding, which is not something a stray tap should do.
  const reset = async () => {
    if (!confirmReset) { armReset(); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setConfirmReset(false);
    setBusy(true);
    setResetError(null);
    try {
      const res = await fetch("/setup-api/clawkeep/memory/reset", { method: "POST" });
      if (!res.ok) throw new Error("reset");
      notifyMemoryShardChanged();
      onReset();
    } catch {
      setResetError(t("clawkeep.memory.reset.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full space-y-5" data-testid="memory-shard-settings-panel">
      <div className={CARD}>
        {/* One row: what this is, and whether it is on. */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">database</span>
              <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
                {t("clawkeep.memory.settings.switchTitle")}
              </label>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">
              {t("clawkeep.memory.settings.switchHint")}
            </p>
          </div>
          <Switch
            checked={state.enabled}
            busy={busy}
            label={t("clawkeep.memory.settings.switchTitle")}
            onChange={(next) => void save(next)}
          />
        </div>

        {/* Said plainly, because the honest promise is narrow: ClawBox stops
            starting passes, and what is already indexed stays searchable. */}
        {!state.enabled && (
          <p className="text-[11px] text-amber-400 mt-3 leading-relaxed" data-testid="memory-shard-off-hint">
            {t("clawkeep.memory.settings.offHint")}
          </p>
        )}

        {error && <StatusMessage type="error" message={error} />}
      </div>

      {/* The one owner tool this app has, in the row the Coding Agent's three
          sit in, so the two settings pages read as one family. */}
      <div className={`${CARD} grid gap-4 grid-cols-1 @md:grid-cols-2`} data-testid="memory-shard-owner-tools">
        <div className="flex flex-wrap items-center gap-2" data-testid="memory-shard-reset-card">
          {/* The name of the thing, beside its own help mark, the way every
              other row on this page and on the Coding Agent's is built. The
              mark's accessible name is "Start over" — which nothing on screen
              said, because the only visible words were the button's "Reset". */}
          <div className="basis-full flex items-center gap-1.5">
            <span className="text-xs font-medium text-[var(--text-secondary)]">
              {t("clawkeep.memory.reset.title")}
            </span>
            <HelpTip
              text={t("clawkeep.memory.reset.hint")}
              label={t("clawkeep.memory.reset.title")}
              testId="memory-shard-reset-help"
            />
          </div>
          <button
            type="button"
            onClick={() => void reset()}
            disabled={busy}
            data-testid="memory-shard-reset"
            className={`${confirmReset ? BTN_DANGER : BTN_SECONDARY} flex-1`}
          >
            {confirmReset ? t("clawkeep.memory.reset.confirm") : t("clawkeep.memory.reset.button")}
          </button>
          {/* Full-basis so the message lands under the button rather than
              beside it as a third column in this wrapping row. */}
          {resetError && <p className="basis-full mt-2 text-[11px] text-red-400" role="alert">{resetError}</p>}
        </div>
      </div>
    </div>
  );
}
