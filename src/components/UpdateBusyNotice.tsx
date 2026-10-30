"use client";

import { useTr } from "@/lib/i18n-floor";

/**
 * "N agent runs are active: wait for them / update anyway" (issue #1269).
 *
 * An update stops the assistant, which ends every agent run in flight. The
 * System Update page shows this when `update/run` refuses to start over active
 * runs; /updating shows it while a running update holds a gateway stop back
 * for them. `ask` offers both answers; `waiting` is the owner's "wait for
 * them", still with the way out.
 */
export default function UpdateBusyNotice({
  active,
  mode,
  hint,
  onWait,
  onUpdateAnyway,
  pending = false,
}: {
  /** How many runs are still active. */
  active: number;
  mode: "ask" | "waiting";
  /** What happens while it waits — said by the page, which knows. */
  hint: string;
  onWait?: () => void;
  onUpdateAnyway: () => void;
  /** An "Update anyway" is on its way to the server. */
  pending?: boolean;
}) {
  const tr = useTr();
  const title = mode === "ask"
    ? active === 1
      ? tr("update.busy.activeOne", "1 agent run is active")
      : tr("update.busy.active", "{count} agent runs are active", { count: active })
    : active === 1
      ? tr("update.busy.waitingOne", "Waiting for 1 agent run…")
      : tr("update.busy.waiting", "Waiting for {count} agent runs…", { count: active });
  return (
    <div
      role="status"
      data-testid="update-busy-notice"
      data-mode={mode}
      className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-left"
    >
      <p className="text-sm font-semibold text-amber-100">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-amber-100/80">
        {mode === "ask"
          ? tr("update.busy.body", "The update stops the assistant, which would cut them short. Wait for them to finish, or update anyway.")
          : hint}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {mode === "ask" && onWait && (
          <button
            type="button"
            onClick={onWait}
            data-testid="update-busy-wait"
            className="px-4 py-2 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-100 text-sm font-semibold hover:bg-amber-500/30 cursor-pointer"
          >
            {tr("update.busy.wait", "Wait for them")}
          </button>
        )}
        <button
          type="button"
          onClick={onUpdateAnyway}
          disabled={pending}
          data-testid="update-busy-anyway"
          className="px-4 py-2 rounded-full border border-[var(--border-subtle)] bg-white/[0.04] text-sm font-semibold text-gray-200 hover:bg-white/[0.08] disabled:opacity-50 cursor-pointer"
        >
          {tr("update.busy.updateAnyway", "Update anyway")}
        </button>
      </div>
    </div>
  );
}
