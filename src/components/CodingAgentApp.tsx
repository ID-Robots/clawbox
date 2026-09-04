"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { estimateRunProgress } from "@/lib/coding-agent-progress";
import { isLive, isSettled, type CodingRunStatus } from "@/lib/coding-agent-status";
import { isPrPending, type PrState } from "@/lib/coding-pr-state";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";
import CodingAgentReportPreview from "./CodingAgentReportPreview";
import CodingAgentSettingsPanel from "./CodingAgentSettingsPanel";
import CodingAgentResetCard from "./CodingAgentResetCard";
import HelpTip from "./HelpTip";
import InstalledAppIcon from "./InstalledAppIcon";
import CodingAgentSetupWizard from "./CodingAgentSetupWizard";
import { BTN_BASE, BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, CARD, SECTION_LABEL } from "./coding-agent-ui";
import { startHarnessTest } from "@/lib/coding-agent-harness-test";
import { openNewAppCard } from "@/lib/ui-events";
import RunProgressBar, { RUN_TONE } from "./RunProgressBar";
// The "3h ago" the rest of the desktop speaks — ClawKeep's helper and its
// keys, translated in every locale, rather than a second English-only one.
import { timeAgo } from "./clawkeep-ui";
import { formatBytes } from "@/lib/format-bytes";
import { renderText } from "@/lib/chat-markdown";
import { artifactUrl } from "@/lib/use-coding-agent-activity";
import {
  OPEN_CODING_RUN_EVENT,
  dispatchOpenApp,
  notifyCodingRunStarted,
  onCodingAgentChanged,
  onStandaloneAppPage,
  takePendingCodingRun,
} from "@/lib/ui-events";
import NewAppWizardCard, { DEFAULT_MAX_TASK_CHARS, NEW_APP_NAME_MAX } from "./NewAppWizardCard";
import TerminalApp from "./TerminalApp";
import { livePreviewCommand } from "@/lib/coding-run-preview";
import { copyToClipboard } from "@/lib/clipboard";
import type { AgentStatus, Effort, GitHubState } from "./CodingAgentSettingsPanel";

/**
 * The Coding Agent app — opened from the desktop icon of the same name.
 *
 * What a headless Claude Code run (src/lib/coding-agent.ts) needs and whether
 * it is there, a one-tap smoke test of that harness, and the recent runs with
 * their summaries and evidence.
 *
 * Above the runs, the owner's projects: every folder with a git history of
 * its own in their project folder, with what it is called, its last commit,
 * whether it is on the desktop and whether a run is working in it. The New
 * app wizard beside them does not start a run: it composes ONE message and
 * hands it to the mascot chat, because the assistant is the party that
 * scaffolds, delegates and verifies, and the owner continues there.
 *
 * The owner's switch, the project folder, the effort and the GitHub account
 * live in Settings → Coding Agent (CodingAgentSettingsPanel) now; the header
 * links there. The app still reads the same status route, because "is it on
 * and can it run" is the first thing this window has to answer, and the same
 * git route, because a run's Backup button only exists for a connected account.
 *
 * This icon used to open a terminal already running `claude-ds`. It opens this
 * instead, so the app and the thing it configures are finally the same thing.
 */

interface Run {
  id: string;
  task: string;
  directory: string;
  projectId: string | null;
  source: "agent" | "owner";
  status: CodingRunStatus;
  startedAt: number;
  completedAt: number | null;
  summary: string | null;
  error: string | null;
  numTurns: number;
  /** The run's plan, as it last wrote it with TodoWrite. */
  todos?: { content?: string; status?: string; activeForm?: string }[];
  filesTouched: string[];
  permissionDenials: number;
  /** What was refused, in the owner's words. */
  deniedActions?: string[];
  progress: string[];
  effort?: Effort;
  /** Sub-agents working right now; 0 once the run has settled. */
  subagentsActive?: number;
  subagentsTotal?: number;
  subagentsByType?: Record<string, number>;
  modelsUsed?: string[];
  lastActivityAt?: number;
  activeSubagents?: { type: string; description: string; startedAt: number }[];
  /** The commit this run's work was recorded as — what a backup would push. */
  commit?: string | null;
  thinkingTokens?: number;
  tokensUsed?: number;
  sessionId?: string | null;
  /** Where Claude Code keeps this run's transcript, for the live preview. */
  transcriptPath?: string | null;
  /** The run this one is the automatic review pass of, when it is one. */
  reviewOf?: string | null;
  /** The pull request this run's work went into, while the auto-PR switch is
   *  on. Optional: a run recorded before the feature has none. */
  pr?: PrState | null;
  /** The run's evidence folder — screenshots, test output and its report.md.
   *  `markdown` is the kind that opens rendered in the app; every other
   *  non-image opens as the plain text the route serves it as. */
  artifacts?: { name: string; bytes: number; kind: "image" | "audio" | "markdown" | "text" | "other" }[];
  /** Something this run started is still running now that it has settled —
   *  the server an app serves itself on, most often. Never true of a run
   *  that was stopped or failed: those have their group ended for them. */
  leftover?: boolean;
}

/**
 * The status payload as this app reads it: the shared wire type plus the
 * task ceiling, which only the New wizard needs — it is the bound the run
 * route will hold the assistant's task to, so the description is held to it
 * here, before the handoff.
 */
type AppStatus = AgentStatus & { maxTaskChars?: number };

/** One project, as GET /setup-api/coding-agent/projects describes it. */
interface Project {
  folder: string;
  directory: string;
  /** The owner's project folder, or a code project under data/code-projects. */
  kind: "folder" | "codeProject";
  name: string;
  lastCommit: { subject: string; date: number } | null;
  onDesktop: boolean;
  /** The project's own icon, once the box has drawn one; null while it has not. */
  iconUrl?: string | null;
  latestRun: Pick<Run, "id" | "status" | "task" | "startedAt" | "completedAt"> | null;
}

// The wizard's name bound lives with the wizard now (NewAppWizardCard); it is
// re-exported here so the test that pins it to the project library's
// MAX_PROJECT_NAME_LENGTH keeps one import to reach it by.
export { NEW_APP_NAME_MAX };

/**
 * The desktop's id for a deployed web app. page.tsx builds every installed
 * app's id as `installed-<appId>`, and a web app's appId is its folder under
 * data/webapps — the project folder. Exported so the test can pin the
 * spelling against the one the desktop matches on.
 */
export function installedAppId(folder: string): string {
  return `installed-${folder}`;
}

/** One page of runs. The list is open by default now, so it has to be paged
 *  rather than unbounded — a long history should not push the settings off
 *  the top of the window. */
const RUNS_PAGE = 10;
/** Where the preview script lives on the device. */
const CLAWBOX_ROOT = "/home/clawbox/clawbox";
const POLL_MS = 5_000;
/** How long a two-tap confirmation stays armed before the offer is taken back. */
const CONFIRM_MS = 5_000;

/** Elapsed time, readable at every scale a run can reach — seconds to days. */
function duration(run: Run): string {
  const total = Math.max(0, Math.round(((run.completedAt ?? Date.now()) - run.startedAt) / 1000));
  if (total < 60) return `${total}s`;
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${total % 60}s`;
}

/** Compact token counts: 1.3M reads better than 1,317,787 in a list row. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function firstLine(text: string, max = 100): string {
  const line = text.split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Single-quote a value for the terminal command line. */
function quoted(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}



/** The Settings link, whichever element it renders as. */
const OPEN_SETTINGS_CLASS = BTN_SECONDARY;
/** A sidebar entry: icon and label, the width of the rail, quiet until hovered or current. */
const SIDEBAR_ITEM = "w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-[var(--text-secondary)] hover:bg-white/[0.06] hover:text-[var(--text-primary)] text-left cursor-pointer transition-colors";
const SIDEBAR_ACTIVE = "bg-white/[0.08] text-[var(--text-primary)]";
/** How many runs the sidebar lists; the pages list them all. */
const SIDEBAR_RUNS = 12;
/** The window width (px) from which the sidebar is shown beside the page. */
const SIDEBAR_MIN_WIDTH = 860;

/** A run pointed at a code project by id belongs to that project and no
 *  other — its folder is under the checkout, so matching it by directory as
 *  well would also list it under the folder project that holds the checkout.
 *  A run with no id belongs to the project whose folder it worked in. */
function runBelongsTo(r: Run, pr: Project): boolean {
  if (r.projectId) return pr.kind === "codeProject" && r.projectId === pr.folder;
  return r.directory === pr.directory;
}

interface GitInfo {
  branch: string | null;
  commits: number;
  remote: string | null;
  lastCommit: { subject: string; date: number } | null;
}

/**
 * The open project's git block: branch, commits, origin. Fetched when the
 * page opens; origin is the "is this on GitHub yet" answer the store plan
 * needs, so the page shows it plainly. Keyed by folder so a stale fetch
 * never shows one project's remote on another's page — and no
 * reset-in-effect.
 *
 * Read again when the project's last commit changes — the projects poll
 * already surfaces a run's commit, so the block follows it for free — and
 * when `version` is bumped, which a successful backup does so the remote
 * line stops saying "not on GitHub yet" about a folder that just got there.
 * Never on every poll: each read is three git spawns, and on a Jetson each
 * spawn is felt.
 */
function useProjectGit(project: Project | null, version: number): GitInfo | null {
  const [git, setGit] = useState<{ dir: string; info: GitInfo } | null>(null);
  const dir = project?.directory ?? null;
  const query = !project
    ? null
    : project.kind === "codeProject"
      ? `projectId=${encodeURIComponent(project.folder)}`
      : `directory=${encodeURIComponent(project.directory)}`;
  const committedAt = project?.lastCommit?.date ?? null;
  useEffect(() => {
    if (!dir || !query) return;
    let gone = false;
    fetch(`/setup-api/coding-agent/git?${query}`, { cache: "no-store" })
      .then(async (res) => (res.ok ? res.json() : null))
      .then((data) => { if (!gone && data?.git) setGit({ dir, info: data.git }); })
      .catch(() => { /* the page simply shows no git block */ });
    return () => { gone = true; };
  }, [dir, query, committedAt, version]);
  return git && git.dir === dir ? git.info : null;
}

/**
 * A project's picture, in a box of the caller's choosing.
 *
 * The size has to come from here, not from InstalledAppIcon: that component
 * was written for the desktop's colour tiles, where the picture is meant to
 * bleed to the tile's edge, so its <img> is `w-full h-full` and its `size`
 * prop only ever sizes the fallback glyph. Handed to a flex row with no box
 * around it, the icon took the whole width of the project row and pushed the
 * name and the chips onto the next line.
 */
function ProjectIcon({ project, size }: { project: Project; size: "w-6 h-6" | "w-7 h-7" }) {
  if (!project.iconUrl) return null;
  return (
    <span className={`${size} shrink-0 rounded-md overflow-hidden flex items-center justify-center`}>
      <InstalledAppIcon appId={project.folder} iconUrl={project.iconUrl} name={project.name} size={size} />
    </span>
  );
}

/** One cell of the run page's figures grid. */
function StatTile({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-3 py-2 min-w-0" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] truncate">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-[var(--text-primary)] truncate" title={hint ?? value}>{value}</div>
      {hint && <div className="text-[10px] text-[var(--text-muted)] truncate">{hint}</div>}
    </div>
  );
}

/** How many of a run's progress lines the run page's activity log shows. */
const ACTIVITY_SHOWN = 40;

/** Every run button's shape; the action's own colour is added per row. */
const RUN_BUTTON = "text-xs px-2.5 py-1 rounded-lg border disabled:opacity-50";

/**
 * What a held run offers first, by status: pause it, resume it, start it.
 * A settled run offers nothing here. The route is also the button's test id
 * (`coding-agent-<route>-<runId>`) and the key of the message shown when it
 * is refused.
 */
const RUN_ACTION: Partial<Record<CodingRunStatus, { route: "pause" | "resume" | "start"; label: string; failed: string; className: string }>> = {
  running: { route: "pause", label: "codingAgent.pause", failed: "codingAgent.pauseFailed", className: "border-white/10 text-[var(--text-primary)] hover:bg-white/5" },
  paused: { route: "resume", label: "codingAgent.resume", failed: "codingAgent.resumeFailed", className: "border-sky-300/40 text-sky-300 hover:bg-sky-300/10" },
  draft: { route: "start", label: "codingAgent.startDraft", failed: "codingAgent.startFailed", className: "border-violet-300/40 text-violet-300 hover:bg-violet-300/10" },
};

export default function CodingAgentApp() {
  const { t } = useT();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The run whose own page is open — a page now, not a row that unfolds. */
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  /** The markdown artifact open in the preview dialog, if any. */
  const [report, setReport] = useState<{ runId: string; name: string } | null>(null);
  // Runs are behind a button: the answer to "is this on and does it work" is
  // the whole point of opening this window, and a list of past runs pushed it
  // below the fold.
  // Open by default: the history is the reason the window gets opened once
  // the switch is already on.
  const [showRuns, setShowRuns] = useState(true);
  const [runsShown, setRunsShown] = useState(RUNS_PAGE);
  const [github, setGithub] = useState<GitHubState | null>(null);
  // Decided once: the route does not change under a mounted window. The
  // Settings link renders differently on the standalone page (below), and
  // the New app wizard is not offered there at all: it ends in the mascot
  // chat, which that page does not mount, so a message dispatched from it
  // would reach nothing while the card said "handed to the assistant".
  const [standalone] = useState(onStandaloneAppPage);
  const [projects, setProjects] = useState<Project[]>([]);
  /** The project folder the list was read from; null until one is set. */
  const [projectsDir, setProjectsDir] = useState<string | null>(null);
  /** Which folder name was just copied, for the two-second "Copied". */
  const [copiedFolder, setCopiedFolder] = useState<string | null>(null);
  // The New app wizard: an inline card, closed by Cancel, by Create, and
  // never by a poll. `handed` is the line left behind once the message is
  // in the chat — the card is gone by then, and the chat is where to look.
  // Clearing is two taps, not a browser confirm(): the second tap is the
  // confirmation. The offer is taken back on its own after CONFIRM_MS, and
  // whenever the settings page is left or entered — an armed red button
  // found minutes later is a mis-tap waiting to happen. A timer rather than
  // blur alone: iOS Safari does not focus a button on tap, so on the phone
  // this app is made for a blur would never come.
  const [confirmClear, setConfirmClear] = useState(false);
  const confirmClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmClear = () => {
    if (confirmClearTimer.current) clearTimeout(confirmClearTimer.current);
    confirmClearTimer.current = null;
    setConfirmClear(false);
  };
  const armClear = () => {
    if (confirmClearTimer.current) clearTimeout(confirmClearTimer.current);
    confirmClearTimer.current = setTimeout(() => {
      confirmClearTimer.current = null;
      setConfirmClear(false);
    }, CONFIRM_MS);
    setConfirmClear(true);
  };
  useEffect(() => () => { if (confirmClearTimer.current) clearTimeout(confirmClearTimer.current); }, []);
  // Which face the window shows — see `view` below. The settings page sits
  // over whichever project was open, so Back returns there.
  const [page, setPage] = useState<"home" | "settings">("home");
  const [openProjectDir, setOpenProjectDir] = useState<string | null>(null);
  /** Bumped when this window changed the open project's git state itself
   *  (a backup), so the git block re-reads without a new commit. */
  const [gitVersion, setGitVersion] = useState(0);

  // `load` must not re-run because a translation function was re-created: a
  // refetch on every render would restart the live poll and overwrite the
  // run list mid-read. Read `t` through a ref instead, synchronised after
  // commit so a discarded render never leaks into it.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const load = useCallback(async () => {
    try {
      const [s, r, g, p] = await Promise.all([
        fetch("/setup-api/coding-agent/status", { cache: "no-store" }),
        fetch(`/setup-api/coding-agent/runs?limit=30&artifacts=1`, { cache: "no-store" }),
        fetch("/setup-api/coding-agent/git", { cache: "no-store" }),
        // Read on the same cadence as the runs, and no faster: each project
        // costs the device a `git log` per poll.
        fetch("/setup-api/coding-agent/projects", { cache: "no-store" }),
      ]);
      if (!s.ok) throw new Error("status");
      setStatus(await s.json() as AppStatus);
      if (r.ok) {
        const data = await r.json() as { runs?: Run[] };
        setRuns(Array.isArray(data.runs) ? data.runs : []);
      }
      if (g.ok) setGithub(await g.json() as GitHubState);
      if (p.ok) {
        const data = await p.json() as { directory?: string | null; projects?: Project[] };
        setProjects(Array.isArray(data.projects) ? data.projects : []);
        setProjectsDir(typeof data.directory === "string" ? data.directory : null);
      }
    } catch {
      setError(tRef.current("codingAgent.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The settings live in another window now. Re-read the box when Settings
  // says it saved something — the chip, the checklist and a run's Backup
  // button all follow the switch and the GitHub account — and when this tab
  // comes back into view, which is how a phone returns from /app/settings.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    const off = onCodingAgentChanged(() => { void load(); });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  /** Just the GitHub half of `load()`, for the moment a backup is refused:
   *  a 503 usually means the probe would answer differently now, and
   *  re-running the whole load would overwrite the run list for no reason. */
  const loadGithub = useCallback(async () => {
    try {
      const g = await fetch("/setup-api/coding-agent/git", { cache: "no-store" });
      if (g.ok) setGithub(await g.json() as GitHubState);
    } catch {
      // A failed re-probe is not new information. Leave the buttons alone.
    }
  }, []);

  // A running run changes every few seconds; nothing else here does. One
  // more read after the last live run settles: the runner writes the settled
  // record BEFORE it commits the work and starts the automatic review pass,
  // so the poll that saw the finish saw a folder with no new commit and no
  // follow-up run — and would otherwise have been the last.
  // Live OR waiting on GitHub Actions. The CI wait begins exactly when the run
  // stops being live, so a gate on isLive alone would stop polling at the
  // moment the checks chip starts changing — it would freeze at whatever the
  // last poll happened to see, clock included.
  const anyRunning = runs.some((r) => isLive(r.status) || isPrPending(r.pr));
  // Only a LIVE run moves a progress bar or occupies the harness; a PR waiting
  // on Actions does neither, so the clock and the harness gate read this one —
  // a CI wait can last many minutes, and a re-render a second for nothing is
  // the kind of idle CPU work this box cannot spare.
  const anyLive = runs.some((r) => isLive(r.status));
  const sawRunning = useRef(false);
  useEffect(() => {
    if (anyRunning) {
      sawRunning.current = true;
      const id = setInterval(() => { void load(); }, POLL_MS);
      return () => clearInterval(id);
    }
    if (!sawRunning.current) return;
    sawRunning.current = false;
    const id = setTimeout(() => { void load(); }, POLL_MS);
    return () => clearTimeout(id);
  }, [anyRunning, load]);
  // The clock the progress estimate reads. Held in state, ticking once a
  // second while a run is live (as the activity pill does), so the bar
  // moves between polls and render stays pure — a Date.now() in render
  // would freeze the bar for five seconds at a time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyLive]);

  const readError = async (res: Response, fallback: string) => {
    try {
      const data = await res.json() as { error?: string };
      return typeof data.error === "string" && data.error ? data.error : fallback;
    } catch {
      return fallback;
    }
  };

  /**
   * Open the run in the Terminal app.
   *
   * A run that is still working gets a live, readable tail of its transcript —
   * the file grows while it works. A finished one gets `claude-ds --resume`,
   * which drops the owner into that exact session to carry on by hand.
   *
   * Nothing at all for a run that can do neither: the button is not offered
   * unless there is a session to resume or a live transcript to tail (a run
   * paused or failed before Claude Code announced a session has nothing to
   * resume, and the runner refuses to resume it too), so a bare `cd` into
   * the folder is not a thing this can open any more.
   */
  const openInTerminal = (run: Run) => {
    // The one builder of that command (src/lib/coding-run-preview.ts), so the
    // quoting is the same here and on the run page's embedded terminal.
    const command = livePreviewCommand({
      transcriptPath: run.transcriptPath ?? null,
      sessionId: run.sessionId ?? null,
      directory: run.directory,
      live: run.status === "running",
    });
    if (!command) return;
    window.dispatchEvent(new CustomEvent("clawbox:open-terminal", { detail: { command } }));
  };

  /**
   * One tap of "is the harness healthy?": dispatch the canned smoke task into
   * its scratch project through the same routes a real delegation uses, then
   * open the live terminal view on it the moment its transcript exists. The
   * result lands in Recent runs — evidence folder, summary and all.
   */
  const testHarness = async () => {
    setBusy("harness-test");
    setError(null);
    try {
      // Scaffold the scratch project; an "already exists" answer is fine and
      // the run below is where a real failure would surface.
      // In the owner's own project folder, not a ClawBox-internal one — see
      // startHarnessTest.
      const started = await startHarnessTest(status?.defaultDirectory ?? null, t);
      if (!started.ok) throw new Error(started.error);
      setShowRuns(true);
      // The live view opens on the run as soon as its transcript exists.
      pendingLiveOpen.current = started.runId;
      // The chat's run card only probes when told: an open chat would
      // otherwise miss a run started from here.
      notifyCodingRunStarted();
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.harnessTestFailed"));
    } finally {
      setBusy(null);
    }
  };

  /** Open the live view once the run's transcript exists — the session id
   *  lands a few seconds after spawn, and the poll above (`load` every
   *  POLL_MS while a run is live) is already watching for it. A run that
   *  settles before its transcript appears just skips the popup; it is in
   *  the list either way. */
  const pendingLiveOpen = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingLiveOpen.current;
    if (!id) return;
    const run = runs.find((r) => r.id === id);
    if (!run) return;
    if (run.transcriptPath || run.status !== "running") {
      pendingLiveOpen.current = null;
      if (run.transcriptPath && run.status === "running") openInTerminal(run);
    }
  }, [runs]);

  /**
   * A run handed to this window from outside — the desktop's finish card, the
   * chat's run card — opens on its own page. Two handoffs, like Settings'
   * section: the window property survives a cold open (this effect mounts
   * after the card fired), the event reaches a window already up.
   */
  useEffect(() => {
    const pending = takePendingCodingRun();
    // A handoff parked on `window` before this window existed; the effect is
    // the one place it can be read, and reading it is one render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (pending) { setOpenRunId(pending); setPage("home"); }
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ runId?: unknown }>).detail?.runId;
      if (typeof id === "string" && id) {
        // The dispatcher also parks the id on `window` for a cold open; this
        // window is up, so take it back rather than leave it for a later mount.
        takePendingCodingRun();
        setOpenRunId(id);
        setPage("home");
      }
    };
    window.addEventListener(OPEN_CODING_RUN_EVENT, handler);
    return () => window.removeEventListener(OPEN_CODING_RUN_EVENT, handler);
  }, []);

  /** Push a run's folder to GitHub, private, creating the repo if needed. */
  const backup = async (target: { projectId: string | null; directory: string }, key: string) => {
    setBusy(`backup-${key}`);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target.projectId ? { projectId: target.projectId } : { directory: target.directory }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.backupFailed")));
      const out = await res.json() as { repo?: string; created?: boolean };
      setError(null);
      window.dispatchEvent(new CustomEvent("clawbox:toast", {
        detail: { message: t("codingAgent.backupDone", { repo: out.repo ?? "GitHub" }) },
      }));
      // The project page's git block has a remote now; a push changes no
      // commit, so nothing else would make it look again.
      setGitVersion((v) => v + 1);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.backupFailed"));
      // A refused backup is the other moment the card's GitHub row can be
      // stale — a 503 usually means the probe would answer differently now.
      void loadGithub();
    } finally {
      setBusy(null);
    }
  };

  const clearRuns = async () => {
    setBusy("clear");
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/runs", { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.clearFailed")));
      setOpenRunId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.clearFailed"));
    } finally {
      setBusy(null);
    }
  };

  /**
   * One of the run lifecycle routes, then reload the list. A POST carries
   * the run id in its body — pause, resume, start and stop all take that
   * shape; the draft's DELETE names the run in the query instead, as the
   * route reads it.
   */
  const runAction = async (
    id: string,
    action: "pause" | "resume" | "start" | "stop" | "draft" | "kill",
    failText: string,
    opts: { method?: "POST" | "DELETE" } = {},
  ) => {
    setBusy(id);
    setError(null);
    try {
      const res = opts.method === "DELETE"
        ? await fetch(`/setup-api/coding-agent/${action}?runId=${encodeURIComponent(id)}`, { method: "DELETE" })
        : await fetch(`/setup-api/coding-agent/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: id }),
        });
      if (!res.ok) throw new Error(await readError(res, failText));
      // A run is on its way; the chat's run card only probes when told.
      if (action === "start" || action === "resume") notifyCodingRunStarted();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : failText);
    } finally {
      setBusy(null);
    }
  };

  const copyFolder = async (folder: string) => {
    if (!(await copyToClipboard(folder))) return;
    setCopiedFolder(folder);
    setTimeout(() => setCopiedFolder((f) => (f === folder ? null : f)), 2_000);
  };

  /**
   * Hand "Create app" to the mascot chat.
   *
   * The same form used to live here as well, so two windows asked for a new
   * app and only one of them could show what the assistant said back — the
   * card composes ONE message and hands it to the conversation, and the reply
   * lands there. This opens the chat with the card in it instead.
   */
  const openNew = () => openNewAppCard();

  // The sidebar is MEASURED in rather than hidden by CSS: a rail that is in
  // the DOM but display:none still duplicates every project and run name the
  // page shows, for a screen reader and for a test alike. Wide means the
  // window can spare 15 rem for it beside a readable page.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? el.clientWidth;
        setWide(width >= SIDEBAR_MIN_WIDTH);
      });
      ro.observe(el);
    } catch {
      // A stubbed observer with no observe(): the page stays a column.
    }
    return () => { try { ro?.disconnect(); } catch { /* same stub */ } };
    // Re-attached once the real panel renders: the first mount is the
    // loading placeholder, which has no root to measure.
  }, [loading]);

  const openProject = useMemo(
    () => (openProjectDir ? projects.find((pr) => pr.directory === openProjectDir) ?? null : null),
    [projects, openProjectDir],
  );
  const git = useProjectGit(openProject, gitVersion);
  /** The run whose page is open, once the list has it. A run that was cleared
   *  meanwhile simply has no page — the window falls back to where it was. */
  const openRun = useMemo(
    () => (openRunId ? runs.find((r) => r.id === openRunId) ?? null : null),
    [runs, openRunId],
  );
  /** The open project's own runs. Home lists no runs of its own any more:
   *  every run works in a folder inside the project folder, and the projects
   *  route lists that folder, so a run always has a project page to live on
   *  (the sidebar's recent runs reach every run). */
  const visibleRuns = useMemo(() => (
    openProject ? runs.filter((r) => runBelongsTo(r, openProject)) : []
  ), [runs, openProject]);
  /**
   * Which face the window shows. Three, exclusive: the settings page sits
   * over whichever project was open, and the project face carries its
   * project so the markup below never re-finds it.
   */
  const view = page === "settings"
    ? { face: "settings" as const }
    // Before anything else on this window: a box whose owner has not been
    // through setup has no folder for a run to work in and no consent for one
    // to start, so the home page would be a list of things that cannot happen.
    // Settings still wins over it — that is the way back out.
    : status && !status.setupComplete
      ? { face: "wizard" as const }
      : openRun
        ? { face: "run" as const, run: openRun }
        : openProject
          ? { face: "project" as const, project: openProject }
          : { face: "home" as const };

  // A window, not a card: keep the app's own background on screen while the
  // first fetch lands, rather than flashing whatever is behind it.
  if (loading) return <div className="h-full bg-[var(--bg-deep)]" data-testid="coding-agent-panel" />;

  const readiness = status?.readiness;
  // Only what is missing is ever listed, so a check carries only the words
  // for that.
  const checks: { label: string; ok: boolean; badText: string }[] = readiness
    ? [
      { label: t("codingAgent.claudeCode"), ok: readiness.claudeInstalled, badText: t("codingAgent.missing") },
      { label: t("codingAgent.wrapper"), ok: readiness.wrapperInstalled, badText: t("codingAgent.missing") },
      { label: t("codingAgent.clawai"), ok: readiness.clawaiConnected, badText: t("codingAgent.notConnected") },
    ]
    : [];

  const statusLabel = (s: Run["status"]) => t(`codingAgent.status${s.charAt(0).toUpperCase()}${s.slice(1)}`);

  /** Open a run's page — from its row, a review chip, or the desktop. */
  const showRun = (id: string) => {
    setOpenRunId(id);
    setPage("home");
  };

  /** A chip naming another run: a button when that run is on the box, plain
   *  text when it was cleared. */
  const runChip = (id: string, label: string, testId: string) => {
    const className = "text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-violet-300 border-violet-400/40";
    return runs.some((r) => r.id === id)
      ? <button type="button" onClick={() => showRun(id)} data-testid={testId} className={`${className} hover:bg-violet-400/10`}>{label}</button>
      : <span data-testid={testId} className={className}>{label}</span>;
  };

  /** The pull request as one chip: its phase, and while checks run, how many
   *  have answered. A link once GitHub has given us one. */
  const prChip = (run: Run) => run.pr && run.pr.phase !== "failed" ? (
    <a
      href={run.pr.url ?? undefined}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      data-testid={`coding-agent-pr-${run.id}`}
      title={run.pr.detail ?? undefined}
      className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 no-underline inline-flex items-center gap-1 ${
        run.pr.phase === "merged"
          ? "text-emerald-400 border-emerald-400/40"
          : run.pr.phase === "blocked"
            ? "text-amber-400 border-amber-400/40"
            : "text-sky-300 border-sky-400/40"
      } ${run.pr.url ? "hover:bg-white/5" : "pointer-events-none"}`}
    >
      {run.pr.phase === "waiting" && (
        <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-sky-300 motion-safe:animate-pulse" />
      )}
      {run.pr.phase === "waiting"
        ? t("codingAgent.prWaiting", { done: run.pr.checks.passed + run.pr.checks.failed, total: run.pr.checks.total })
        : run.pr.phase === "merged"
          ? t("codingAgent.prMerged")
          : run.pr.phase === "blocked"
            ? t("codingAgent.prBlocked")
            : t("codingAgent.prOpening")}
    </a>
  ) : null;

  /** The row's and the page's run controls: the held run's first action and
   *  the way out of it, the terminal, the backup. */
  const runControls = (run: Run, where: "row" | "page") => {
    const action = RUN_ACTION[run.status];
    const canOpenTerminal = Boolean(run.sessionId || (run.status === "running" && run.transcriptPath));
    const terminalLabel = run.status === "running" ? t("codingAgent.openLive") : t("codingAgent.openResume");
    const small = where === "row" && action;
    const secondary = small ? `${RUN_BUTTON} border-white/10 text-[var(--text-primary)] hover:bg-white/5` : BTN_SECONDARY;
    return (
      <>
        {action && (
          <button
            type="button"
            onClick={() => runAction(run.id, action.route, t(action.failed))}
            disabled={busy === run.id}
            data-testid={`coding-agent-${action.route}-${run.id}`}
            className={small ? `${RUN_BUTTON} ${action.className}` : `${BTN_BASE} border ${action.className}`}
          >
            {t(action.label)}
          </button>
        )}
        {action && (run.status === "draft" ? (
          <button
            type="button"
            onClick={() => runAction(run.id, "draft", t("codingAgent.discardFailed"), { method: "DELETE" })}
            disabled={busy === run.id}
            data-testid={`coding-agent-discard-${run.id}`}
            className={small ? `${RUN_BUTTON} border-white/10 text-[var(--text-muted)] hover:bg-white/5` : BTN_SECONDARY}
          >
            {t("codingAgent.discardDraft")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => runAction(run.id, "stop", t("codingAgent.stopFailed"))}
            disabled={busy === run.id}
            data-testid={`coding-agent-stop-${run.id}`}
            className={secondary}
          >
            {t("codingAgent.stop")}
          </button>
        ))}
        {canOpenTerminal && (
          <button
            type="button"
            onClick={() => openInTerminal(run)}
            data-testid={`coding-agent-terminal-${run.id}`}
            title={terminalLabel}
            className={secondary}
          >
            {terminalLabel}
          </button>
        )}
        {github?.connected && run.commit && (
          <button
            type="button"
            onClick={() => void backup({ projectId: run.projectId, directory: run.directory }, run.id)}
            disabled={busy === `backup-${run.id}`}
            data-testid={`coding-agent-backup-${run.id}`}
            className={BTN_SECONDARY}
          >
            {busy === `backup-${run.id}` ? t("codingAgent.backupBusy") : t("codingAgent.backup")}
          </button>
        )}
      </>
    );
  };


  /**
   * The runs a face lists, as one section: the toggle, the paged rows, the
   * More button. On a project's page they are its own; on home, the ones
   * filed under no project — those used to be computed and never drawn, so a
   * run in a folder the projects list does not know was invisible.
   */
  const runsSection = (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => { setShowRuns((v) => !v); setRunsShown(RUNS_PAGE); }}
        aria-expanded={showRuns}
        data-testid="coding-agent-runs-toggle"
        className="w-full flex items-center justify-between gap-2 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-white/[0.06] transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }} aria-hidden="true">history</span>
          {t("codingAgent.projectRuns")}
          {visibleRuns.length > 0 && <span className="text-[var(--text-muted)]">({visibleRuns.length})</span>}
          {anyRunning && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 border border-amber-400/40 rounded-full px-2 py-0.5">
              {t("codingAgent.statusRunning")}
            </span>
          )}
        </span>
        <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">
          {showRuns ? "expand_less" : "expand_more"}
        </span>
      </button>

      {showRuns && (
        visibleRuns.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] mt-2 px-1">{t("codingAgent.noRuns")}</p>
        ) : (
          <ul className="space-y-1.5 mt-2" data-testid="coding-agent-runs">
            {visibleRuns.slice(0, runsShown).map((run) => {
              const tone = RUN_TONE[run.status];
              // A draft has not run: its startedAt is when it was drafted
              // (the runner overwrites it at start), so a duration would be
              // time-since-drafting, which the "updated" line already says —
              // and the effort it will run with is read at start.
              const started = run.status !== "draft";
              const reviewedBy = runs.find((r) => r.reviewOf === run.id);
              return (
                <li key={run.id} data-run-id={run.id} className="rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${tone.chip}`}>
                          {statusLabel(run.status)}
                        </span>
                        {/* A run at high effort can be silent for minutes on
                            its first turn. Show that it is thinking, so quiet
                            never reads as stuck. */}
                        {run.status === "running" && (run.thinkingTokens ?? 0) > 0 && (
                          <span
                            data-testid="coding-agent-thinking"
                            className="text-[10px] font-semibold border rounded-full px-2 py-0.5 text-violet-300 border-violet-400/40"
                          >
                            {t("codingAgent.thinking", { n: run.thinkingTokens ?? 0 })}
                          </span>
                        )}
                        {/* One green dot per sub-agent, so the fan-out is
                            visible at a glance. Filled while working, hollow
                            once done. */}
                        {(run.subagentsTotal ?? 0) > 0 && (
                          <span
                            className="flex items-center gap-1"
                            data-testid="coding-agent-subagent-dots"
                            title={Object.entries(run.subagentsByType ?? {}).map(([k, n]) => `${n}× ${k}`).join(", ")}
                          >
                            {Array.from({ length: Math.min(run.subagentsTotal ?? 0, 12) }).map((_, i) => (
                              <span
                                key={i}
                                className={`inline-block h-2 w-2 rounded-full ${
                                  i < (run.subagentsActive ?? 0) ? "bg-emerald-400 animate-pulse" : "bg-emerald-400/35"
                                }`}
                              />
                            ))}
                            <span className="text-[10px] font-semibold text-emerald-400 ml-0.5">{run.subagentsTotal}</span>
                          </span>
                        )}
                        {prChip(run)}
                        {/* A review pass names the run it reviewed, and that
                            run names its reviewer. */}
                        {run.reviewOf && runChip(run.reviewOf, t("codingAgent.reviewOf", { id: run.reviewOf }), "coding-agent-review-of")}
                        {reviewedBy && runChip(reviewedBy.id, t("codingAgent.reviewedBy", { id: reviewedBy.id }), "coding-agent-reviewed-by")}
                        {run.projectId && <span className="text-[11px] text-[var(--text-muted)]">{run.projectId}</span>}
                        <span className="text-[11px] font-mono text-[var(--text-muted)] opacity-60">{run.id}</span>
                      </div>
                      <p className="text-xs text-[var(--text-primary)] mt-1 break-words">
                        {run.reviewOf ? t("codingAgent.reviewPassTitle", { id: run.reviewOf }) : firstLine(run.task, 80)}
                      </p>
                      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                        {started && t("codingAgent.runMeta", { turns: run.numTurns, files: run.filesTouched.length, duration: duration(run) })}
                        {started && " · "}
                        {run.source === "owner" ? t("codingAgent.startedByOwner") : t("codingAgent.startedByAgent")}
                        {started && run.effort && ` · ${t(`codingAgent.effort.${run.effort}`)}`}
                        {(run.tokensUsed ?? 0) > 0 && ` · ${tokens(run.tokensUsed ?? 0)} ${t("codingAgent.tokensWord")}`}
                        {(run.subagentsTotal ?? 0) > 0
                          && ` · ${Object.entries(run.subagentsByType ?? {}).map(([k, n]) => `${n}× ${k}`).join(", ")}`}
                        {run.permissionDenials > 0 && (
                          <span className="text-amber-400"> · {t("codingAgent.denials", { n: run.permissionDenials })}</span>
                        )}
                      </p>
                      {isLive(run.status) && (
                        <RunProgressBar
                          estimate={estimateRunProgress(run, now)}
                          color={tone.color}
                          timeLeft={t("codingAgent.timeLeft")}
                          testId={`coding-agent-progress-${run.id}`}
                          className="mt-1"
                        />
                      )}
                      {/* Which models did the work, and how fresh this is. */}
                      {((run.modelsUsed?.length ?? 0) > 0 || run.lastActivityAt) && (
                        <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-0.5" data-testid="coding-agent-run-stats">
                          {(run.modelsUsed?.length ?? 0) > 0 && run.modelsUsed?.join(" + ")}
                          {(run.modelsUsed?.length ?? 0) > 0 && run.lastActivityAt ? " · " : ""}
                          {run.lastActivityAt && `${t("codingAgent.updated")} ${timeAgo(run.lastActivityAt, t)}`}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {RUN_ACTION[run.status] ? (
                        <div className="flex gap-1">{runControls(run, "row")}</div>
                      ) : (
                        runControls(run, "row")
                      )}
                      {/* The run's own page: its figures, its summary, its
                          evidence. A row used to unfold in place instead. */}
                      <button
                        type="button"
                        onClick={() => showRun(run.id)}
                        data-testid={`coding-agent-details-${run.id}`}
                        className="text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 inline-flex items-center gap-1"
                      >
                        {t("codingAgent.showDetails")}
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">chevron_right</span>
                      </button>
                    </div>
                  </div>
                  {/* Which helpers are out and what each is doing — a count
                      alone does not say whether the run is stuck on one
                      search or fanned across three files. */}
                  {(run.activeSubagents?.length ?? 0) > 0 && (
                    <ul className="mt-2 space-y-1" data-testid="coding-agent-active-subagents">
                      {run.activeSubagents?.map((a, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px]">
                          <span className="material-symbols-rounded text-sky-400 animate-pulse shrink-0" style={{ fontSize: 13 }} aria-hidden="true">sync</span>
                          <span className="text-sky-300 font-medium shrink-0">{a.type}</span>
                          <span className="text-[var(--text-muted)] break-words min-w-0">{a.description}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )
      )}
      {showRuns && visibleRuns.length > runsShown && (
        <button
          type="button"
          onClick={() => setRunsShown((n) => n + RUNS_PAGE)}
          data-testid="coding-agent-runs-more"
          className={`${BTN_SECONDARY} w-full mt-2`}
        >
          {t("codingAgent.more")} ({visibleRuns.length - runsShown})
        </button>
      )}
    </div>
  );

  return (
    // @container so the panel sizes to its WINDOW, not the viewport — this is
    // a desktop window the owner can resize independently of the screen.
    <div ref={rootRef} className="h-full flex bg-[var(--bg-deep)] text-white @container" data-testid="coding-agent-panel" data-help-bounds>
      {/* The sidebar — the Claude Code web layout's left rail: New, Home,
          Settings, the projects, the recent runs. Only when the window is
          wide enough to spare it (the phone and a small window keep the
          lists on the pages themselves), and not while the wizard runs. */}
      {wide && view.face !== "wizard" && (
        <aside className="flex w-[15rem] shrink-0 flex-col border-r border-white/[0.06] bg-black/[0.18] overflow-y-auto" data-testid="coding-agent-sidebar">
          <div className="px-3 pt-4 pb-2 space-y-1">
            {!standalone && (
              <button type="button" onClick={openNew} data-testid="coding-agent-sidebar-new" className={`${SIDEBAR_ITEM} text-[var(--text-primary)]`}>
                <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">add_circle</span>
                {t("codingAgent.createNewProject")}
              </button>
            )}
            <button
              type="button"
              onClick={() => { disarmClear(); setOpenRunId(null); setOpenProjectDir(null); setPage("home"); }}
              aria-current={view.face === "home" ? "page" : undefined}
              data-testid="coding-agent-sidebar-home"
              className={`${SIDEBAR_ITEM} ${view.face === "home" ? SIDEBAR_ACTIVE : ""}`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">home</span>
              {t("codingAgent.navHome")}
            </button>
            <button
              type="button"
              onClick={() => { disarmClear(); setPage("settings"); }}
              aria-current={view.face === "settings" ? "page" : undefined}
              data-testid="coding-agent-sidebar-settings"
              className={`${SIDEBAR_ITEM} ${view.face === "settings" ? SIDEBAR_ACTIVE : ""}`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">settings</span>
              {t("codingAgent.openSettings")}
            </button>
          </div>
          {projects.length > 0 && (
            <div className="px-3 pt-3 pb-1">
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("codingAgent.projectsTitle")}</p>
              <ul className="space-y-0.5" data-testid="coding-agent-sidebar-projects">
                {projects.map((project) => {
                  const active = view.face === "project" && view.project.directory === project.directory;
                  return (
                    <li key={project.directory}>
                      <button
                        type="button"
                        onClick={() => { disarmClear(); setPage("home"); setOpenRunId(null); setOpenProjectDir(project.directory); }}
                        aria-current={active ? "page" : undefined}
                        className={`${SIDEBAR_ITEM} ${active ? SIDEBAR_ACTIVE : ""}`}
                        title={project.directory}
                      >
                        <span className="material-symbols-rounded shrink-0" style={{ fontSize: 16 }} aria-hidden="true">{project.kind === "codeProject" ? "web" : "folder"}</span>
                        <span className="truncate">{project.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {runs.length > 0 && (
            <div className="px-3 pt-3 pb-4">
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">{t("codingAgent.recentRuns")}</p>
              <ul className="space-y-0.5" data-testid="coding-agent-sidebar-runs">
                {runs.slice(0, SIDEBAR_RUNS).map((run) => {
                  const active = view.face === "run" && view.run.id === run.id;
                  const tone = RUN_TONE[run.status];
                  return (
                    <li key={run.id}>
                      <button
                        type="button"
                        onClick={() => showRun(run.id)}
                        aria-current={active ? "page" : undefined}
                        className={`${SIDEBAR_ITEM} ${active ? SIDEBAR_ACTIVE : ""}`}
                        title={firstLine(run.task, 160)}
                      >
                        <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${isLive(run.status) ? "animate-pulse" : ""}`} style={{ background: tone.color }} />
                        <span className="truncate">{run.reviewOf ? t("codingAgent.reviewPassTitle", { id: run.reviewOf }) : firstLine(run.task, 60)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </aside>
      )}
      {/* The content column scrolls on its own beside the sidebar. */}
      <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
      {/* flex-1 so a face can ask for the remaining height — the wizard's
          intro centres itself in it. min-h-0 keeps the scroll on the parent. */}
      {/* A run's page is data — figures, files, a summary, an activity log —
          and reads better wide; the home and project pages stay a column. */}
      <div className={`mx-auto w-full ${view.face === "run" ? "max-w-6xl" : "max-w-2xl"} px-5 py-4 flex-1 flex flex-col min-h-0`}>

        {/* One row: what this is, whether it is on, and everything you can do
            from here. The primary action used to sit on its own line below,
            left-aligned against nothing; paired with Settings it reads as a
            toolbar and the page below it starts clean. */}
        <div className="flex items-center justify-between gap-4 pb-3 mb-1 border-b border-white/[0.06]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 20 }} aria-hidden="true">smart_toy</span>
            <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{t("codingAgent.title")}</h1>
            {status && (
              <span
                data-testid="coding-agent-state"
                className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider border rounded-full pl-1.5 pr-2 py-0.5 ${
                  status.enabled ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/[0.07]" : "text-[var(--text-muted)] border-white/15"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full ${status.enabled ? "bg-emerald-400" : "bg-[var(--text-muted)]"}`}
                />
                {status.enabled ? t("codingAgent.stateOn") : t("codingAgent.stateOff")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Create app lives HERE now, beside Settings and the same size as
                it, instead of as a lone banner-ish button under the header.
                Home face only: on the settings and wizard faces there is
                nothing for it to create into yet. */}
            {view.face === "home" && !standalone && (
              <button
                type="button"
                onClick={openNew}
                data-testid="coding-agent-new"
                className={BTN_PRIMARY}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">add</span>
                {t("codingAgent.createNewProject")}
              </button>
            )}
          {/* The settings live IN this app: one button, on the desktop and on
              /app/coding alike, so a phone that landed here from "Open in new
              tab" reaches the switch without a desktop listening. */}
          {/* ONE control, in the header where it is aligned with the cards
              below it. It used to be a Settings button here plus a separate
              Back pill floating above the settings page — two affordances for
              one axis, and the pill lined up with nothing. */}
          <button
            type="button"
            onClick={() => { disarmClear(); setPage(view.face === "settings" ? "home" : "settings"); }}
            data-testid={view.face === "settings" ? "coding-agent-settings-back" : "coding-agent-open-settings"}
            aria-expanded={view.face === "settings"}
            className={OPEN_SETTINGS_CLASS}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
              {view.face === "settings" ? "arrow_back" : "settings"}
            </span>
            {view.face === "settings" ? t("codingAgent.back") : t("codingAgent.openSettings")}
          </button>
          </div>
        </div>

        {view.face === "settings" && (
          <div className="mt-3" data-testid="coding-agent-embedded-settings">
            <CodingAgentSettingsPanel />
            {/* Three owner tools, one row, symmetric: equal columns, so the
                buttons are the same width whatever their labels say, each with
                its explanation on the question mark beside it. The headings
                above them were saying the button's own words twice. */}
            <div className={`${CARD} mt-4 grid gap-4 grid-cols-1 @md:grid-cols-3`} data-testid="coding-agent-owner-tools">
              <div className="flex flex-wrap items-center gap-2" data-testid="coding-agent-reset-card">
                <CodingAgentResetCard
                  // Start over lands on the front door, not on a settings page
                  // for a configuration that was just erased.
                  onReset={() => { disarmClear(); setPage("home"); }}
                />
              </div>

              <div className="flex items-center gap-2" data-testid="coding-agent-harness-card">
                <button
                  type="button"
                  onClick={() => void testHarness()}
                  disabled={busy === "harness-test" || anyLive || !status?.enabled || !status?.ready}
                  data-testid="coding-agent-harness-test"
                  className={`${BTN_SECONDARY} flex-1`}
                >
                  {t("codingAgent.harnessTest")}
                </button>
                <HelpTip
                  text={t("codingAgent.harnessTestHint")}
                  label={t("codingAgent.harnessTestTitle")}
                  testId="coding-agent-harness-help"
                />
              </div>

              <div className="flex items-center gap-2" data-testid="coding-agent-clear-card">
                {/* Disabled rather than hidden when there is nothing to clear:
                    the row stays symmetric, and a confirmed tap still cannot
                    answer with nothing. */}
                <button
                  type="button"
                  onClick={() => { if (confirmClear) { disarmClear(); void clearRuns(); } else armClear(); }}
                  onBlur={disarmClear}
                  disabled={busy === "clear" || !runs.some((r) => isSettled(r.status))}
                  data-testid="coding-agent-clear"
                  className={`${confirmClear ? BTN_DANGER : BTN_SECONDARY} flex-1`}
                >
                  {confirmClear ? t("codingAgent.clearConfirm") : t("codingAgent.clearRuns")}
                </button>
                <HelpTip
                  text={t("codingAgent.clearRunsHint")}
                  label={t("codingAgent.clearRuns")}
                  testId="coding-agent-clear-help"
                />
              </div>
            </div>
          </div>
        )}

        {view.face === "wizard" && status && (
          <CodingAgentSetupWizard
            status={status}
            // The wizard writes through the same routes this window reads, so
            // finishing is just "read yourself again": the flag comes back
            // true and the face flips to home.
            onDone={() => { void load(); }}
          />
        )}

        {view.face === "home" && (<>
        {/* Nothing at all when the harness is fine. A row that always says
            "Ready" is a row that never tells the owner anything; the checklist
            appears only when something is actually missing. */}
        {readiness && !readiness.ready && (
          <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-3 py-2">
            <ul className="space-y-1">
              {checks.filter((c) => !c.ok).map((c) => (
                <li key={c.label} className="flex items-center gap-2 text-xs">
                  <span className="material-symbols-rounded text-red-400" style={{ fontSize: 16 }} aria-hidden="true">cancel</span>
                  <span className="text-[var(--text-primary)]">{c.label}</span>
                  <span className="text-[var(--text-muted)]">· {c.badText}</span>
                </li>
              ))}
            </ul>
            {readiness.problems.length > 0 && (
              <p className="text-[11px] text-amber-400 mt-1.5 leading-relaxed" role="alert">
                {readiness.problems.join(" ")}
              </p>
            )}
          </div>
        )}

        {/* The projects, and the way to start one. */}
        <div className="mt-4" data-testid="coding-agent-projects-section">
          <div className="flex items-center justify-between gap-2 px-0.5">
            <h2 className={SECTION_LABEL}>
              {t("codingAgent.projectsTitle")}
              {projects.length > 0 && (
                <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--text-secondary)]">
                  {projects.length}
                </span>
              )}
            </h2>
          </div>

          {standalone && (
            <p className="mt-2 px-1 text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-new-needs-desktop">
              {t("codingAgent.newNeedsDesktop")}
            </p>
          )}



          {projects.length === 0 ? (
            // The window is mostly empty at this point in a box's life, and a
            // single grey sentence against all that space read like a bug. A
            // bounded, dashed panel gives the emptiness an edge and puts the
            // one thing to do next inside it.
            <div
              className="mt-2 rounded-2xl border border-dashed border-white/[0.12] bg-white/[0.015] px-5 py-8 text-center"
              data-testid="coding-agent-projects-empty-panel"
            >
              <span className="material-symbols-rounded text-[var(--text-muted)]/70" style={{ fontSize: 28 }} aria-hidden="true">folder_open</span>
              {/* The testid stays on the SENTENCE, not the panel around it: it
                  is the copy that is pinned, and a panel's textContent would
                  also carry the icon ligature and the button label. */}
              <p
                data-testid="coding-agent-projects-empty"
                className="mt-2 text-xs leading-relaxed text-[var(--text-muted)] max-w-sm mx-auto"
              >
                {projectsDir ? t("codingAgent.noProjects", { folder: projectsDir }) : t("codingAgent.projectFolderUnset")}
              </p>
              {!standalone && (
                <button type="button" onClick={openNew} className={`${BTN_PRIMARY} mt-4`}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">add</span>
                  {t("codingAgent.createNewProject")}
                </button>
              )}
            </div>
          ) : (
            <ul className="space-y-1.5 mt-2" data-testid="coding-agent-projects">
              {projects.map((project) => {
                const running = project.latestRun?.status === "running";
                return (
                  <li
                    // The absolute folder: a code project and a folder of the
                    // owner's can share a name.
                    key={project.directory}
                    data-testid={`coding-agent-project-${project.folder}`}
                    // The row opens the project, and it holds buttons of its
                    // own (copy, Open), so it cannot be a <button> itself:
                    // role and tabIndex make it a keyboard stop, and Enter
                    // or Space opens it the way a click does.
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenProjectDir(project.directory)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenProjectDir(project.directory);
                      }
                    }}
                    className="rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-3 py-2 flex items-start justify-between gap-3 cursor-pointer hover:bg-white/[0.06] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* The picture the box drew for this project while a run
                            worked in it (src/lib/project-icon.ts). Absent until
                            one has been drawn, which is most of a fresh box. */}
                        <ProjectIcon project={project} size="w-6 h-6" />
                        <span className="text-xs font-medium text-[var(--text-primary)] break-words">{project.name}</span>
                        {/* Says where the folder lives: a code project's is
                            under the checkout, not in the owner's folder. */}
                        {project.kind === "codeProject" && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--text-muted)] border-white/20">
                            {t("codingAgent.codeProject")}
                          </span>
                        )}
                        {project.onDesktop && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-sky-300 border-sky-400/40">
                            {t("codingAgent.onDesktop")}
                          </span>
                        )}
                        {running && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-amber-400 border-amber-400/40">
                            {t("codingAgent.runInProgress")}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-[var(--text-muted)] mt-0.5 break-words">
                        {project.lastCommit
                          ? <>{firstLine(project.lastCommit.subject, 80)} · {timeAgo(project.lastCommit.date, t)}</>
                          : t("codingAgent.noCommits")}
                      </p>
                      {/* The folder name is what a run is given and what the
                          owner types into a chat, so it is one tap to copy. */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void copyFolder(project.folder); }}
                        title={t("codingAgent.copyFolder")}
                        aria-label={t("codingAgent.copyFolder")}
                        data-testid={`coding-agent-copy-${project.folder}`}
                        className="mt-0.5 flex items-center gap-1 text-[11px] font-mono text-[var(--text-muted)] opacity-70 hover:opacity-100 hover:text-white"
                      >
                        {project.folder}
                        <span className="material-symbols-rounded" style={{ fontSize: 12 }} aria-hidden="true">
                          {copiedFolder === project.folder ? "check" : "content_copy"}
                        </span>
                        {copiedFolder === project.folder && <span className="font-sans">{t("codingAgent.copied")}</span>}
                      </button>
                    </div>
                    {project.onDesktop && (
                      <button
                        type="button"
                        // The desktop registers a deployed web app under
                        // `installed-<folder>` (page.tsx, getAllApps); the
                        // bare folder name matches no app there, and the
                        // click did nothing at all.
                        onClick={(e) => { e.stopPropagation(); dispatchOpenApp(installedAppId(project.folder)); }}
                        data-testid={`coding-agent-open-${project.folder}`}
                        className={BTN_SECONDARY}
                      >
                        {t("codingAgent.open")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        </>)}

        {/* One run, on its own page. */}
        {view.face === "run" && (() => {
          const run = view.run;
          const tone = RUN_TONE[run.status];
          const started = run.status !== "draft";
          const project = projects.find((pr) => runBelongsTo(run, pr)) ?? null;
          const reviewedBy = runs.find((r) => r.reviewOf === run.id);
          const artifacts = run.artifacts ?? [];
          const images = artifacts.filter((a) => a.kind === "image");
          // Clips get a player rather than a link: a run can now record its own
          // narration, and a download is not how you check what it says.
          const clips = artifacts.filter((a) => a.kind === "audio");
          const files = artifacts.filter((a) => a.kind !== "image" && a.kind !== "audio");
          const reportFile = files.find((a) => a.kind === "markdown" && a.name === "report.md") ?? files.find((a) => a.kind === "markdown");
          const helpers = Object.entries(run.subagentsByType ?? {});
          const todos = run.todos ?? [];
          const todosDone = todos.filter((x) => x.status === "completed").length;
          const activity = run.progress.slice(-ACTIVITY_SHOWN);
          const title = run.reviewOf ? t("codingAgent.reviewPassTitle", { id: run.reviewOf }) : firstLine(run.task, 160);
          const fullTask = !run.reviewOf && run.task.trim() !== firstLine(run.task, 160) ? run.task : null;
          return (
            <div className="mt-4 pb-6" data-testid="coding-agent-run-page" data-run-id={run.id}>
              <button
                type="button"
                onClick={() => setOpenRunId(null)}
                data-testid="coding-agent-run-back"
                className="mb-2 flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-muted)] hover:bg-white/5"
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">arrow_back</span>
                {openProject ? openProject.name : t("codingAgent.back")}
              </button>

              {/* The header: what this run is, how it stands, and everything
                  you can do to it. */}
              <div className="rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-4 py-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${tone.chip}`}>
                    {statusLabel(run.status)}
                  </span>
                  {run.status === "running" && (run.thinkingTokens ?? 0) > 0 && (
                    <span data-testid="coding-agent-thinking" className="text-[10px] font-semibold border rounded-full px-2 py-0.5 text-violet-300 border-violet-400/40">
                      {t("codingAgent.thinking", { n: run.thinkingTokens ?? 0 })}
                    </span>
                  )}
                  {prChip(run)}
                  {run.reviewOf && runChip(run.reviewOf, t("codingAgent.reviewOf", { id: run.reviewOf }), "coding-agent-review-of")}
                  {reviewedBy && runChip(reviewedBy.id, t("codingAgent.reviewedBy", { id: reviewedBy.id }), "coding-agent-reviewed-by")}
                  {project && (
                    <button
                      type="button"
                      onClick={() => { setOpenRunId(null); setOpenProjectDir(project.directory); }}
                      data-testid="coding-agent-run-project"
                      className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-sky-300 border-sky-400/40 hover:bg-sky-400/10 inline-flex items-center gap-1"
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 12 }} aria-hidden="true">folder</span>
                      {project.name}
                    </button>
                  )}
                </div>
                <h2 className="mt-2 text-sm font-semibold text-[var(--text-primary)] break-words" data-testid="coding-agent-run-title">{title}</h2>
                {fullTask && (
                  <details className="mt-1">
                    <summary className="text-[11px] text-[var(--text-muted)] cursor-pointer">{t("codingAgent.fullTask")}</summary>
                    <p className="mt-1 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{run.task}</p>
                  </details>
                )}
                <p className="text-[11px] text-[var(--text-muted)] mt-1.5 flex items-center gap-1 flex-wrap">
                  <span>{run.source === "owner" ? t("codingAgent.startedByOwner") : t("codingAgent.startedByAgent")}</span>
                  <span>· {t("codingAgent.startedAgo", { when: timeAgo(run.startedAt, t) })}</span>
                  {started && run.effort && <span>· {t(`codingAgent.effort.${run.effort}`)}</span>}
                  {run.lastActivityAt && <span>· {t("codingAgent.updated")} {timeAgo(run.lastActivityAt, t)}</span>}
                  {(run.modelsUsed?.length ?? 0) > 0 && <span>· {run.modelsUsed?.join(" + ")}</span>}
                </p>
                <button
                  type="button"
                  onClick={() => void copyFolder(run.id)}
                  title={t("codingAgent.copyId")}
                  aria-label={t("codingAgent.copyId")}
                  data-testid="coding-agent-run-copy-id"
                  className="mt-1 flex items-center gap-1 text-[11px] font-mono text-[var(--text-muted)] opacity-70 hover:opacity-100 hover:text-white"
                >
                  {run.id}
                  <span className="material-symbols-rounded" style={{ fontSize: 12 }} aria-hidden="true">
                    {copiedFolder === run.id ? "check" : "content_copy"}
                  </span>
                  {copiedFolder === run.id && <span className="font-sans">{t("codingAgent.copied")}</span>}
                </button>
                {isLive(run.status) && (
                  <RunProgressBar
                    estimate={estimateRunProgress(run, now)}
                    color={tone.color}
                    timeLeft={t("codingAgent.timeLeft")}
                    testId={`coding-agent-progress-${run.id}`}
                    className="mt-2"
                  />
                )}
                {/* A run that finished on its own keeps whatever it started:
                    an app that serves itself on a port is meant to stay up,
                    so the device says what survived instead of killing it
                    unasked, and the owner ends it when they are done.

                    Only once the run is OVER, though. A paused run also
                    records what it left behind, and killRunLeftovers refuses
                    one on purpose — the run is still the owner's to resume and
                    those leftovers are the very thing a resume carries on
                    against — so the button here could never do anything but
                    show that refusal. The same guard hides the flag a resume
                    carries into a running run, where it is stale as well. */}
                {run.leftover && isSettled(run.status) && (
                  <div className="mt-3 rounded-xl bg-amber-500/[0.05] border border-amber-500/30 px-4 py-2.5 flex items-center gap-2 flex-wrap" data-testid="coding-agent-run-leftover">
                    <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 16 }} aria-hidden="true">bolt</span>
                    <span className="text-[11px] text-[var(--text-secondary)]">{t("codingAgent.leftoverRunning")}</span>
                    <button
                      type="button"
                      onClick={() => runAction(run.id, "kill", t("codingAgent.killLeftoverFailed"))}
                      disabled={busy === run.id}
                      data-testid={`coding-agent-kill-${run.id}`}
                      className={`${BTN_SECONDARY} ml-auto`}
                    >
                      {t("codingAgent.killLeftover")}
                    </button>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="coding-agent-run-actions">
                  {runControls(run, "page")}
                  {reportFile && (
                    <button
                      type="button"
                      onClick={() => setReport({ runId: run.id, name: reportFile.name })}
                      data-testid="coding-agent-run-report"
                      className={BTN_SECONDARY}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">description</span>
                      {t("codingAgent.openReport")}
                    </button>
                  )}
                  {project?.onDesktop && (
                    <button
                      type="button"
                      onClick={() => dispatchOpenApp(installedAppId(project.folder))}
                      className={BTN_SECONDARY}
                    >
                      {t("codingAgent.open")}
                    </button>
                  )}
                </div>
              </div>

              {/* Wide: the run's story in the middle — its terminal while it
                  works, the summary, the plan, the log — and its data in a
                  rail beside it: figures, files, evidence, refusals. The
                  Claude Code web layout, in short. Narrow: one column. */}
              <div className="@3xl:grid @3xl:grid-cols-[minmax(0,1fr)_296px] @3xl:gap-4 @3xl:items-start">
                <div className="min-w-0">
              {/* While the run works: its terminal, embedded — the transcript
                  tailed live where the activity log used to be. Once it has
                  settled, the log (below) is the record. */}
              {isLive(run.status) && run.transcriptPath && (() => {
                const command = livePreviewCommand({ transcriptPath: run.transcriptPath ?? null, sessionId: run.sessionId ?? null, directory: run.directory, live: true });
                if (!command) return null;
                return (
                  <div className="mt-3 rounded-xl border border-emerald-400/20 overflow-hidden flex flex-col" style={{ height: 460, background: "#0d0d1a" }} data-testid="coding-agent-run-terminal">
                    <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.06] bg-white/[0.03] shrink-0">
                      <span className="material-symbols-rounded text-emerald-400" style={{ fontSize: 16 }} aria-hidden="true">terminal</span>
                      <p className={`${SECTION_LABEL} !mb-0`}>{t("codingAgent.livePreviewTitle")}</p>
                      <span className="ml-auto" />
                      <button
                        type="button"
                        onClick={() => openInTerminal(run)}
                        data-testid="coding-agent-run-terminal-open"
                        className="text-[11px] px-2 py-0.5 rounded-md border border-white/10 text-[var(--text-muted)] hover:bg-white/5 cursor-pointer"
                      >
                        {t("codingAgent.livePreviewOpenApp")}
                      </button>
                    </div>
                    <div className="flex-1 min-h-0">
                      {/* Keyed by the run: a terminal types its command once,
                          on its first output, so a reused one would keep
                          tailing the previous run. */}
                      <TerminalApp key={run.id} initialCommand={command} />
                    </div>
                  </div>
                );
              })()}

              {/* The summary is the run's closing message, and that is
                  markdown. Drawn through the chat's renderer, which builds
                  elements from the text and never injects HTML — what lets
                  agent-written words on to the owner's screen at all. */}
              <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-4 py-3">
                <p className={SECTION_LABEL}>{t("codingAgent.summaryTitle")}</p>
                {run.summary ? (
                  <div
                    data-testid="coding-agent-summary"
                    className="mt-2 text-xs text-[var(--text-secondary)] leading-relaxed min-w-0 break-words [&_img]:max-w-full"
                  >
                    {renderText(run.summary, t("chat.table"))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    {isLive(run.status) ? t("codingAgent.noSummaryYet") : t("codingAgent.noSummary")}
                  </p>
                )}
              </div>

              {/* The plan, as the run last wrote it. */}
              {todos.length > 0 && (
                <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-4 py-3" data-testid="coding-agent-run-plan">
                  <p className={SECTION_LABEL}>
                    {t("codingAgent.planTitle")}
                    <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--text-secondary)]">{todosDone}/{todos.length}</span>
                  </p>
                  <ul className="mt-2 space-y-1">
                    {todos.map((item, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <span
                          className={`material-symbols-rounded shrink-0 ${
                            item.status === "completed" ? "text-emerald-400" : item.status === "in_progress" ? "text-amber-400 animate-pulse" : "text-[var(--text-muted)]"
                          }`}
                          style={{ fontSize: 15 }}
                          aria-hidden="true"
                        >
                          {item.status === "completed" ? "check_circle" : item.status === "in_progress" ? "radio_button_checked" : "radio_button_unchecked"}
                        </span>
                        <span className={item.status === "completed" ? "text-[var(--text-muted)] line-through decoration-white/20" : "text-[var(--text-primary)]"}>
                          {item.status === "in_progress" && item.activeForm ? item.activeForm : (item.content ?? "")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Which helpers are out right now. */}
              {(run.activeSubagents?.length ?? 0) > 0 && (
                <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-4 py-3">
                  <p className={SECTION_LABEL}>{t("codingAgent.helpersTitle")}</p>
                  <ul className="mt-2 space-y-1" data-testid="coding-agent-active-subagents">
                    {run.activeSubagents?.map((a, i) => (
                      <li key={i} className="flex items-start gap-2 text-[11px]">
                        <span className="material-symbols-rounded text-sky-400 animate-pulse shrink-0" style={{ fontSize: 13 }} aria-hidden="true">sync</span>
                        <span className="text-sky-300 font-medium shrink-0">{a.type}</span>
                        <span className="text-[var(--text-muted)] break-words min-w-0">{a.description}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {run.error && (
                <div className="mt-3 rounded-xl bg-red-500/[0.06] border border-red-500/30 px-4 py-3" data-testid="coding-agent-run-error">
                  <p className="text-[11px] font-medium text-red-300">{t("codingAgent.errorTitle")}</p>
                  <pre className="mt-1 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words font-sans leading-relaxed">{run.error}</pre>
                </div>
              )}

              {/* The newest steps, as the runner recorded them — the record
                  once the run has settled. */}
              {activity.length > 0 && !(isLive(run.status) && run.transcriptPath) && (
                <details className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-4 py-3" data-testid="coding-agent-run-activity" open={isLive(run.status)}>
                  <summary className={`${SECTION_LABEL} cursor-pointer list-none`}>
                    {t("codingAgent.activityTitle")}
                    <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--text-secondary)]">{activity.length}</span>
                  </summary>
                  <ol className="mt-2 space-y-0.5 font-mono text-[11px] text-[var(--text-muted)] max-h-72 overflow-y-auto">
                    {activity.map((line, i) => (
                      <li key={i} className="break-words whitespace-pre-wrap">{line}</li>
                    ))}
                  </ol>
                </details>
              )}
                </div>
                <aside className="min-w-0" data-testid="coding-agent-run-rail">
              {/* The figures. */}
              <div className="mt-3 grid grid-cols-2 @md:grid-cols-4 @3xl:grid-cols-2 gap-2" data-testid="coding-agent-run-figures">
                <StatTile label={t("codingAgent.statSteps")} value={started ? String(run.numTurns) : "—"} />
                <StatTile label={t("codingAgent.statFiles")} value={String(run.filesTouched.length)} />
                <StatTile label={t("codingAgent.statDuration")} value={started ? duration(run) : "—"} />
                <StatTile
                  label={t("codingAgent.statTokens")}
                  value={(run.tokensUsed ?? 0) > 0 ? tokens(run.tokensUsed ?? 0) : "—"}
                  hint={(run.thinkingTokens ?? 0) > 0 ? t("codingAgent.thinking", { n: run.thinkingTokens ?? 0 }) : undefined}
                />
                <StatTile
                  label={t("codingAgent.statHelpers")}
                  value={String(run.subagentsTotal ?? 0)}
                  hint={helpers.length > 0 ? helpers.map(([k, n]) => `${n}× ${k}`).join(", ") : undefined}
                />
                <StatTile label={t("codingAgent.statCommit")} value={run.commit ?? "—"} />
                <StatTile
                  label={t("codingAgent.deniedTitle")}
                  value={String(run.permissionDenials)}
                />
                <StatTile label={t("codingAgent.statModels")} value={run.modelsUsed?.length ? run.modelsUsed.join(" + ") : "—"} />
              </div>

              {run.filesTouched.length > 0 && (
                <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-4 py-3" data-testid="coding-agent-run-files">
                  <p className={SECTION_LABEL}>
                    {t("codingAgent.filesTitle")}
                    <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--text-secondary)]">{run.filesTouched.length}</span>
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {run.filesTouched.map((f) => (
                      <li key={f} className="text-[11px] font-mono text-[var(--text-secondary)] bg-black/20 border border-[var(--border-subtle)] rounded-md px-2 py-0.5 break-all">{f}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* The run's evidence: screenshots it took while verifying its
                  work, its report.md, and whatever test output it saved. */}
              {artifacts.length > 0 && (
                <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-4 py-3" data-testid="coding-agent-artifacts">
                  <p className={SECTION_LABEL}>{t("codingAgent.artifactsTitle")}</p>
                  {images.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {images.map((a) => (
                        <a
                          key={a.name}
                          href={artifactUrl(run.id, a.name)}
                          target="_blank"
                          rel="noreferrer"
                          title={[a.name, formatBytes(a.bytes)].filter(Boolean).join(" · ")}
                          className="block rounded-lg border border-white/10 overflow-hidden hover:border-white/25"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- device-served bytes, no next/image loader on the box */}
                          <img src={artifactUrl(run.id, a.name)} alt={a.name} loading="lazy" className="h-24 w-auto max-w-[12rem] object-cover" />
                        </a>
                      ))}
                    </div>
                  )}
                  {clips.length > 0 && (
                    <div className="mt-2 space-y-1.5" data-testid="coding-agent-artifact-audio">
                      {clips.map((a) => (
                        <div key={a.name} className="flex items-center gap-2 flex-wrap">
                          <span className="text-[11px] text-[var(--text-secondary)] break-all">{a.name}</span>
                          {formatBytes(a.bytes) && <span className="text-[11px] text-[var(--text-muted)]">· {formatBytes(a.bytes)}</span>}
                          {/* No track: the clip is speech the run generated, and
                              the text it was made from is in the run's report. */}
                          <audio controls preload="none" src={artifactUrl(run.id, a.name)} className="h-8 max-w-full" />
                        </div>
                      ))}
                    </div>
                  )}
                  {files.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {files.map((a) => (
                        <li key={a.name} className="text-[11px]">
                          {a.kind === "markdown" ? (
                            <button
                              type="button"
                              onClick={() => setReport({ runId: run.id, name: a.name })}
                              className="text-[var(--text-secondary)] hover:text-white underline decoration-white/20 break-all text-left"
                            >
                              {a.name}
                            </button>
                          ) : (
                            <a
                              href={artifactUrl(run.id, a.name)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[var(--text-secondary)] hover:text-white underline decoration-white/20 break-all"
                            >
                              {a.name}
                            </a>
                          )}
                          {formatBytes(a.bytes) && <span className="text-[var(--text-muted)]"> · {formatBytes(a.bytes)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* What was refused, spelled out. */}
              {(run.deniedActions?.length ?? 0) > 0 && (
                <div className="mt-3 rounded-xl bg-amber-500/[0.05] border border-amber-500/30 px-4 py-3" data-testid="coding-agent-denied">
                  <p className="text-[11px] font-medium text-amber-400">{t("codingAgent.deniedTitle")}</p>
                  <ul className="mt-1 space-y-0.5">
                    {run.deniedActions?.map((d, i) => (
                      <li key={i} className="text-[11px] font-mono text-[var(--text-muted)] break-all">{d}</li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-1 leading-relaxed">{t("codingAgent.deniedHelp")}</p>
                </div>
              )}

                </aside>
              </div>
            </div>
          );
        })()}

        {/* One project, expanded: its data, its git state, its runs. */}
        {view.face === "project" && (<>
          <div className="mt-4" data-testid="coding-agent-project-page">
            <button
              type="button"
              onClick={() => setOpenProjectDir(null)}
              data-testid="coding-agent-project-back"
              className="mb-2 flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-muted)] hover:bg-white/5"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">arrow_back</span>
              {t("codingAgent.back")}
            </button>
            <div className="rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-3 py-3">
              <div className="flex items-center gap-2 flex-wrap">
                {/* The same picture as the row it was opened from, one size up. */}
                <ProjectIcon project={view.project} size="w-7 h-7" />
                <span className="text-sm font-semibold text-[var(--text-primary)] break-words">{view.project.name}</span>
                {view.project.kind === "codeProject" && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--text-muted)] border-white/20">
                    {t("codingAgent.codeProject")}
                  </span>
                )}
                {view.project.onDesktop && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-sky-300 border-sky-400/40">
                    {t("codingAgent.onDesktop")}
                  </span>
                )}
                {view.project.onDesktop && (
                  <button
                    type="button"
                    onClick={() => dispatchOpenApp(installedAppId(view.project.folder))}
                    className={`${BTN_SECONDARY} ml-auto`}
                  >
                    {t("codingAgent.open")}
                  </button>
                )}
              </div>
              {/* Shows the absolute directory, so that is what it copies —
                  the home row copies the bare folder name it shows. */}
              <button
                type="button"
                onClick={() => void copyFolder(view.project.directory)}
                title={t("codingAgent.copyFolder")}
                aria-label={t("codingAgent.copyFolder")}
                data-testid="coding-agent-project-copy"
                className="mt-1 flex items-center gap-1 text-[11px] font-mono text-[var(--text-muted)] opacity-70 hover:opacity-100 hover:text-white"
              >
                {view.project.directory}
                <span className="material-symbols-rounded" style={{ fontSize: 12 }} aria-hidden="true">
                  {copiedFolder === view.project.directory ? "check" : "content_copy"}
                </span>
                {copiedFolder === view.project.directory && <span className="font-sans">{t("codingAgent.copied")}</span>}
              </button>
              {/* The git block: where the project stands, and whether it has
                  reached GitHub yet — the store road starts there. */}
              <div className="mt-2 rounded-lg bg-black/20 border border-[var(--border-subtle)] px-2.5 py-2 text-[11px]" data-testid="coding-agent-git-info">
                <p className="flex items-center gap-2 text-[var(--text-primary)]">
                  <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 14 }} aria-hidden="true">account_tree</span>
                  {t("codingAgent.gitTitle")}
                  {git?.branch && <span className="font-mono text-[var(--text-muted)]">{git.branch}</span>}
                  {git && <span className="text-[var(--text-muted)]">· {t("codingAgent.gitCommits", { n: git.commits })}</span>}
                </p>
                <p className="mt-1 text-[var(--text-muted)] break-all">
                  {git?.lastCommit
                    ? <>{firstLine(git.lastCommit.subject, 90)} · {timeAgo(git.lastCommit.date, t)}</>
                    : (view.project.lastCommit ? <>{firstLine(view.project.lastCommit.subject, 90)} · {timeAgo(view.project.lastCommit.date, t)}</> : t("codingAgent.noCommits"))}
                </p>
                <p className="mt-1 break-all">
                  {git?.remote
                    ? <span className="font-mono text-emerald-400/90">{git.remote}</span>
                    : <span className="text-[var(--text-muted)]">{t("codingAgent.gitNoRemote")}</span>}
                </p>
                {github?.connected && (git?.lastCommit || view.project.lastCommit) && (
                  <button
                    type="button"
                    onClick={() => void backup({ projectId: view.project.kind === "codeProject" ? view.project.folder : null, directory: view.project.directory }, `project-${view.project.folder}`)}
                    disabled={busy === `backup-project-${view.project.folder}`}
                    data-testid="coding-agent-project-backup"
                    className={`${BTN_BASE} mt-2 border border-emerald-400/40 bg-emerald-400/[0.07] text-emerald-400 hover:bg-emerald-400/[0.14]`}
                  >
                    {busy === `backup-project-${view.project.folder}` ? t("codingAgent.backupBusy") : t("codingAgent.backup")}
                  </button>
                )}
              </div>
            </div>
          </div>

        {runsSection}
        </>)}

        {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
      </div>
      </div>

      {report && (
        <CodingAgentReportPreview
          key={`${report.runId}/${report.name}`}
          runId={report.runId}
          name={report.name}
          onClose={() => setReport(null)}
        />
      )}
    </div>
  );
}
