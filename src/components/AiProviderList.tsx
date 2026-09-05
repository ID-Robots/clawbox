"use client";

import { useCallback, useState } from "react";
import { useT } from "@/lib/i18n";
import AIProviderIcon from "./AIProviderIcon";
import ProviderConnectionLabel from "./ProviderConnectionLabel";
import { useProviderStatus } from "@/hooks/useProviderStatus";
import { notifyProvidersChanged } from "@/lib/ui-events";
import type { ProviderStatusRow } from "@/lib/provider-status";

/**
 * The cloud providers the owner has connected, each row with its state,
 * whether it is the default, and a switch that takes it out of routing
 * without touching its credential. Providers without a sign-in are not
 * listed; connecting one is the panel below this list, and the on-device
 * engines have their own tab (Settings → Local AI).
 *
 * WHY A SWITCH AND NOT "DISCONNECT": a disabled provider keeps its key (or its
 * OAuth grant, which has no re-auth path in this UI) and simply stops being
 * offered to the chat and the fallback chain. The one thing it can never do is
 * disable the provider that is currently the default — the switch is locked
 * with a hint instead, so nothing here re-routes the chat behind the owner's
 * back. Both rules live in the route (`/setup-api/providers/enabled`); this
 * component only reflects them.
 */

export default function AiProviderList() {
  const { t } = useT();
  const { summary, loading, error, settingDefault, defaultError, defaultWarning, setDefault, refresh } = useProviderStatus();
  const [toggling, setToggling] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const setEnabled = useCallback(async (row: ProviderStatusRow, enabled: boolean) => {
    setToggling(row.id);
    setToggleError(null);
    try {
      const res = await fetch("/setup-api/providers/enabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: row.id, enabled }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`);
      }
      refresh();
      // The chat's model picker offers providers too; it must stop offering
      // this one now, not on its own next load.
      notifyProvidersChanged();
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : t("settings.providers.changeFailed"));
    } finally {
      setToggling(null);
    }
  }, [refresh, t]);

  // Only providers that actually hold a sign-in belong here: this list is
  // about which of the owner's providers answer, in what order, and which are
  // switched off. Connecting a new one is the panel below. A provider whose
  // sign-in needs refreshing is still theirs and stays listed.
  const rows = (summary?.providers ?? []).filter((row) =>
    (row.state === "connected" || row.state === "needs-reauth") && row.section !== "localAi",
  );

  // A row nobody has probed yet cannot be filtered INTO this list — it is not
  // known to hold a sign-in — and the filter above therefore turns a box whose
  // harness is still booting into "No providers connected", which is a
  // confident lie about a working box. Stay on the skeleton until there is
  // something real to show; `useProviderStatus` re-asks on its own until the
  // answers arrive, and the server stops saying `checking` either way
  // (TASK-663). Only while the list would be EMPTY, though: ClawBox AI's link
  // is read from our own store and needs no dashboard, so a row we already
  // know about is shown rather than hidden behind everyone else's spinner.
  const awaitingProbe = rows.length === 0
    && (summary?.providers ?? []).some((row) => row.state === "checking");

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="ai-provider-list">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>smart_toy</span>
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.providers.title")}
        </label>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-4 leading-relaxed">
        {t("settings.providers.hint")}
      </p>

      {error && (
        <div role="alert" className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
          {t("settings.providers.readError")}
        </div>
      )}
      {(defaultError || toggleError) && (
        <div role="alert" className="mb-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
          {defaultError ?? toggleError}
        </div>
      )}
      {/* A default that WAS written, with the box qualifying it — the gateway
          restart had not finished when the route answered, or it was refused
          by a unit an update has masked. Amber and `status`, never the red
          `alert` above: the change landed either way, and a failure here sends
          the owner to click it again for another restart.

          MOUNTED IN EVERY STATE, for the same reason the checking region below
          is: a live region that appears together with its text announces a node
          insertion, which assistive tech may drop entirely — and this sentence
          is the only thing on screen saying the change landed at all. The
          chrome is what is conditional, not the node. */}
      <div
        role="status"
        aria-live="polite"
        data-testid="ai-provider-default-warning"
        className={defaultWarning
          ? "mb-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200"
          : ""}
      >
        {defaultWarning ?? ""}
      </div>

      {/* Three grey bars are indistinguishable from a hung page, and the wait
          they stand for is the unit's own start window — up to
          `TimeoutStartSec` on a box whose ExecStartPre is grinding. Say which
          of the two it is, in the owner's language, with the word the rows
          below already use.

          MOUNTED IN EVERY STATE, empty when there is nothing to say: a live
          region that appears along with its text announces a node insertion,
          which assistive tech may drop entirely. A region that is already there
          announces a text CHANGE, which it will not — and the same applies on
          the way out, where the emptying is what says the wait is over. Outside
          the branch below for the same reason: that branch unmounts. */}
      <p
        role="status"
        aria-live="polite"
        data-testid="ai-provider-list-checking"
        className={`text-[11px] text-[var(--text-muted)] ${awaitingProbe ? "mb-2" : ""}`}
      >
        {awaitingProbe ? t("settings.checking") : ""}
      </p>

      {loading || awaitingProbe ? (
        <div className="space-y-2" data-testid="ai-provider-list-loading">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded-xl bg-white/[0.04] motion-safe:animate-pulse" />
          ))}
        </div>
      ) : (
        /* A CONTAINER, not the viewport. The defect is about how wide this
           PANE is: Settings caps it at `max-w-xl` (576 px) and draws it inside
           a ChromeWindow the owner can drag down to 300 px, so a `sm:`
           breakpoint — which asks the viewport — is answered "wide" on a
           desktop whose provider rows are 300 px across. `@container` is what
           the rest of this codebase already uses for exactly this (the Coding
           Agent panel, the skills store). `@md` is 28 rem: below it the icon,
           the name, the Default pill, the Make-default button and the 44 px
           switch cannot share a line without the name giving way. */
        <ul className="@container rounded-xl border border-white/[0.08] overflow-hidden divide-y divide-white/[0.06]">
          {rows.map((row) => {
            const busy = toggling === row.id || settingDefault === row.id;
            const canMakeDefault = row.enabled && row.state === "connected" && !row.isDefault;
            return (
              /* Stacked below `sm:`, one line above it. At 390 px the row had
                 an icon, a name, a Default pill, a Make-default button and a
                 44 px switch competing for ~290 px, so the only thing that
                 could give — the name — gave: "OpenAI G…", "Anthropic Cla…".
                 The controls go under the name at phone widths instead, and
                 the name is allowed to wrap there rather than be clipped. */
              <li key={row.id} className="flex flex-col @md:flex-row @md:items-center gap-2 @md:gap-3 px-3 py-2.5" data-testid={`ai-provider-${row.id}`}>
                <span className="flex items-center gap-3 min-w-0 @md:flex-1">
                  <span className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 bg-white/[0.06] ${row.enabled ? "" : "opacity-40"}`}>
                    <AIProviderIcon provider={row.id} size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap @md:flex-nowrap items-center gap-2">
                      <span
                        data-testid={`ai-provider-name-${row.id}`}
                        /* `break-words` beside the wrap: on Hermes the label is
                           whatever the dashboard reports, so an unbroken one
                           has to be allowed to break rather than be hard-clipped
                           with no ellipsis to say so. `min-w-0` is what lets it:
                           `overflow-wrap: break-word` does NOT reduce a flex
                           item's min-content width, so without it the item
                           refuses to shrink and the long word overflows the
                           pane instead of wrapping inside it. */
                        className={`min-w-0 text-sm font-medium break-words @md:truncate ${row.enabled ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
                      >
                        {row.label}
                      </span>
                      {row.isDefault && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--coral-bright)] border-[var(--coral-bright)]/40" data-testid={`ai-provider-default-${row.id}`}>
                          {t("settings.providers.default")}
                        </span>
                      )}
                    </span>
                    {row.enabled
                      ? <ProviderConnectionLabel state={row.state} className="text-[11px]" />
                      : <span className="block text-[11px] text-[var(--text-muted)]">{t("settings.providers.switchedOff")}</span>}
                    {/* Visible, not only a hover title: on a phone there is no
                        hover, and a dimmed switch with no reason looks broken.
                        The switch names this line as its description. */}
                    {row.isDefault && (
                      <span
                        id={`ai-provider-locked-${row.id}`}
                        className="block text-[11px] text-[var(--text-secondary)]"
                        data-testid={`ai-provider-locked-hint-${row.id}`}
                      >
                        {t("settings.providers.lockedHint")}
                      </span>
                    )}
                  </span>
                </span>

                <span className="flex items-center gap-3 shrink-0 self-start @md:self-auto" data-testid={`ai-provider-controls-${row.id}`}>
                  {canMakeDefault && (
                    <button
                      type="button"
                      onClick={() => void setDefault(row.id)}
                      disabled={busy}
                      data-testid={`ai-provider-make-default-${row.id}`}
                      className="text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50 shrink-0"
                    >
                      {t("settings.providers.makeDefault")}
                    </button>
                  )}

                  {/* The default cannot be switched off — the hint says what to do instead. */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={row.enabled}
                    aria-label={t("settings.providers.enable", { name: row.label })}
                    aria-busy={busy}
                    aria-describedby={row.isDefault ? `ai-provider-locked-${row.id}` : undefined}
                    disabled={busy || row.isDefault}
                    title={row.isDefault ? t("settings.providers.lockedHint") : undefined}
                    onClick={() => void setEnabled(row, !row.enabled)}
                    data-testid={`ai-provider-switch-${row.id}`}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ${
                      row.enabled ? "bg-[var(--coral-bright)]" : "bg-gray-600"
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${row.enabled ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                </span>
              </li>
            );
          })}
          {rows.length === 0 && (
            <li className="px-3 py-3 text-[11px] text-[var(--text-muted)]">
              {t("settings.providers.empty")}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
