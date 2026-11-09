"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import AIProviderIcon from "./AIProviderIcon";
import AnthropicAccountsCard from "./AnthropicAccountsCard";
import ClawboxAiUsageCard from "./ClawboxAiUsageCard";
import PluginRepairNotice from "./PluginRepairNotice";
import ProviderConnectionLabel from "./ProviderConnectionLabel";
import SettingsDisclosureButton from "./SettingsDisclosureButton";
import { useProviderStatus } from "@/hooks/useProviderStatus";
import { useProviderAuthTasks } from "@/hooks/useProviderAuthTasks";
import { notifyBackgroundTaskStarted, waitForBackgroundTaskEnd } from "@/lib/background-task-client";
import type { ProviderAuthTask } from "@/lib/provider-auth-task-client";
import { notifyProvidersChanged } from "@/lib/ui-events";
import type { ProviderStatusRow } from "@/lib/provider-status";

/**
 * The cloud providers the owner has connected, each row with its state,
 * whether it is the default, and a switch that takes it out of routing
 * without touching its credential. Providers without a sign-in are not
 * listed; connecting one is the panel below this list, and the on-device
 * engines have their own tab (Settings → Local AI).
 *
 * A SWITCH AND A SIGN-OUT, for two different asks. A disabled provider keeps
 * its key (or its OAuth grant) and simply stops being offered to the chat and
 * the fallback chain; "Sign out of <Provider>" removes the credential from the
 * box (`/setup-api/providers/sign-out`). Neither may re-route the chat behind
 * the owner's back, so on the DEFAULT row both are locked with the same "make
 * another provider the default first" hint — except ClawBox AI's sign-out,
 * which stays offered there (#1369: the box's own provider, the one a box with
 * nothing else has no other way out of; its row then reads "Sign in again").
 * The rules live in the routes; this component only reflects them.
 *
 * THE BOX'S WORK, NOT THE WINDOW'S (TASK-2148). A sign-out — and the box's
 * half of a sign-in — runs as a background task of the box
 * (src/lib/provider-auth-tasks.ts), which the desktop's corner card shows
 * too. This list follows the task by its id; closing Settings only stops the
 * following. Opened again (here, in another tab, on another device) it reads
 * the tasks the box is running (`useProviderAuthTasks`) and draws the change
 * in progress: a sign-out's row in hand with its spinner, followed to its end
 * exactly as if this window had started it; a provider being connected as a
 * row of its own with the same spinner. Every row's controls wait while any
 * change runs — the box runs one at a time.
 */

/** How long the armed "Sign out — tap again" waits for the second tap. */
const SIGN_OUT_CONFIRM_MS = 5_000;
/**
 * How long "Signed out of …" stays up once the box's answer shows the row
 * signed out. globals.css `provider-sign-out-note` folds it away over the last
 * quarter second of the same span — keep the two together.
 */
const SIGNED_OUT_NOTE_MS = 3_000;
/**
 * How long a row just signed out is held: the fold of one the box no longer
 * lists (`provider-row-leave`, 320 ms) or the brightening of one it still does
 * (`provider-row-settle`), and a little over.
 */
const SIGNED_OUT_ROW_MS = 600;
/**
 * The longest the request that STARTS a sign-out is waited for. The sign-out
 * itself is a task of the box, followed for as long as it runs; its request
 * answers at once, and one that never answers must not hold every row's
 * controls for good.
 */
export const SIGN_OUT_REQUEST_MS = 150_000;
/**
 * The longest a sign-out that landed waits on the box's re-read before it lets
 * the row go — for a read that never finishes at all. A read that finishes,
 * answered or failed, ends the wait itself; on a board one takes seconds.
 */
export const SIGN_OUT_SETTLE_MS = 30_000;

/** A row as it was when its sign-out was tapped, and where it stood in the list. */
interface HeldRow {
  row: ProviderStatusRow;
  index: number;
}

/**
 * A sign-out in flight: the box's task removing the sign-in (`request`), the
 * restart behind it (`restarting`, the task's own step), and the box's re-read
 * after it (`settling`, with the number of that read — `useProviderStatus`).
 */
interface SignOutFlow extends HeldRow {
  phase: "request" | "restarting" | "settling";
  read?: number;
  /** The box's task, once the route has named it. */
  taskId?: string;
}

/** A row for a provider the box is changing but no longer (or not yet) lists. */
function rowForTask(task: ProviderAuthTask): ProviderStatusRow {
  return { id: task.provider, label: task.label, state: "connected", isDefault: false, enabled: true, section: "ai" };
}

/** The class each sign-out state puts on its row (globals.css). */
const SIGN_OUT_ROW_CLASS = {
  pending: "provider-sign-out-pending",
  leaving: "provider-sign-out-leaving",
  settled: "provider-sign-out-settled",
} as const;

/**
 * The box of a labelled button among a row's controls — Make default and the
 * sign-out — matching the inline disclosures beside them (SettingsDisclosureButton)
 * in height, type size and centring. Never wraps: a two-line button in a row of
 * one-line ones is the defect this replaced.
 */
const ROW_BUTTON = "inline-flex items-center whitespace-nowrap shrink-0 text-[11px] px-2.5 py-1 rounded-lg border";

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

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
  const { summary, loading, error, settingDefault, defaultError, defaultWarning, setDefault, refresh, readNonce, summaryNonce } = useProviderStatus();
  /** The provider change the box is running, whoever started it (TASK-2148). */
  const { running: providerChange } = useProviderAuthTasks();
  /** Sign-out tasks this list already follows (or has followed), so one is never taken up twice. */
  const followedSignOuts = useRef(new Set<string>());
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
   * Signing out of a provider (POST /setup-api/providers/sign-out): the first
   * tap arms THAT row's button for a few seconds and the second signs out,
   * the same two-tap shape as the coding agent's ChatGPT sign-out. One row is
   * armed at a time — arming another disarms the first — and one sign-out runs
   * at a time. The list then re-reads the box, and every other surface hears
   * it through `notifyProvidersChanged` — the row drops to its signed-out
   * state from the box's own answer, never an optimistic one.
   *
   * WHAT THE OWNER SEES MEANWHILE (TASK-2126). The second tap used to change
   * nothing on screen until the row finally did, which on a sign-out that
   * restarts the gateway is a minute of a page that looks as if the tap was
   * lost. Now the tapped row is visibly in hand from the second tap to the
   * box's own answer: its button is a spinner reading "Signing out…" (and
   * takes no second submit), the rest of the row dims under a slow sheen, and
   * that holds through the request, through the restart behind it when the
   * route says one is underway (`gatewayRestarting`, waited out against
   * /setup-api/gateway/health like the configure overlay does), and through
   * the re-read after it. Then a row the box no longer lists folds away, one
   * it still lists — ClawBox AI as the default, now "Needs sign-in" —
   * brightens into its new state, and "Signed out of …" stands above the list
   * for a few seconds. A refusal gives the row back as it was, with the box's
   * reason under its own button. Reduced motion keeps every state and every
   * word and drops the movement: no sheen, no fold, no fade.
   */
  const [signOutArmed, setSignOutArmed] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<SignOutFlow | null>(null);
  /** The row just signed out, held for its fold or its brightening — never under reduced motion. */
  const [signedOutRow, setSignedOutRow] = useState<HeldRow | null>(null);
  /** A refused sign-out, said on the row that was tapped. */
  const [signOutError, setSignOutError] = useState<{ id: string; message: string } | null>(null);
  /**
   * The provider just signed out of, for the note above the list — said in
   * the reader's language at render, for SIGNED_OUT_NOTE_MS. Set only once the
   * box's own answer has landed, so it never runs ahead of the rows; cleared
   * early if a read made after the sign-out shows the provider connected (a
   * new sign-in). `read`: the number of the first such read — an older list,
   * still on screen when the re-read failed, says nothing about it.
   */
  const [signOutNote, setSignOutNote] = useState<{ id: string; label: string; read: number } | null>(null);
  const signOutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stops a sign-out request or gateway wait this list is no longer on screen for. */
  const signOutAbort = useRef<AbortController | null>(null);
  const disarmSignOut = useCallback(() => {
    if (signOutTimer.current) clearTimeout(signOutTimer.current);
    signOutTimer.current = null;
    setSignOutArmed(null);
  }, []);
  useEffect(() => () => {
    if (signOutTimer.current) clearTimeout(signOutTimer.current);
    signOutAbort.current?.abort();
  }, []);

  /**
   * Run a sign-out on this row: start it on the box (`adopt` absent) or take
   * up the one the box is already running (`adopt`, its task id), then follow
   * that task to its end, the row in hand throughout.
   */
  const runSignOut = useCallback(async (row: ProviderStatusRow, index: number, adopt?: string) => {
    disarmSignOut();
    signOutAbort.current?.abort();
    const abort = new AbortController();
    signOutAbort.current = abort;
    setSigningOut({ row, index, phase: "request", ...(adopt ? { taskId: adopt } : {}) });
    setToggleError(null);
    setSignOutError(null);
    setSignOutNote(null);
    const failed = t("settings.providers.signOutFailed", { name: row.label });
    let signedOut = false;
    let timedOut = false;
    try {
      let taskId = adopt ?? null;
      if (!taskId) {
        // Bounds the request that starts the sign-out, not the sign-out: the
        // box runs that as a task, followed below for as long as it runs.
        const requestTimer = setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, SIGN_OUT_REQUEST_MS);
        try {
          const res = await fetch("/setup-api/providers/sign-out", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: row.id }),
            signal: abort.signal,
          });
          const data = (await res.json().catch(() => ({}))) as { error?: unknown; taskId?: unknown };
          if (timedOut) throw new Error(failed);
          if (!res.ok) {
            throw new Error(typeof data.error === "string" && data.error ? data.error : failed);
          }
          taskId = typeof data.taskId === "string" && data.taskId ? data.taskId : null;
        } finally {
          clearTimeout(requestTimer);
        }
        if (!taskId) throw new Error(failed);
        followedSignOuts.current.add(taskId);
        // The corner card asks at once rather than at its next poll.
        notifyBackgroundTaskStarted(taskId);
      }
      const id = taskId;
      // The row stays in hand through the whole task, its restart included:
      // read before the task has ended, the box would still be answering from
      // the old process.
      const ended = await waitForBackgroundTaskEnd(id, {
        signal: abort.signal,
        onUpdate: (task) => {
          const phase = task.state === "running" && task.steps.some((step) => step.id === "restart" && step.state === "running")
            ? "restarting"
            : "request";
          setSigningOut((flow) => (
            flow?.row.id === row.id && (flow.phase !== phase || flow.taskId !== id) && flow.phase !== "settling"
              ? { ...flow, phase, taskId: id }
              : flow
          ));
        },
      });
      if (abort.signal.aborted) throw new Error(failed);
      if (!ended) throw new Error(failed);
      if (ended.state !== "succeeded") throw new Error(ended.error || failed);
      signedOut = true;
    } catch (e) {
      // This list went away (or another sign-out took over): the box's task
      // goes on, and whichever list is on screen next follows it.
      if (abort.signal.aborted && !timedOut) return;
      // A request that never answered may still have signed out on the box:
      // say so, and let the re-read below show which.
      const message = timedOut
        ? t("settings.providers.signOutTimedOut", { name: row.label })
        : e instanceof Error && e.message ? e.message : failed;
      setSignOutError({ id: row.id, message });
    }
    // Re-read either way: a refusal can come after part of the sign-in was
    // removed, and the rows are the box's answer, not this click's. The
    // number of THIS read is what the row waits for below.
    const read = refresh();
    notifyProvidersChanged();
    // A sign-out that landed holds the row until that re-read has; a refused
    // one gives it back now, with the reason under its button.
    setSigningOut((flow) => (flow?.row.id !== row.id ? flow : signedOut ? { ...flow, phase: "settling", read } : null));
  }, [disarmSignOut, refresh, t]);

  const signOutOf = useCallback(
    (row: ProviderStatusRow, index: number) => runSignOut(row, index),
    [runSignOut],
  );

  const onSignOutClick = useCallback((row: ProviderStatusRow, index: number) => {
    // One sign-out at a time — one provider change at all, on the box. The
    // button in hand stays focusable (so a keyboard keeps its place through a
    // minute-long sign-out) and says it is disabled; this is what makes that
    // true.
    if (signingOut || providerChange) return;
    if (signOutArmed === row.id) {
      void signOutOf(row, index);
      return;
    }
    if (signOutTimer.current) clearTimeout(signOutTimer.current);
    signOutTimer.current = setTimeout(() => {
      signOutTimer.current = null;
      setSignOutArmed(null);
    }, SIGN_OUT_CONFIRM_MS);
    setSignOutArmed(row.id);
    setSignOutError(null);
  }, [signOutArmed, signingOut, providerChange, signOutOf]);

  /** The box has answered the re-read: let the row go, and say so. */
  const finishSignOut = useCallback((flow: SignOutFlow) => {
    setSigningOut((current) => (current === flow ? null : current));
    setSignOutNote({ id: flow.row.id, label: flow.row.label, read: flow.read ?? 0 });
    setSignedOutRow(prefersReducedMotion() ? null : { row: flow.row, index: flow.index });
  }, []);

  // The verdict is the re-read the sign-out asked for, by its number — never
  // an answer that was already on its way when the sign-out finished. Once it
  // has finished, answered or failed, the row is let go: answered, the list
  // is the box's word on it; failed, the list says it could not be read and is
  // the last known state, and the note still says what the sign-out did. The
  // timer is for a read that never finishes at all.
  // A LAYOUT effect: the answer that drops the row and the note that says why
  // are painted together, never a frame of a list with the row gone and
  // nothing said.
  const settling = signingOut?.phase === "settling" ? signingOut : null;
  useLayoutEffect(() => {
    // The box's re-read is external state this flow waits on.
    if (settling && readNonce >= (settling.read ?? 0)) finishSignOut(settling);
  }, [settling, readNonce, finishSignOut]);
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => finishSignOut(settling), SIGN_OUT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settling, finishSignOut]);

  useEffect(() => {
    if (!signOutNote) return;
    const timer = setTimeout(() => setSignOutNote(null), SIGNED_OUT_NOTE_MS);
    return () => clearTimeout(timer);
  }, [signOutNote]);
  useEffect(() => {
    if (!signedOutRow) return;
    const timer = setTimeout(() => setSignedOutRow(null), SIGNED_OUT_ROW_MS);
    return () => clearTimeout(timer);
  }, [signedOutRow]);

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
  // The row being signed out — or just signed out — that the box's answer no
  // longer lists, held in the place it had: while the sign-out still runs, so
  // nothing jumps under the owner's pointer, and after it so it can fold away
  // rather than vanish.
  // A sign-out the box is running that this list did not start — begun
  // before Settings was closed, or in another tab or on another device — is
  // taken up as if it had been: the row in hand, followed to its end, the
  // note after it (TASK-2148). Only once the list has answered, so the row is
  // the box's own where it still lists it.
  useEffect(() => {
    if (providerChange?.action !== "sign-out" || loading || signingOut) return;
    if (followedSignOuts.current.has(providerChange.id)) return;
    followedSignOuts.current.add(providerChange.id);
    const index = rows.findIndex((row) => row.id === providerChange.provider);
    // The box's task is external state this list follows, like a deep link.
    void runSignOut(index >= 0 ? rows[index] : rowForTask(providerChange), index >= 0 ? index : rows.length, providerChange.id);
  }, [providerChange, loading, signingOut, rows, runSignOut]);

  // A provider the box is connecting right now. A row it already lists shows
  // the spinner in place of its state; one it does not list yet is drawn as a
  // row of its own below the others until the box lists it.
  const connecting = providerChange?.action === "sign-in" ? providerChange : null;
  const connectingRow = connecting && !rows.some((row) => row.id === connecting.provider) ? connecting : null;

  const held = signingOut ?? signedOutRow;
  const shown = rows.map((row, index) => ({ row, index, held: false }));
  if (held && !rows.some((row) => row.id === held.row.id)) {
    shown.splice(Math.min(held.index, shown.length), 0, { row: held.row, index: held.index, held: true });
  }
  // A refusal is said on its row; one whose row has left the list (part of
  // the sign-in was removed before the refusal) is said above it instead.
  const strandedSignOutError = signOutError && !rows.some((row) => row.id === signOutError.id)
    ? signOutError.message
    : null;

  // Said once the box's own answer shows the provider signed out, and gone
  // again once a sign-in has connected it — by a list read after the
  // sign-out, not one left on screen by a re-read that failed.
  const noteRowConnected = !!signOutNote && summaryNonce >= signOutNote.read
    && rows.some((row) => row.id === signOutNote.id && row.state === "connected");
  const signedOutNote = signOutNote && !noteRowConnected
    ? t("settings.providers.signedOut", { name: signOutNote.label })
    : null;
  // Cleared — not only hidden — once the box shows it connected again, so a
  // refusal of that new sign-in ("Needs sign-in") cannot bring "Signed out"
  // back.
  useEffect(() => {
    if (signOutNote && noteRowConnected) setSignOutNote(null);
  }, [signOutNote, noteRowConnected]);

  const awaitingProbe = shown.length === 0
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
    // Guarded: jsdom ships an Element without it.
    anthropicRowRef.current?.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
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
      {(defaultError || toggleError || strandedSignOutError) && (
        <div role="alert" className="mb-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
          {/* Each said: a refusal whose row has gone has nowhere else to be. */}
          {(defaultError ?? toggleError) && <p>{defaultError ?? toggleError}</p>}
          {strandedSignOutError && <p>{strandedSignOutError}</p>}
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
          reason the warning below is. The note inside it is what comes and
          goes: it opens out, stands for SIGNED_OUT_NOTE_MS and folds away
          (globals.css `provider-sign-out-note`), so the list below it slides
          rather than jumps. While the sign-out runs it says so to assistive
          tech, which the spinner's own words — on a button, in no live region —
          would not. */}
      <div role="status" aria-live="polite" data-testid="ai-provider-sign-out-note">
        {signingOut && !signedOutNote && (
          <span className="sr-only" data-testid="ai-provider-sign-out-progress">
            {signingOut.phase === "restarting"
              ? `${t("settings.providers.signingOut")} ${t("settings.providers.signOutRestarting")}`
              : t("settings.providers.signingOut")}
          </span>
        )}
        {signedOutNote && (
          <p
            className="provider-sign-out-note mb-3 flex items-center gap-1.5 rounded-xl border border-[var(--cyan-bright)]/25 bg-[var(--cyan-bright)]/[0.06] px-3 py-2 text-[11px] text-[var(--text-primary)]"
            data-testid="ai-provider-signed-out"
          >
            <span aria-hidden="true" className="material-symbols-rounded shrink-0 text-[var(--cyan-bright)]" style={{ fontSize: 16 }}>check_circle</span>
            <span className="min-w-0 break-words">{signedOutNote}</span>
          </p>
        )}
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
        /* Each ROW decides, by its own content, not a breakpoint. The defect
           is about how wide this PANE is: Settings caps it at `max-w-xl`
           (576 px) and draws it inside a ChromeWindow the owner can drag down
           to 300 px, so a `sm:` breakpoint — which asks the viewport — is
           answered "wide" on a desktop whose provider rows are 300 px across.
           And no one pane width suits every row: the Anthropic row's accounts,
           Make default, sign-out and switch do not fit beside its name even at
           576 px, while ClawBox AI's three do with room to spare. So a row
           wraps: its controls stay beside the name while the name keeps
           `basis-40` (10 rem) of it, and take a line of their own under it
           when it would not. */
        <ul className="rounded-xl border border-white/[0.08] overflow-hidden divide-y divide-white/[0.06]">
          {shown.map(({ row, index, held: isHeld }) => {
            // Where this row is in a sign-out: running (`pending`), just
            // signed out and no longer listed (`leaving`, folding away), or
            // just signed out and still listed (`settled`, brightening into
            // its new state).
            const pending = signingOut?.row.id === row.id;
            const signOutState = pending
              ? "pending"
              : signedOutRow?.row.id === row.id ? (isHeld ? "leaving" : "settled") : undefined;
            // A leaving row keeps its spinner to the end: a label flipping
            // back to "Sign out of …" for the length of the fold reads as the
            // sign-out having been undone.
            const showPending = pending || signOutState === "leaving";
            // A sign-out in flight holds every row's Make default and switch:
            // the server refuses the default's sign-out, and a default moved
            // onto the provider being signed out would leave the chat on it
            // (the server serialises the two as well — provider-change-lock.ts).
            // A held row is a picture of one the box no longer lists: nothing
            // on it can be pressed.
            const busy = toggling === row.id || settingDefault === row.id || signingOut !== null || providerChange !== null || isHeld;
            const connectingHere = connecting?.provider === row.id && !isHeld;
            // ...and it answers to none of the row's test ids: those are the
            // box's answer, and that has let the row go.
            const tid = (id: string) => (isHeld ? undefined : id);
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
            const hasUsage = row.id === "clawai" && row.enabled && !isHeld;
            // The Anthropic accounts the coding agent spends, in the owner's
            // order (TASK-902), likewise hang off their provider's row instead
            // of standing open as a card below the connect panel. Same gate on
            // the row existing — accounts need an Anthropic sign-in, so no row
            // means no accounts UI — but NOT on `row.enabled`: that switch only
            // takes Anthropic out of the CHAT's routing, and coding runs go on
            // drawing on this pool with it off.
            const hasAccounts = row.id === "anthropic" && !isHeld;
            // The sign-out, on the row of every sign-in the box holds, on
            // either harness — a dead one too (a refused ClawBox AI token, a
            // Claude sign-in the gateway fenced off), which is still on the
            // box. `credentialHeld` is what tells the two "needs sign-in"
            // rows apart: that one, and the default left with NOTHING to
            // remove (ClawBox AI's after its own sign-out), which gets none.
            // An older server that does not say falls back to "not the
            // default". On the default it is LOCKED, like the switch —
            // signing the chat's own provider out would leave it answering
            // on nothing — except for ClawBox AI on OpenClaw, the account a
            // box with nothing else had no way out of (#1369). On Hermes it
            // is locked like any default. The route holds the same rule.
            const canSignOut = row.state === "connected"
              || (row.state === "needs-reauth" && (row.credentialHeld ?? !row.isDefault));
            const signOutLocked = row.isDefault && (row.id !== "clawai" || summary?.harness === "hermes");
            const armed = signOutArmed === row.id;
            // The button shows a word or two; its name and tooltip say whose
            // sign-in it removes, armed or not, and carry the words on it so a
            // voice user can say what they see.
            const signOutName = armed
              ? t("settings.providers.signOutConfirmNamed", { name: row.label })
              : t("settings.providers.signOut", { name: row.label });
            return (
              <Fragment key={row.id}>
              {/* One line where the controls fit beside the name, two where
                  they do not (see the list above). At 390 px the row once had
                  an icon, a name, a Default pill, a Make-default button and a
                  44 px switch competing for ~290 px, so the only thing that
                  could give — the name — gave: "OpenAI G…", "Anthropic Cla…".
                  The name's column now keeps its basis or the controls move
                  under it, and the name wraps rather than being clipped. */}
              {/* A held row answers to a test id of its own (see `tid`). The
                  parts that dim while a row is in hand carry
                  `provider-sign-out-dim`; the button and its words do not. */}
              <li
                ref={hasAccounts ? anthropicRowRef : undefined}
                className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 ${signOutState ? SIGN_OUT_ROW_CLASS[signOutState] : ""}`}
                data-testid={isHeld ? `ai-provider-held-${row.id}` : `ai-provider-${row.id}`}
                data-sign-out={signOutState}
                aria-busy={pending || undefined}
                aria-hidden={signOutState === "leaving" || undefined}
                inert={signOutState === "leaving" || undefined}
              >
                <span className="flex grow basis-40 items-center gap-3 min-w-0" data-testid={tid(`ai-provider-identity-${row.id}`)}>
                  {/* A switched-off provider's icon is already faded; dimmed
                      again on top it would all but vanish. */}
                  <span className={`shrink-0 ${row.enabled ? "provider-sign-out-dim" : ""}`}>
                    <span className={`flex items-center justify-center w-9 h-9 rounded-lg bg-white/[0.06] ${row.enabled ? "" : "opacity-40"}`}>
                      <AIProviderIcon provider={row.id} size={20} />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="provider-sign-out-dim flex flex-wrap items-center gap-2">
                      <span
                        data-testid={tid(`ai-provider-name-${row.id}`)}
                        /* `break-words` beside the wrap: on Hermes the label is
                           whatever the dashboard reports, so an unbroken one
                           has to be allowed to break rather than be hard-clipped
                           with no ellipsis to say so. `min-w-0` is what lets it:
                           `overflow-wrap: break-word` does NOT reduce a flex
                           item's min-content width, so without it the item
                           refuses to shrink and the long word overflows the
                           pane instead of wrapping inside it. Never truncated:
                           its column keeps at least `basis-40`, and a label
                           longer than that wraps rather than losing its end. */
                        className={`min-w-0 text-sm font-medium break-words ${row.enabled ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
                      >
                        {row.label}
                      </span>
                      {row.isDefault && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--coral-bright)] border-[var(--coral-bright)]/40" data-testid={tid(`ai-provider-default-${row.id}`)}>
                          {t("settings.providers.default")}
                        </span>
                      )}
                    </span>
                    {connectingHere
                      ? <ConnectingLabel providerId={row.id} />
                      : row.enabled
                        ? <ProviderConnectionLabel state={row.state} className="provider-sign-out-dim text-[11px]" />
                        : <span className="provider-sign-out-dim block text-[11px] text-[var(--text-muted)]">{t("settings.providers.switchedOff")}</span>}
                    {/* Visible, not only a hover title: on a phone there is no
                        hover, and a dimmed switch with no reason looks broken.
                        The switch names this line as its description. */}
                    {row.isDefault && (
                      <span
                        id={`ai-provider-locked-${row.id}`}
                        className="provider-sign-out-dim block text-[11px] text-[var(--text-secondary)]"
                        data-testid={tid(`ai-provider-locked-hint-${row.id}`)}
                      >
                        {t("settings.providers.lockedHint")}
                      </span>
                    )}
                    {/* A minute is long enough to need saying: the chat is
                        being restarted to drop the sign-in, not the page
                        stuck. */}
                    {pending && signingOut?.phase === "restarting" && (
                      <span
                        className="block mt-1 text-[11px] text-[var(--text-muted)]"
                        data-testid={tid(`ai-provider-sign-out-restarting-${row.id}`)}
                      >
                        {t("settings.providers.signOutRestarting")}
                      </span>
                    )}
                    {/* The box's refusal, on the row it refused, in its own words. */}
                    {signOutError?.id === row.id && !isHeld && (
                      <span
                        role="alert"
                        className="block mt-1 text-[11px] text-red-300 break-words"
                        data-testid={`ai-provider-sign-out-error-${row.id}`}
                      >
                        {signOutError.message}
                      </span>
                    )}
                    {/* "Not connected" is true here and useless on its own: the
                        boot script could not install or consent this provider's
                        plugin and switched it off so the gateway could start.
                        Shown even for a provider the owner has SWITCHED OFF —
                        that switch and this failure are different facts, and
                        hiding the second behind the first is how the owner ends
                        up switching a provider on and watching nothing happen.
                        Not on a held row: its Retry would repair a provider the
                        box no longer lists. */}
                    {row.needsRepair && !isHeld && (
                      <PluginRepairNotice
                        repair={row.needsRepair}
                        onRepaired={refresh}
                        onRecheck={refresh}
                        className="mt-0.5"
                      />
                    )}
                  </span>
                </span>

                {/* The row's controls, right-aligned beside the name — or, when
                    they do not fit beside it, on a line of their own under it,
                    still right-aligned (`ml-auto`). `flex-wrap` inside for a
                    300 px window, where even that line is too short for the
                    Anthropic row's four; a line that cannot wrap is clipped by
                    the list's `overflow-hidden`. Each control dims on its own
                    (`provider-sign-out-dim`) so the sign-out among them can stay
                    at full strength while its row is in hand. */}
                <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 ml-auto max-w-full" data-testid={tid(`ai-provider-controls-${row.id}`)}>
                  {hasUsage && (
                    <span className="provider-sign-out-dim flex shrink-0">
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
                    </span>
                  )}

                  {hasAccounts && (
                    <span className="provider-sign-out-dim flex shrink-0">
                      <SettingsDisclosureButton
                        open={accountsOpen}
                        onToggle={() => setAccountsOpen((open) => !open)}
                        // The card's own heading, translated in every locale.
                        label={t("settings.anthropicAccounts.title")}
                        controls="anthropic-accounts-panel"
                        variant="inline"
                        testId="anthropic-accounts-toggle"
                      />
                    </span>
                  )}

                  {canMakeDefault && (
                    <span className="provider-sign-out-dim flex shrink-0">
                      <button
                        type="button"
                        onClick={() => void setDefault(row.id)}
                        disabled={busy}
                        data-testid={tid(`ai-provider-make-default-${row.id}`)}
                        className={`${ROW_BUTTON} border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50`}
                      >
                        {t("settings.providers.makeDefault")}
                      </button>
                    </span>
                  )}

                  {/* The sign-out and the switch travel as one, the sign-out
                      always just left of the switch: the same place on every
                      row, the default's included, at every width. Its words
                      are short — "Sign out", then "Tap again" — where "Sign
                      out of Anthropic Claude" wrapped onto two lines in a tall
                      button and, inline under the status, ran into
                      "Connected"; the provider it signs out of is in its name
                      and tooltip instead. */}
                  <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 max-w-full" data-testid={tid(`ai-provider-sign-out-slot-${row.id}`)}>
                    {canSignOut && (
                      <button
                        type="button"
                        onClick={() => onSignOutClick(row, index)}
                        onBlur={armed ? disarmSignOut : undefined}
                        // The one in hand is disabled by `aria-disabled` and the
                        // guard in onSignOutClick, not by `disabled`: that would
                        // drop the focus it has from the second tap onto the
                        // page for the whole sign-out.
                        disabled={!pending && (busy || settingDefault !== null || signOutLocked)}
                        aria-disabled={pending || undefined}
                        aria-busy={pending}
                        // In hand the button's own words, "Signing out…", are
                        // its name; before that the visible verb names nobody.
                        aria-label={showPending ? undefined : signOutName}
                        aria-describedby={signOutLocked ? `ai-provider-locked-${row.id}` : undefined}
                        title={signOutLocked ? t("settings.providers.lockedHint") : showPending ? undefined : signOutName}
                        data-testid={tid(`ai-provider-sign-out-${row.id}`)}
                        // In hand it is a label, not a dead control: full
                        // strength, while the rest of the row dims around it.
                        className={`${ROW_BUTTON} gap-1.5 transition-colors ${
                          showPending
                            ? "border-white/15 text-[var(--text-primary)] cursor-progress"
                            : `disabled:opacity-50 disabled:cursor-not-allowed ${armed ? "border-red-400/40 text-red-300 hover:bg-red-400/10" : "border-white/10 text-[var(--text-secondary)] hover:bg-white/5"}`
                        }`}
                      >
                        {showPending ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="material-symbols-rounded motion-safe:animate-spin"
                              style={{ fontSize: 14 }}
                              data-testid={tid(`ai-provider-sign-out-spinner-${row.id}`)}
                            >
                              progress_activity
                            </span>
                            {t("settings.providers.signingOut")}
                          </>
                        ) : (
                          // Both words in one grid cell: the one not shown is
                          // the `::after` sizer, so the button is as wide as the
                          // wider of the two from the start and arming it never
                          // reflows the row — the second tap lands where the
                          // first one did. As text, the button holds only the
                          // word on it.
                          <span
                            className="grid justify-items-center after:invisible after:[grid-area:1/1] after:content-[attr(data-sizer)]"
                            data-sizer={armed ? t("settings.providers.signOutShort") : t("settings.providers.signOutConfirm")}
                            data-testid={tid(`ai-provider-sign-out-label-${row.id}`)}
                          >
                            <span className="[grid-area:1/1]">
                              {armed ? t("settings.providers.signOutConfirm") : t("settings.providers.signOutShort")}
                            </span>
                          </span>
                        )}
                      </button>
                    )}

                    {/* The default cannot be switched off — the hint says what to do instead. */}
                    <span className="provider-sign-out-dim flex shrink-0">
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
                        data-testid={tid(`ai-provider-switch-${row.id}`)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ${
                          row.enabled ? "bg-[var(--coral-bright)]" : "bg-gray-600"
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${row.enabled ? "translate-x-6" : "translate-x-1"}`} />
                      </button>
                    </span>
                  </span>
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
          {connectingRow && (
            <li
              className="flex items-center gap-3 px-3 py-2.5"
              data-testid={`ai-provider-connecting-${connectingRow.provider}`}
              aria-busy="true"
            >
              <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-white/[0.06] shrink-0">
                <AIProviderIcon provider={connectingRow.provider} size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block min-w-0 text-sm font-medium break-words text-[var(--text-primary)]">{connectingRow.label}</span>
                <ConnectingLabel providerId={connectingRow.provider} />
              </span>
            </li>
          )}
          {shown.length === 0 && !connectingRow && (
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

/**
 * "Connecting…" under a provider's name while the box connects it, with the
 * spinner the sign-out's button turns into — the same turning ring, so a
 * change in progress reads alike whichever way it goes.
 */
function ConnectingLabel({ providerId }: { providerId: string }) {
  const { t } = useT();
  return (
    <span
      role="status"
      className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]"
      data-testid={`ai-provider-connecting-label-${providerId}`}
    >
      <span
        aria-hidden="true"
        className="material-symbols-rounded motion-safe:animate-spin"
        style={{ fontSize: 14 }}
        data-testid={`ai-provider-connecting-spinner-${providerId}`}
      >
        progress_activity
      </span>
      {t("settings.providers.connecting")}
    </span>
  );
}
