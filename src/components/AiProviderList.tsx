"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import AIProviderIcon from "./AIProviderIcon";
import AnthropicAccountsCard from "./AnthropicAccountsCard";
import ClawboxAiUsageCard from "./ClawboxAiUsageCard";
import PluginRepairNotice from "./PluginRepairNotice";
import ProviderConnectionLabel from "./ProviderConnectionLabel";
import SettingsDisclosureButton from "./SettingsDisclosureButton";
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

/** How long the armed "Sign out — tap again" waits for the second tap. */
const SIGN_OUT_CONFIRM_MS = 5_000;

interface AiProviderListProps {
  /**
   * A deep link asked to see the Anthropic accounts — the coding agent's
   * usage-limit notices do (`OPEN_ANTHROPIC_ACCOUNTS_SETTINGS`). While true,
   * the list opens the accounts disclosure and brings the Anthropic row into
   * view as soon as that row is on screen, then says so through
   * `onAnthropicAccountsShown`. Settings clears the ask there, so that coming
   * back to this page later — which remounts the list — is not taken for the
   * same notice again.
   */
  showAnthropicAccounts?: boolean;
  onAnthropicAccountsShown?: () => void;
}

export default function AiProviderList({ showAnthropicAccounts = false, onAnthropicAccountsShown }: AiProviderListProps = {}) {
  const { t } = useT();
  const { summary, loading, error, settingDefault, defaultError, defaultWarning, setDefault, refresh } = useProviderStatus();
  const [toggling, setToggling] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  /**
   * Whether the ClawBox AI allowances are open. COLLAPSED BY DEFAULT, and not
   * persisted: the card polls the portal every minute for as long as it is
   * mounted, so "open" is a thing the owner is doing right now and not a
   * setting that quietly keeps a minute-poll running on every future visit to
   * this page. Collapsed means UNMOUNTED, which is what stops the poll — there
   * is no hidden-but-rendered state here.
   */
  const [usageOpen, setUsageOpen] = useState(false);
  /**
   * Whether the Anthropic accounts are open — the same rule as the allowances
   * above: COLLAPSED BY DEFAULT, not persisted, and collapsed means unmounted,
   * which is what stops the card's own 30-second re-read of the pool. The one
   * thing that opens it without a click is a deep link asking for it.
   */
  const [accountsOpen, setAccountsOpen] = useState(false);
  /**
   * Bumped with `accountsOpen` by a deep link. The effect that scrolls only
   * READS it, so it runs once per ask, after the commit that put the panel in
   * the DOM — and never sets state of its own.
   */
  const [revealRequest, setRevealRequest] = useState(0);
  const anthropicRowRef = useRef<HTMLLIElement | null>(null);
  /**
   * Signing out of ClawBox AI (POST /setup-api/ai-models/clawai/sign-out):
   * the first tap arms the button for a few seconds and the second signs out,
   * the same two-tap shape as the coding agent's ChatGPT sign-out. The list
   * then re-reads the box, and every other surface hears it through
   * `notifyProvidersChanged` — the row drops to its signed-out state from the
   * box's own answer, never an optimistic one.
   */
  const [signOutArmed, setSignOutArmed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutNote, setSignOutNote] = useState<string | null>(null);
  const signOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmSignOut = useCallback(() => {
    if (signOutTimer.current) clearTimeout(signOutTimer.current);
    signOutTimer.current = null;
    setSignOutArmed(false);
  }, []);
  useEffect(() => () => { if (signOutTimer.current) clearTimeout(signOutTimer.current); }, []);

  const signOutOfClawai = useCallback(async () => {
    disarmSignOut();
    setSigningOut(true);
    setToggleError(null);
    setSignOutNote(null);
    try {
      const res = await fetch("/setup-api/ai-models/clawai/sign-out", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" && data.error ? data.error : t("settings.providers.signOutFailed"));
      }
      setSignOutNote(t("settings.providers.signedOut"));
      refresh();
      notifyProvidersChanged();
    } catch (e) {
      setToggleError(e instanceof Error && e.message ? e.message : t("settings.providers.signOutFailed"));
    } finally {
      setSigningOut(false);
    }
  }, [disarmSignOut, refresh, t]);

  const onSignOutClick = useCallback(() => {
    if (signOutArmed) {
      void signOutOfClawai();
      return;
    }
    if (signOutTimer.current) clearTimeout(signOutTimer.current);
    signOutTimer.current = setTimeout(() => {
      signOutTimer.current = null;
      setSignOutArmed(false);
    }, SIGN_OUT_CONFIRM_MS);
    setSignOutArmed(true);
  }, [signOutArmed, signOutOfClawai]);

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
  // ...and not a provider this box can run NO model from (TASK-668). That is
  // the owner's ruling: a row whose every model the gateway would refuse is not
  // part of "what is connected", and the answer comes from the count the
  // catalog route's own enumeration already recorded — no probe, no fork. The
  // server names them and keeps them (`unrunnable`), so the Connect list below
  // can still offer one with its real connection label; the hiding is here,
  // where this list already decides what belongs in it.
  const unrunnable = new Set(summary?.unrunnable ?? []);
  const rows = (summary?.providers ?? []).filter((row) =>
    (row.state === "connected" || row.state === "needs-reauth")
    && row.section !== "localAi"
    && !unrunnable.has(row.id),
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
  // Said once the box's own answer shows ClawBox AI signed out, and gone again
  // once a sign-in has connected it.
  const signedOutNote = signOutNote && !rows.some((row) => row.id === "clawai" && row.state === "connected")
    ? signOutNote
    : null;

  const awaitingProbe = rows.length === 0
    && (summary?.providers ?? []).some((row) => row.state === "checking");

  const hasAnthropicRow = rows.some((row) => row.id === "anthropic");
  // Whether an Anthropic row could still turn up: before the first read, or
  // while the box is still probing that one provider. A deep link waits that
  // out rather than being spent on a list that has not finished arriving.
  const anthropicPending = loading
    || (summary?.providers ?? []).some((row) => row.id === "anthropic" && row.state === "checking");

  // The usage-limit notices land here asking for the accounts. Opened and
  // scrolled to once the row is on screen; on a box with no Anthropic sign-in
  // there is no row and so nothing to show, and the ask is spent all the same.
  useEffect(() => {
    if (!showAnthropicAccounts) return;
    if (hasAnthropicRow) {
      // A request from outside is external state the list synchronises to,
      // like ChromeWindow's maximize signal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAccountsOpen(true);
      setRevealRequest((n) => n + 1);
    } else if (anthropicPending) {
      return;
    }
    onAnthropicAccountsShown?.();
  }, [showAnthropicAccounts, hasAnthropicRow, anthropicPending, onAnthropicAccountsShown]);

  // A pass of its own so the scroll runs AFTER the commit that mounted the
  // panel: aligned to the row's top, the card under it comes into view with it.
  useEffect(() => {
    if (!revealRequest) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    // Guarded: jsdom ships an Element without it.
    anthropicRowRef.current?.scrollIntoView?.({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  }, [revealRequest]);

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="ai-provider-list">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>smart_toy</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
          {t("settings.providers.title")}
        </h3>
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
      {/* The sign-out's outcome, in a region mounted in every state for the
          reason the warning below is. */}
      <div
        role="status"
        aria-live="polite"
        data-testid="ai-provider-sign-out-note"
        className={signedOutNote
          ? "mb-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] text-[var(--text-secondary)]"
          : ""}
      >
        {signedOutNote ?? ""}
      </div>
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
            // The ClawBox AI allowances belong to ONE row and hang off it here
            // rather than standing as a card of their own further down the page
            // (where they used to sit, always open, polling the portal for
            // anyone who opened Providers for any reason at all).
            //
            // Gated on `row.enabled`, not merely on the row existing: a
            // provider the owner has switched off is not being spent, so an
            // allowance meter beside it would be describing a budget nothing is
            // drawing on. And the row itself is only ever here for a provider
            // that holds a sign-in — so on a box with no ClawBox AI credential
            // there is no row, and therefore no button either.
            const hasUsage = row.id === "clawai" && row.enabled;
            // The Anthropic accounts the coding agent spends, in the owner's
            // order (TASK-902), likewise hang off their provider's row instead
            // of standing open as a card below the connect panel. Same gate on
            // the row existing — accounts need an Anthropic sign-in, so no row
            // means no accounts UI — but NOT on `row.enabled`: that switch only
            // takes Anthropic out of the CHAT's routing, and coding runs go on
            // drawing on this pool with it off.
            const hasAccounts = row.id === "anthropic";
            // ClawBox AI's sign-out, on the row of a sign-in the box holds —
            // the default's too: that is the account the box was otherwise
            // left with no way out of. OpenClaw only (the route's rule).
            const canSignOut = row.id === "clawai" && row.state === "connected" && summary?.harness === "openclaw";
            return (
              <Fragment key={row.id}>
              {/* Stacked below `sm:`, one line above it. At 390 px the row had
                  an icon, a name, a Default pill, a Make-default button and a
                  44 px switch competing for ~290 px, so the only thing that
                  could give — the name — gave: "OpenAI G…", "Anthropic Cla…".
                  The controls go under the name at phone widths instead, and
                  the name is allowed to wrap there rather than be clipped. */}
              <li
                ref={hasAccounts ? anthropicRowRef : undefined}
                className="flex flex-col @md:flex-row @md:items-center gap-2 @md:gap-3 px-3 py-2.5"
                data-testid={`ai-provider-${row.id}`}
              >
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
                    {/* "Not connected" is true here and useless on its own: the
                        boot script could not install or consent this provider's
                        plugin and switched it off so the gateway could start.
                        Shown even for a provider the owner has SWITCHED OFF —
                        that switch and this failure are different facts, and
                        hiding the second behind the first is how the owner ends
                        up switching a provider on and watching nothing happen. */}
                    {row.needsRepair && (
                      <PluginRepairNotice
                        repair={row.needsRepair}
                        onRepaired={refresh}
                        onRecheck={refresh}
                        className="mt-0.5"
                      />
                    )}
                  </span>
                </span>

                {/* `flex-wrap` for the Anthropic row in a narrow pane: its
                    accounts button, Make-default and the switch are wider
                    together than a 300 px window's row, and a line that cannot
                    wrap is clipped by the list's `overflow-hidden`. A wide pane
                    keeps them on one line — this span does not shrink there. */}
                <span className="flex flex-wrap items-center gap-3 shrink-0 self-start @md:self-auto" data-testid={`ai-provider-controls-${row.id}`}>
                  {hasUsage && (
                    <SettingsDisclosureButton
                      open={usageOpen}
                      onToggle={() => setUsageOpen((open) => !open)}
                      // The block's own name, so the button says exactly what it
                      // reveals. Already translated into all ten locales as the
                      // card's heading — the disclosure needs no word of its own.
                      label={t("clawaiUsage.title")}
                      controls="clawai-usage-panel"
                      variant="inline"
                      testId="clawai-usage-toggle"
                    />
                  )}

                  {hasAccounts && (
                    <SettingsDisclosureButton
                      open={accountsOpen}
                      onToggle={() => setAccountsOpen((open) => !open)}
                      // The card's own heading, translated in every locale.
                      label={t("settings.anthropicAccounts.title")}
                      controls="anthropic-accounts-panel"
                      variant="inline"
                      testId="anthropic-accounts-toggle"
                    />
                  )}

                  {canSignOut && (
                    <button
                      type="button"
                      onClick={onSignOutClick}
                      onBlur={disarmSignOut}
                      disabled={signingOut || busy}
                      aria-busy={signingOut}
                      data-testid="ai-provider-sign-out-clawai"
                      className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50 shrink-0 ${
                        signOutArmed ? "border-red-400/40 text-red-300 hover:bg-red-400/10" : "border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
                      }`}
                    >
                      {signOutArmed ? t("settings.providers.signOutConfirm") : t("settings.providers.signOut")}
                    </button>
                  )}

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

              {/* Mounted only while open, which is the whole mechanism: the
                  card's minute-poll of `/setup-api/ai-models/usage` lives in
                  its own effect, so a collapsed panel is not a hidden one —
                  it does not exist and cannot fetch. Its `id` is what the
                  button's `aria-controls` names. */}
              {hasUsage && usageOpen && (
                <li className="p-3 bg-black/10" id="clawai-usage-panel" data-testid="clawai-usage-panel">
                  <ClawboxAiUsageCard />
                </li>
              )}

              {/* The same mechanism for the accounts: mounted only while open,
                  so the card's pool re-read stops with the collapse. */}
              {hasAccounts && accountsOpen && (
                <li className="p-3 bg-black/10" id="anthropic-accounts-panel" data-testid="anthropic-accounts-panel">
                  <AnthropicAccountsCard />
                </li>
              )}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <li className="px-3 py-3 text-[11px] text-[var(--text-muted)]">
              {t("settings.providers.empty")}
            </li>
          )}
        </ul>
      )}

      {/* Plugins with no row of their own (TASK-738).
          A core bump strands entries for plugins an older core bundled; the
          updater switches them off so the gateway can report ready, and this
          is the only place on the box that says so. Rendered OUTSIDE the list
          above, and outside its loading gate: these rows come from the marker
          file, not from a provider probe, and hiding them behind a skeleton
          that is waiting on someone else's dashboard is how a switched-off
          plugin stays invisible.
          The plugin's own id is the label. It is what `openclaw plugins` calls
          it and what the core's own sentence beside it names — a translated
          display name would have to be invented per plugin for a set this
          repo deliberately does not enumerate. */}
      {(summary?.unattachedRepairs ?? []).length > 0 && (
        <div className="mt-4" data-testid="ai-provider-plugin-repairs">
          {/* The label is what stops a name the owner has never seen from
              appearing in his provider list with no explanation. The plugin id
              itself is not translated: it is what `openclaw plugins` calls it
              and what the core's own sentence beside it names. */}
          <h4 className="block mb-2 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">
            {t("settings.providers.strandedPlugins")}
          </h4>
          <ul className="space-y-2 list-none p-0 m-0">
            {(summary?.unattachedRepairs ?? []).map((repair) => (
              <li key={repair.pluginId} className="rounded-xl border border-white/[0.08] px-3 py-2">
                <span className="block text-[11px] font-medium text-[var(--text-secondary)] break-words">
                  {repair.pluginId}
                </span>
                <PluginRepairNotice repair={repair} onRepaired={refresh} onRecheck={refresh} className="mt-0.5" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
