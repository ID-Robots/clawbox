"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useCodingAgentActivity, type CodingAgentActivity, type TeamActivity } from "@/lib/use-coding-agent-activity";
import { useCodingRunAutoHide } from "@/lib/use-coding-run-auto-hide";
import { useDismissedCodingRuns } from "@/lib/use-dismissed-coding-runs";
import { dispatchOpenApp, dispatchOpenCodingRun, dispatchOpenCodingTeam, NEW_APP_EVENT } from "@/lib/ui-events";
import type { CodingRunStatus } from "@/lib/coding-agent-status";
import CodingAgentActivityPill, { type CodingAgentCardLabels } from "./CodingAgentActivityPill";
import CodingTeamActivityCard, { type CodingTeamCardLabels } from "./CodingTeamActivityCard";
import NewAppWizardCard, { DEFAULT_MAX_TASK_CHARS } from "./NewAppWizardCard";

/**
 * The chat's coding cards — ONE host for the mascot popup (ChatPopup) and the
 * full-page chat (ChatApp, `/app/clawbox`, what a phone lands on).
 *
 * Three cards of one family live in the transcript's main tab after the tool
 * pills: the Create card ("A new app for your desktop", NewAppWizardCard,
 * unchanged), one card per coding TEAM (CodingTeamActivityCard, new) and one
 * per coding run of its own (CodingAgentActivityPill) — teams before runs,
 * oldest first within each. The full-page chat had none of them until the
 * 2026-10-30 redesign; the popup kept its own copy of the wiring. This file
 * is that wiring once:
 *
 * - `useCodingChatCards(active)` — the one poller (use-coding-agent-activity:
 *   runs and teams on one beat, 5 s live / 30 s idle, visibility-gated,
 *   slim), the owner's put-away set (use-dismissed-coding-runs, the kv list,
 *   a team keyed `team:<id>` in the same list) and the auto-hide of a card
 *   whose work finished cleanly (use-coding-run-auto-hide, a `done` team
 *   counted like a `completed` run), with the 🤖 chip's count.
 * - `CodingChatCards` — the cards themselves, with Open handing the app a
 *   run id or a team id in a NORMAL window (never maximized;
 *   `chat-run-card-view.test.ts` pins the call) and × asking the host to
 *   put the card away.
 * - `useNewAppCard` / `NewAppToggleButton` / `NewAppCardSlot` — the
 *   composer's `+`, its gate (`coding-agent/status` says the wizard is not
 *   done → the Coding Agent app opens instead; `chat-new-app-gate.test.tsx`),
 *   the `NEW_APP_EVENT` hand-off from the app's own buttons and from the
 *   assistant's `ui_open_card`, and the card over the composer.
 *
 * `openFromChat(open)` is the chat's own: on a phone the chat gets out of
 * the way of the window it opens; on a desktop it stays.
 */

const NO_RUNS: CodingAgentActivity[] = [];
const NO_TEAMS: TeamActivity[] = [];

/** The dismissed-set key of a team's card, beside the runs' plain ids. */
export function teamCardKey(teamId: string): string {
  return `team:${teamId}`;
}

/** A team as the auto-hide clock reads it: `done` is the clean finish, like a run's `completed`. */
function teamAsRunState(team: TeamActivity): { id: string; status: CodingRunStatus } {
  const status: CodingRunStatus = team.status === "done" ? "completed"
    : team.status === "failed" ? "failed"
      : team.status === "stopped" ? "stopped"
        : "running";
  return { id: teamCardKey(team.id), status };
}

export interface CodingChatCardsState {
  /** Every run the poller holds (its own runs; members hide behind their team). */
  runs: CodingAgentActivity[];
  teams: TeamActivity[];
  nudge: () => void;
  /** Cards the owner put away with ×, by run id or `team:<id>`. */
  dismissed: ReadonlySet<string>;
  /** Put a card away for good, by run id or team key. */
  dismiss: (key: string) => void;
  /** Cards counting down to leaving on their own; keys as above. */
  finishing: ReadonlySet<string>;
  /** Cards that left on their own. */
  hidden: ReadonlySet<string>;
  /** Bring back every card that left on its own. */
  restore: () => void;
  /** What is on screen: not put away, not gone on its own. */
  shownRuns: CodingAgentActivity[];
  shownTeams: TeamActivity[];
  /** How many cards the 🤖 chip would bring back. */
  autoHiddenCount: number;
}

/**
 * The cards' state for one chat. `onAutoHide(key)` fires as a card's clock
 * runs out, while it is still in the document (ChatPopup moves the keyboard
 * focus off it).
 */
export function useCodingChatCards(active: boolean, onAutoHide?: (key: string) => void): CodingChatCardsState {
  const activity = useCodingAgentActivity(active);
  // A host test may stub the hook with the old `{ runs, nudge }` shape; the
  // fallbacks are module constants so the memos below see one identity.
  const runs = activity.runs ?? NO_RUNS;
  const teams = activity.teams ?? NO_TEAMS;
  const { dismissed, dismiss } = useDismissedCodingRuns(active);
  const outcomes = useMemo(() => [...teams.map(teamAsRunState), ...runs], [teams, runs]);
  // The auto-hide hook reads `onAutoHide` through its own ref, so a fresh
  // function each render restarts no clock.
  const { finishing, hidden, restore } = useCodingRunAutoHide(outcomes, onAutoHide);
  const shownRuns = useMemo(() => runs.filter((run) => !dismissed.has(run.id) && !hidden.has(run.id)), [runs, dismissed, hidden]);
  const shownTeams = useMemo(() => teams.filter((team) => !dismissed.has(teamCardKey(team.id)) && !hidden.has(teamCardKey(team.id))), [teams, dismissed, hidden]);
  const autoHiddenCount = runs.filter((run) => hidden.has(run.id) && !dismissed.has(run.id)).length
    + teams.filter((team) => hidden.has(teamCardKey(team.id)) && !dismissed.has(teamCardKey(team.id))).length;
  return { runs, teams, nudge: activity.nudge, dismissed, dismiss, finishing, hidden, restore, shownRuns, shownTeams, autoHiddenCount };
}

type T = ReturnType<typeof useT>["t"];

/** The run card's words, from the catalogue. */
export function runCardLabels(t: T): CodingAgentCardLabels {
  return {
    running: t("codingAgent.chatWorking"),
    runningOwner: t("codingAgent.chatWorkingOwner"),
    completed: t("codingAgent.chatFinished"),
    failed: t("codingAgent.chatFailed"),
    stopped: t("codingAgent.chatStopped"),
    paused: t("codingAgent.chatPaused"),
    draft: t("codingAgent.chatDraft"),
    // Waiting for a slot: the box runs as many at once as the owner allows.
    queued: t("codingAgent.chatQueued"),
    // A run that worked and did not leave the deliverable behind: its own
    // word, because "did not finish" would read as a fault and the one
    // thing that helps here is opening it and resuming.
    gave_up: t("codingAgent.chatGaveUp"),
    timeLeft: t("codingAgent.timeLeft"),
    // A template, not a sentence: the card fills in the count.
    agents: t("codingAgent.chatAgents"),
    tokensWord: t("codingAgent.tokensWord"),
    liveWork: t("codingAgent.chatLiveWork"),
    showDetails: t("codingAgent.showDetails"),
    hideDetails: t("codingAgent.hideDetails"),
    thinking: t("codingAgent.thinking"),
    filesTouched: t("codingAgent.chatFilesTouched"),
    turns: t("codingAgent.chatTurns"),
    plan: t("codingAgent.chatPlan"),
    done: t("codingAgent.chatDone"),
    now: t("codingAgent.chatNow"),
    more: t("codingAgent.chatMore"),
    busy: t("codingAgent.chatBusy"),
    dismiss: t("codingAgent.chatDismiss"),
    needsYou: t("codingAgent.chatNeedsYou"),
    files: t("codingAgent.chatFiles"),
    pr: t("codingAgent.chatPr"),
    // One word per kind of step the card can draw as a chip — the owner's
    // language for what the harness names by tool.
    steps: {
      screenshot: t("codingAgent.chatScreenshot"),
      lookingAtPage: t("codingAgent.chatLookingAtPage"),
      openingPage: t("codingAgent.chatOpeningPage"),
      drivingPage: t("codingAgent.chatDrivingPage"),
      closingPage: t("codingAgent.chatClosingPage"),
      write: t("codingAgent.chatWrite"),
      edit: t("codingAgent.chatEdit"),
      read: t("codingAgent.chatRead"),
      plan: t("codingAgent.chatPlan"),
    },
  };
}

/** The team card's words, from the catalogue. */
export function teamCardLabels(t: T): CodingTeamCardLabels {
  return {
    queued: t("codingAgent.chatTeam.queued"),
    planning: t("codingAgent.chatTeam.planning"),
    working: t("codingAgent.chatTeam.working"),
    reviewing: t("codingAgent.chatTeam.reviewing"),
    done: t("codingAgent.chatTeam.done"),
    failed: t("codingAgent.chatTeam.failed"),
    stopped: t("codingAgent.chatTeam.stopped"),
    tasks: t("codingAgent.chatTeam.tasks"),
    pr: t("codingAgent.chatPr"),
    agents: t("codingAgent.chatAgents"),
    tokensWord: t("codingAgent.tokensWord"),
    more: t("codingAgent.chatMore"),
    showDetails: t("codingAgent.showDetails"),
    hideDetails: t("codingAgent.hideDetails"),
    dismiss: t("codingAgent.chatDismiss"),
    reason: t("codingAgent.chatTeam.reason"),
    busy: t("codingAgent.chatBusy"),
    taskState: {
      pending: t("codingAgent.chatTeam.taskPending"),
      in_progress: t("codingAgent.chatTeam.taskWorking"),
      complete: t("codingAgent.chatTeam.taskDone"),
      accepted: t("codingAgent.chatTeam.taskAccepted"),
      rejected: t("codingAgent.chatTeam.taskRejected"),
      failed: t("codingAgent.chatTeam.taskFailed"),
    },
  };
}

/**
 * The cards, teams before runs. `onDismissRun` lets a host wrap the put-away
 * with its own focus management (ChatPopup moves the keyboard to the
 * neighbouring card); without it the card asks the state directly.
 */
export function CodingChatCards({ cards, openFromChat, onPreview, onDismissRun }: {
  cards: CodingChatCardsState;
  /** Open something outside the chat — and, on a phone, close the chat around it. */
  openFromChat: (open: () => void) => void;
  /** The chat's one full-size image preview, for a run's screenshots. */
  onPreview?: (src: string, alt: string) => void;
  onDismissRun?: (id: string) => void;
}) {
  const { t } = useT();
  const runLabels = useMemo(() => runCardLabels(t), [t]);
  const teamLabels = useMemo(() => teamCardLabels(t), [t]);
  const openLabel = t("codingAgent.liveView");
  return (
    <>
      {cards.shownTeams.map((team) => (
        <CodingTeamActivityCard
          key={teamCardKey(team.id)}
          team={team}
          labels={teamLabels}
          openLabel={openLabel}
          // Open: the Coding Agent app on the team's own page (CodingTeamPage;
          // the app takes the id from the hand-off slot or the event). A
          // normal window, like the run's.
          onOpen={() => openFromChat(() => dispatchOpenCodingTeam(team.id))}
          onDismiss={() => cards.dismiss(teamCardKey(team.id))}
          autoHiding={cards.finishing.has(teamCardKey(team.id))}
        />
      ))}
      {cards.shownRuns.map((run) => (
        <CodingAgentActivityPill
          key={run.id}
          run={run}
          labels={runLabels}
          // Open: the run's own page in the Coding Agent app — the live
          // terminal is embedded there while it runs. In a NORMAL window: the
          // button asked for a maximize once, which threw a window the owner
          // had sized and placed to full screen on every press.
          openLabel={openLabel}
          onOpen={() => openFromChat(() => dispatchOpenCodingRun(run.id))}
          onPreview={onPreview}
          onDismiss={() => (onDismissRun ?? cards.dismiss)(run.id)}
          autoHiding={cards.finishing.has(run.id)}
        />
      ))}
    </>
  );
}

// ── The Create card and its `+` ──────────────────────────────────────────────

export interface NewAppCardState {
  show: boolean;
  options: { project?: string; team?: boolean };
  maxChars: number | null;
  /** Open the card as asked, no questions — the app's own hand-off. */
  open: () => void;
  close: () => void;
  /** The `+`: gated on the Coding Agent's status. */
  toggle: () => void;
}

/**
 * The Create card's state: whether it is up, what the last opener asked it
 * to open on (a project, the team switch), the task ceiling read once from
 * `coding-agent/status`, and the `+` button's gate.
 *
 * The gate: the card composes a message that asks the assistant to DELEGATE
 * the build, and until the owner has been through the Coding Agent's wizard
 * (or while its switch is off) the delegation is refused — so the press used
 * to open a form whose only outcome was a refusal. It lands on the Coding
 * Agent app instead, in a plain window, where the wizard (or the switch) is
 * the first thing on screen. Asked on EVERY press, because the answer
 * changes in the other window. A status the box cannot read opens the card
 * — never a dead button — and so does one that predates the field, since
 * only an explicit `false` is a refusal. The app's own hand-off
 * (`NEW_APP_EVENT`, also what the assistant's `ui_open_card` becomes) is
 * NOT gated: that app already sits behind its wizard.
 */
export function useNewAppCard(openFromChat: (open: () => void) => void): NewAppCardState {
  const [show, setShow] = useState(false);
  const [options, setOptions] = useState<{ project?: string; team?: boolean }>({});
  const [maxChars, setMaxChars] = useState<number | null>(null);
  const readStatus = useCallback(async (): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch("/setup-api/coding-agent/status", { cache: "no-store" });
      if (!res.ok) return null;
      const data: unknown = await res.json();
      if (!data || typeof data !== "object") return null;
      const n = (data as { maxTaskChars?: unknown }).maxTaskChars;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) setMaxChars(n);
      return data as Record<string, unknown>;
    } catch {
      return null; // the card keeps the default ceiling
    }
  }, []);
  const open = useCallback(() => {
    // The fetch sits BESIDE the setter, not inside the updater: React may run
    // an updater more than once per call, and one click must cost one request.
    if (maxChars === null) void readStatus();
    setShow(true);
  }, [maxChars, readStatus]);
  // Closing forgets what the last opener asked for: the next `+` must open a
  // fresh card, not the previous project's team form.
  const close = useCallback(() => { setShow(false); setOptions({}); }, []);
  // A second press while the status is in flight costs no second request and
  // must not toggle the card back shut the moment the first press opens it.
  const gateRef = useRef(false);
  const toggle = useCallback(() => {
    if (show) { close(); return; }
    if (gateRef.current) return;
    gateRef.current = true;
    void readStatus().then((status) => {
      gateRef.current = false;
      if (status && (status.setupComplete === false || status.enabled === false)) {
        openFromChat(() => dispatchOpenApp("coding"));
        return;
      }
      setShow(true);
    });
  }, [show, close, readStatus, openFromChat]);
  useEffect(() => {
    const onNewApp = (e: Event) => {
      const detail = (e as CustomEvent<{ project?: unknown; team?: unknown } | undefined>).detail;
      setOptions({
        project: typeof detail?.project === "string" ? detail.project : undefined,
        team: detail?.team === true,
      });
      open();
    };
    window.addEventListener(NEW_APP_EVENT, onNewApp);
    return () => window.removeEventListener(NEW_APP_EVENT, onNewApp);
  }, [open]);
  return { show, options, maxChars, open, close, toggle };
}

/** The composer's `+`: the Create card's toggle, beside the attach and microphone buttons. */
export function NewAppToggleButton({ card }: { card: NewAppCardState }) {
  const { t } = useT();
  const on = card.show;
  return (
    <button
      type="button"
      onClick={card.toggle}
      title={t("codingAgent.createNewProject")}
      aria-label={t("codingAgent.createNewProject")}
      aria-pressed={on}
      data-testid="chat-new-app-toggle"
      style={{
        width: 36, height: 36, borderRadius: 10, border: "none",
        background: on ? "rgba(249,115,22,0.2)" : "rgba(255,255,255,0.06)",
        color: on ? "#f97316" : "rgba(255,255,255,0.4)",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, transition: "all 0.15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(249,115,22,0.15)"; e.currentTarget.style.color = "#f97316"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = on ? "rgba(249,115,22,0.2)" : "rgba(255,255,255,0.06)"; e.currentTarget.style.color = on ? "#f97316" : "rgba(255,255,255,0.4)"; }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 22 }}>add</span>
    </button>
  );
}

/**
 * The Create card over the composer, on the composer's own ground and
 * hairline so it reads as part of it, not as a dialog over the chat. Nothing
 * while the card is closed.
 */
export function NewAppCardSlot({ card }: { card: NewAppCardState }) {
  if (!card.show) return null;
  return (
    <div data-testid="chat-new-app" style={{ padding: "10px 14px 0", background: "rgba(0,0,0,0.2)", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
      <NewAppWizardCard
        key={`${card.options.project ?? ""}|${card.options.team ? "team" : ""}`}
        initialProject={card.options.project}
        initialTeam={card.options.team}
        maxTaskChars={card.maxChars ?? DEFAULT_MAX_TASK_CHARS}
        onClose={card.close}
        // In the chat it floats over the composer like a popover, so it
        // behaves like one: click away (or Escape) and it goes.
        closeOnOutsideClick
      />
    </div>
  );
}
