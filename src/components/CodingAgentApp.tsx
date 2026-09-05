"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { estimateRunProgress } from "@/lib/coding-agent-progress";
import { isLive, isSettled, type CodingRunStatus } from "@/lib/coding-agent-status";
import { isPrPending, type PrState } from "@/lib/coding-pr-state";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";
import CodingAgentSettingsPanel from "./CodingAgentSettingsPanel";
import CodingAgentResetCard from "./CodingAgentResetCard";
import HelpTip from "./HelpTip";
import InstalledAppIcon from "./InstalledAppIcon";
import CodingAgentSetupWizard from "./CodingAgentSetupWizard";
import { APP_GROUND, BTN_BASE, BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, CARD, CARD_SURFACE, INSET_SURFACE, RAIL_SURFACE, SECTION_LABEL, SEGMENT_OFF, SEGMENT_ON, SEGMENTED_TRACK } from "./coding-agent-ui";
import { startHarnessTest } from "@/lib/coding-agent-harness-test";
import { openNewAppCard } from "@/lib/ui-events";
import { githubRepoName, githubWebUrl } from "@/lib/github-url";
import CodingRunTimeline from "./CodingRunTimeline";
import RunProgressBar, { RUN_TONE } from "./RunProgressBar";
// The "3h ago" the rest of the desktop speaks — ClawKeep's helper and its
// keys, translated in every locale, rather than a second English-only one.
import { timeAgo } from "./clawkeep-ui";
import { formatBytes } from "@/lib/format-bytes";
import { artifactUrl } from "@/lib/use-coding-agent-activity";
import AnimatedNumber from "./AnimatedNumber";
import CodingRunSummary from "./CodingRunSummary";
import CodingRunTeamMembers from "./CodingRunTeamMembers";
import {
  OPEN_CODING_RUN_EVENT,
  dispatchOpenApp,
  notifyCodingRunStarted,
  onCodingAgentChanged,
  onStandaloneAppPage,
  takePendingCodingRun,
} from "@/lib/ui-events";
import NewAppWizardCard, { DEFAULT_MAX_TASK_CHARS, NEW_APP_NAME_MAX } from "./NewAppWizardCard";
import ImportProjectPanel, { type ImportResult } from "./ImportProjectPanel";
import TerminalApp from "./TerminalApp";
import VNCApp from "./VNCApp";
import CodingAgentBreadcrumb from "./CodingAgentBreadcrumb";
import CodingProjectWorkspace from "./CodingProjectWorkspace";
import CodingTeamCard from "./CodingTeamCard";
import { livePreviewCommand } from "@/lib/coding-run-preview";
import { copyToClipboard } from "@/lib/clipboard";
import { taskTitle } from "@/lib/task-title";
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
  /** When each progress line happened, one for one with `progress`; absent on a record from before the field. */
  progressAt?: number[];
  effort?: Effort;
  /** Sub-agents working right now; 0 once the run has settled. */
  subagentsActive?: number;
  subagentsTotal?: number;
  subagentsByType?: Record<string, number>;
  modelsUsed?: string[];
  lastActivityAt?: number;
  /** The model the run started with, as the runner recorded it. */
  model?: string | null;
  activeSubagents?: { type: string; description: string; startedAt: number }[];
  /** The helpers that came back: what each did, when, and whether it was refused. */
  subagents?: { type: string; description: string; startedAt: number; endedAt: number; refused: boolean }[];
  /** The commit this run's work was recorded as — what a backup would push. */
  commit?: string | null;
  thinkingTokens?: number;
  tokensUsed?: number;
  sessionId?: string | null;
  /** Where Claude Code keeps this run's transcript, for the live preview. */
  transcriptPath?: string | null;
  /** The run this one is the automatic review pass of, when it is one. */
  reviewOf?: string | null;
  /** Set on a run a coding team spawned: which team, in which role, for which task. */
  team?: { id: string; role: "planner" | "worker" | "reviewer"; taskId: string | null } | null;
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
  /** The project's clawbox.json, when it is a ClawBox app (src/lib/clawbox-manifest.ts). */
  app?: { name: string; description: string | null; kind: string | null; port: number | null } | null;
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
/**
 * Put a project whose clawbox.json names a port on the desktop — the box
 * checks that the project's own server is listening first
 * (src/lib/app-proxy.ts) — and answer the refusal's sentence when it is not.
 */
async function addProjectToDesktop(directory: string): Promise<string | null> {
  try {
    const res = await fetch("/setup-api/coding-agent/projects/desktop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory }),
    });
    const data = await res.json().catch(() => ({})) as { error?: string };
    return res.ok ? null : (data.error || "Could not add the app to the desktop.");
  } catch {
    return "Could not add the app to the desktop.";
  }
}

export function installedAppId(folder: string): string {
  return `installed-${folder}`;
}

/** One page of runs. The list is open by default now, so it has to be paged
 *  rather than unbounded — a long history should not push the settings off
 *  the top of the window. */
/** "12s" / "3m 4s" — how long a helper has been out, or took. */
function elapsedShort(from: number, to: number): string {
  const sec = Math.max(0, Math.round((to - from) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${sec - m * 60}s`;
}

/** How many pictures a run's evidence card shows before it asks to be unfolded. */
const ARTIFACT_PREVIEW = 4;
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
  return taskTitle(text, max);
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
function StatTile({ label, value, hint, testId }: { label: string; value: ReactNode; hint?: string; testId?: string }) {
  return (
    <div className={`${CARD_SURFACE} px-3 py-2 min-w-0`} data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] truncate">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-[var(--text-primary)] truncate" title={hint ?? (typeof value === "string" ? value : undefined)}>{value}</div>
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
  // The run whose page is in Live view — the browser it drives over its
  // terminal, filling the window. Keyed by the run rather than a flag, so
  // opening another run lands on its normal page and a run that settles
  // simply falls out of the view (the toggle exists only while it is live).
  // The browser preview above a live run's terminal, shown or folded.
  // The live card's tab — Timeline, Terminal or Browser, one at a time —
  // remembered per run, so another run's page opens on its timeline.
  const [liveTabFor, setLiveTabFor] = useState<{ id: string; tab: "timeline" | "terminal" | "browser" } | null>(null);
  /** The markdown artifact open in the preview dialog, if any. */
  // The run whose whole evidence list is unfolded. A run that screenshots
  // every step files dozens of pictures, and drawn in full they pushed the
  // summary and the files off the page; the card shows a few and the rest
  // on request. Keyed by run so the next run's page starts folded.
  const [artifactsOpenFor, setArtifactsOpenFor] = useState<string | null>(null);
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
  // Pull requests opened from a project's page this session, by folder.
  const [projectPrs, setProjectPrs] = useState<Record<string, { number: number; url: string }>>({});
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
  /** The Import panel on the home face: GitHub or a folder on the box. */
  const [importOpen, setImportOpen] = useState(false);
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

  /**
   * The Open button of a project row and page: the desktop window when the
   * app is registered there; otherwise — a clawbox.json naming a port — the
   * box is asked to put it on the desktop first, and the row's next read
   * shows Open.
   */
  const openOrAddProject = async (project: Pick<Project, "folder" | "directory" | "onDesktop" | "app">) => {
    if (project.onDesktop) { dispatchOpenApp(installedAppId(project.folder)); return; }
    if (!project.app?.port) return;
    const failed = await addProjectToDesktop(project.directory);
    window.dispatchEvent(new CustomEvent("clawbox:toast", { detail: failed ? { message: failed, type: "error" } : { message: t("codingAgent.addedToDesktop", { name: project.app.name }), type: "success" } }));
    if (!failed) void load();
  };

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
      const detail = (e as CustomEvent<{ runId?: unknown }>).detail;
      const id = detail?.runId;
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
  /** The project page's Create PR: the branch the project is on, against the remote's default. */
  const createPr = async (target: { projectId: string | null; directory: string }, key: string) => {
    setBusy(`pr-${key}`);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(target.projectId ? { projectId: target.projectId } : { directory: target.directory }), action: "pr" }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.prFailed")));
      const out = await res.json() as { number: number; url: string; existing?: boolean };
      setProjectPrs((m) => ({ ...m, [target.directory]: { number: out.number, url: out.url } }));
      window.dispatchEvent(new CustomEvent("clawbox:toast", {
        detail: { message: t(out.existing ? "codingAgent.prExists" : "codingAgent.prOpened", { n: out.number }) },
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("codingAgent.prFailed"));
    } finally {
      setBusy(null);
    }
  };

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
  // Live view: only for the run whose page is open, and only while it runs.

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
  if (loading) return <div className={`h-full ${APP_GROUND}`} data-testid="coding-agent-panel" />;

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
  /** The Live view switch: only while the run runs, since the view is the
   *  browser it drives and the terminal it writes. */
  /** A row's glyph buttons — terminal, back up, details — one size, one row. */
  const ROW_ICON_BUTTON = "h-7 w-7 inline-flex items-center justify-center rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 hover:text-white disabled:opacity-50";

  const runControls = (run: Run, where: "row" | "page") => {
    const action = RUN_ACTION[run.status];
    // Resume in a terminal is for a run that has STOPPED; a live run's
    // transcript is on its page already, with its own Open in Terminal.
    const canOpenTerminal = Boolean(run.sessionId) && run.status !== "running";
    const terminalLabel = t("codingAgent.openResume");
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
        {canOpenTerminal && (where === "row" ? (
          // On a row, a glyph: the words took a third of the row's width
          // and every row said the same thing.
          <button
            type="button"
            onClick={() => openInTerminal(run)}
            data-testid={`coding-agent-terminal-${run.id}`}
            title={terminalLabel}
            aria-label={terminalLabel}
            className={ROW_ICON_BUTTON}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">terminal</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => openInTerminal(run)}
            data-testid={`coding-agent-terminal-${run.id}`}
            title={terminalLabel}
            className={secondary}
          >
            {terminalLabel}
          </button>
        ))}
        {github?.connected && run.commit && (where === "row" ? (
          <button
            type="button"
            onClick={() => void backup({ projectId: run.projectId, directory: run.directory }, run.id)}
            disabled={busy === `backup-${run.id}`}
            data-testid={`coding-agent-backup-${run.id}`}
            title={busy === `backup-${run.id}` ? t("codingAgent.backupBusy") : t("codingAgent.backup")}
            aria-label={busy === `backup-${run.id}` ? t("codingAgent.backupBusy") : t("codingAgent.backup")}
            className={ROW_ICON_BUTTON}
          >
            <span className={`material-symbols-rounded ${busy === `backup-${run.id}` ? "animate-spin" : ""}`} style={{ fontSize: 16 }} aria-hidden="true">{busy === `backup-${run.id}` ? "progress_activity" : "cloud_upload"}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void backup({ projectId: run.projectId, directory: run.directory }, run.id)}
            disabled={busy === `backup-${run.id}`}
            data-testid={`coding-agent-backup-${run.id}`}
            className={BTN_SECONDARY}
          >
            {busy === `backup-${run.id}` ? t("codingAgent.backupBusy") : t("codingAgent.backup")}
          </button>
        ))}
      </>
    );
  };


  /**
   * The runs a face lists, as one section: the toggle, the paged rows, the
   * More button. On a project's page they are its own; on home, the ones
   * filed under no project — those used to be computed and never drawn, so a
   * run in a folder the projects list does not know was invisible.
   */
  /**
   * The rows and the More button — the list itself. Home draws it under a
   * toggle (the runs filed under no project); a project's page draws it
   * inside its Runs tab, where it has the whole width.
   */
  const runsList = (
    <>
      {
        visibleRuns.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] mt-2 px-1">{t("codingAgent.noRuns")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2" data-testid="coding-agent-runs">
            {visibleRuns.slice(0, runsShown).map((run) => {
              const tone = RUN_TONE[run.status];
              // A draft has not run: its startedAt is when it was drafted
              // (the runner overwrites it at start), so a duration would be
              // time-since-drafting, which the "updated" line already says —
              // and the effort it will run with is read at start.
              const started = run.status !== "draft";
              const reviewedBy = runs.find((r) => r.reviewOf === run.id);
              return (
                <li
                  key={run.id}
                  data-run-id={run.id}
                  data-testid={`coding-agent-run-row-${run.id}`}
                  className={`${CARD_SURFACE} px-3 py-2 cursor-pointer hover:bg-black/30 transition-colors`}
                  onClick={(e) => {
                    // The row is the way to the run; a control on it (Stop,
                    // the terminal glyph, a chip to another run) is its own.
                    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
                    showRun(run.id);
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 inline-flex items-center gap-1.5 ${tone.chip} ${run.status === "running" ? "coding-agent-pulse" : ""}`} data-testid={`coding-agent-status-${run.id}`}>
                          {run.status === "running" && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />}
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
                    {/* One row of controls: a live run's Pause/Stop as words,
                        then the glyphs — terminal, back up, details — the
                        same size, side by side. */}
                    <div className="flex items-center gap-1 shrink-0">
                      {runControls(run, "row")}
                      {/* The run's own page: its figures, its summary, its
                          evidence. The row itself opens it too. */}
                      <button
                        type="button"
                        onClick={() => showRun(run.id)}
                        data-testid={`coding-agent-details-${run.id}`}
                        title={t("codingAgent.showDetails")}
                        aria-label={t("codingAgent.showDetails")}
                        className={ROW_ICON_BUTTON}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">chevron_right</span>
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
      }
      {visibleRuns.length > runsShown && (
        <button
          type="button"
          onClick={() => setRunsShown((n) => n + RUNS_PAGE)}
          data-testid="coding-agent-runs-more"
          className={`${BTN_SECONDARY} w-full mt-2`}
        >
          {t("codingAgent.more")} ({visibleRuns.length - runsShown})
        </button>
      )}
    </>
  );

  const runsSection = (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => { setShowRuns((v) => !v); setRunsShown(RUNS_PAGE); }}
        aria-expanded={showRuns}
        data-testid="coding-agent-runs-toggle"
        className={`w-full flex items-center justify-between gap-2 ${CARD_SURFACE} px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-white/[0.06] transition-colors`}
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

      {showRuns && runsList}
    </div>
  );

  return (
    // @container so the panel sizes to its WINDOW, not the viewport — this is
    // a desktop window the owner can resize independently of the screen.
    <div ref={rootRef} className={`h-full flex ${APP_GROUND} text-white @container`} data-testid="coding-agent-panel" data-help-bounds>
      {/* The sidebar — the Claude Code web layout's left rail: New, Home,
          Settings, the projects, the recent runs. Only when the window is
          wide enough to spare it (the phone and a small window keep the
          lists on the pages themselves), and not while the wizard runs. */}
      {wide && view.face !== "wizard" && (
        <aside className={`flex w-[15rem] shrink-0 flex-col border-r ${RAIL_SURFACE} overflow-y-auto`} data-testid="coding-agent-sidebar">
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
      <div className={`mx-auto w-full ${view.face === "run" ? "max-w-6xl" : view.face === "project" ? "max-w-none" : "max-w-2xl"} px-5 py-4 flex-1 flex flex-col min-h-0`}>

        {/* One row: what this is, whether it is on, and everything you can do
            from here. The primary action used to sit on its own line below,
            left-aligned against nothing; paired with Settings it reads as a
            toolbar and the page below it starts clean. */}
        {/* The header row is the narrow window's: with the rail up it would
            repeat the rail's New/Home/Settings and cost the page a row it
            needs for files — and the window's own title bar already names
            the app. The owner asked for no name and no state chip in the
            rail either; the switch is one tap away in Settings. The setup
            WIZARD has no rail at any width, so it keeps the row: without it
            a wide window on the wizard had no way to Settings at all. */}
        {(!wide || view.face === "wizard") && (
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
          {/* Settings opens from here. The way BACK is the breadcrumb every
              page but home carries (CodingAgentBreadcrumb) — one shape for
              the settings page, a project's and a run's, where three
              differently styled pills used to float — so this button never
              has to flip between two meanings. */}
          {view.face !== "settings" && (
            <button
              type="button"
              onClick={() => { disarmClear(); setPage("settings"); }}
              data-testid="coding-agent-open-settings"
              className={OPEN_SETTINGS_CLASS}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">settings</span>
              {t("codingAgent.openSettings")}
            </button>
          )}
          </div>
        </div>
        )}

        {view.face === "settings" && (<>
          <CodingAgentBreadcrumb
            crumbs={[
              { label: t("codingAgent.navHome"), onClick: () => { disarmClear(); setPage("home"); }, testId: "coding-agent-crumb-home" },
              { label: t("codingAgent.openSettings") },
            ]}
            onBack={() => { disarmClear(); setPage("home"); }}
            backLabel={t("codingAgent.back")}
            navLabel={t("codingAgent.breadcrumbLabel")}
            backTestId="coding-agent-settings-back"
          />
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
        </>)}

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
          <div className={`mt-3 ${CARD_SURFACE} px-3 py-2`}>
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
            {/* Bringing in what already exists: one of the owner's GitHub
                repositories, or a folder on the box. Offered on the standalone
                page too — nothing here needs the chat. */}
            <button
              type="button"
              onClick={() => setImportOpen((v) => !v)}
              aria-expanded={importOpen}
              className={BTN_SECONDARY}
              data-testid="coding-agent-import-toggle"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">download</span>
              {t("codingAgent.importButton")}
            </button>
          </div>

          {importOpen && (
            <ImportProjectPanel
              onClose={() => setImportOpen(false)}
              onOpenSettings={() => { disarmClear(); setImportOpen(false); setPage("settings"); }}
              onImported={(result: ImportResult) => {
                setImportOpen(false);
                const name = result.project?.name ?? result.folder;
                const lines = [t("codingAgent.importDone", { name })];
                if (result.skipped.length > 0) lines.push(t("codingAgent.importSkipped", { folders: result.skipped.join(", ") }));
                window.dispatchEvent(new CustomEvent("clawbox:toast", { detail: { message: lines.join(" "), type: "success" } }));
                // The row is on the next read; the page opens on the folder
                // now, and the project page reads its own git line.
                void load();
                setOpenRunId(null);
                setOpenProjectDir(result.directory);
              }}
            />
          )}

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
                    className={`${CARD_SURFACE} px-3 py-2 flex items-start justify-between gap-3 cursor-pointer hover:bg-white/[0.06] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400/60`}
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
                        {/* A clawbox.json makes the folder a ClawBox APP, not
                            just a folder with history. */}
                        {project.app && (
                          <span
                            className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--coral-bright)] border-[var(--coral-bright)]/40"
                            title={project.app.description ?? undefined}
                            data-testid={`coding-agent-app-chip-${project.folder}`}
                          >
                            {t("codingAgent.clawboxApp")}
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
                    </div>
                    {(project.onDesktop || project.app?.port) && (
                      <button
                        type="button"
                        // The desktop registers a deployed web app under
                        // `installed-<folder>` (page.tsx, getAllApps); the
                        // bare folder name matches no app there, and the
                        // click did nothing at all. A project whose manifest
                        // declares a port but is not on the desktop yet is
                        // put there first (the box checks its server is up).
                        onClick={(e) => { e.stopPropagation(); void openOrAddProject(project); }}
                        data-testid={`coding-agent-open-${project.folder}`}
                        className={BTN_SECONDARY}
                      >
                        {project.onDesktop ? t("codingAgent.open") : t("launcher.addToDesktop")}
                      </button>
                    )}
                    <span className="material-symbols-rounded text-[var(--text-muted)] opacity-60 shrink-0 self-center" style={{ fontSize: 18 }} aria-hidden="true">chevron_right</span>
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
          const artifactsFolded = artifacts.length > ARTIFACT_PREVIEW && artifactsOpenFor !== run.id;
          // Folded: the first few of WHATEVER kind — a run with two pictures
          // and three files shows five entries' worth of the first four, not
          // two pictures and a hidden rest.
          const shownArtifacts = artifactsFolded ? artifacts.slice(0, ARTIFACT_PREVIEW) : artifacts;
          const images = shownArtifacts.filter((a) => a.kind === "image");
          // Clips get a player rather than a link: a run can now record its own
          // narration, and a download is not how you check what it says.
          const clips = shownArtifacts.filter((a) => a.kind === "audio");
          const files = shownArtifacts.filter((a) => a.kind !== "image" && a.kind !== "audio");
          const helpers = Object.entries(run.subagentsByType ?? {});
          // The run's report — its closing message filed as Markdown, or a
          // fuller one it wrote — is what the Summary card draws.
          const reportFile = files.find((a) => a.kind === "markdown" && a.name === "report.md") ?? files.find((a) => a.kind === "markdown");
          const todos = run.todos ?? [];
          const todosDone = todos.filter((x) => x.status === "completed").length;
          const activity = run.progress.slice(-ACTIVITY_SHOWN);
          const activityAt = (run.progressAt?.length === run.progress.length ? run.progressAt : []).slice(-ACTIVITY_SHOWN);
          const title = run.reviewOf ? t("codingAgent.reviewPassTitle", { id: run.reviewOf }) : firstLine(run.task, 160);
          const fullTask = !run.reviewOf && run.task.trim() !== firstLine(run.task, 160) ? run.task : null;
          return (
            <div className="mt-4 pb-6" data-testid="coding-agent-run-page" data-run-id={run.id}>
              <CodingAgentBreadcrumb
                crumbs={[
                  { label: t("codingAgent.projectsTitle"), onClick: () => { setOpenRunId(null); setOpenProjectDir(null); }, testId: "coding-agent-crumb-projects" },
                  ...(project ? [{ label: project.name, onClick: () => { setOpenRunId(null); setOpenProjectDir(project.directory); }, testId: "coding-agent-crumb-project" }] : []),
                  { label: title },
                ]}
                onBack={() => { setOpenRunId(null); if (project) setOpenProjectDir(project.directory); }}
                backLabel={project ? t("codingAgent.backTo", { name: project.name }) : t("codingAgent.back")}
                navLabel={t("codingAgent.breadcrumbLabel")}
                backTestId="coding-agent-run-back"
              />

              {/* The header: what this run is, how it stands, and everything
                  you can do to it. */}
              <div className={`${CARD_SURFACE} px-4 py-3`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 inline-flex items-center gap-1.5 ${tone.chip} ${run.status === "running" ? "coding-agent-pulse" : ""}`} data-testid="coding-agent-run-status">
                    {run.status === "running" && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />}
                    {statusLabel(run.status)}
                  </span>
                  {run.status === "running" && (run.thinkingTokens ?? 0) > 0 && (
                    <span data-testid="coding-agent-thinking" className="text-[10px] font-semibold border rounded-full px-2 py-0.5 text-violet-300 border-violet-400/40">
                      {t("codingAgent.thinking", { n: run.thinkingTokens ?? 0 })}
                    </span>
                  )}
                  {prChip(run)}
                  {run.team && (
                    <span
                      className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--coral-bright)] border-[var(--coral-bright)]/40"
                      title={run.team.id}
                      data-testid="coding-agent-run-team"
                    >
                      {run.team.role === "planner"
                        ? t("codingAgent.team.rolePlanner")
                        : run.team.role === "reviewer"
                          ? t("codingAgent.team.roleReviewer", { task: run.team.taskId ?? "" })
                          : t("codingAgent.team.roleWorker", { task: run.team.taskId ?? "" })}
                    </span>
                  )}
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
                  {project && (project.onDesktop || project.app?.port) && (
                    <button
                      type="button"
                      onClick={() => void openOrAddProject(project)}
                      className={BTN_SECONDARY}
                      data-testid="coding-agent-project-open-app"
                    >
                      {project.onDesktop ? t("codingAgent.open") : t("launcher.addToDesktop")}
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
              {/* While the run works: ONE card with three tabs — the timeline
                  (first, and the default), the terminal tailing the transcript,
                  and the browser the run drives (a picture only, with a way to
                  the VNC app for the real thing). One at a time: the three
                  stacked were three screens tall. Once the run has settled,
                  the timeline alone is the record. */}
              {isLive(run.status) && (() => {
                const command = run.transcriptPath
                  ? livePreviewCommand({ transcriptPath: run.transcriptPath, sessionId: run.sessionId ?? null, directory: run.directory, live: true })
                  : null;
                const tab = liveTabFor?.id === run.id ? liveTabFor.tab : "timeline";
                const pick = (next: "timeline" | "terminal" | "browser") => setLiveTabFor({ id: run.id, tab: next });
                const tabButton = (id: "timeline" | "terminal" | "browser", icon: string, label: string, disabled = false) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    aria-controls={`coding-agent-live-pane-${id}`}
                    disabled={disabled}
                    onClick={() => pick(id)}
                    data-testid={`coding-agent-live-tab-${id}`}
                    className={tab === id ? SEGMENT_ON : SEGMENT_OFF}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{icon}</span>
                    {label}
                  </button>
                );
                return (
                  <div className={`mt-3 ${CARD_SURFACE} overflow-hidden flex flex-col`} data-testid="coding-agent-live-card" data-tab={tab}>
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] bg-black/30 shrink-0">
                      <div className={`${SEGMENTED_TRACK} max-w-md`} role="tablist" aria-label={t("codingAgent.timelineTitle")}>
                        {tabButton("timeline", "timeline", t("codingAgent.timelineTitle"))}
                        {tabButton("terminal", "terminal", t("codingAgent.livePreviewTitle"), !command)}
                        {tabButton("browser", "web", t("codingAgent.browserPreviewTitle"))}
                      </div>
                      <span className="ml-auto" />
                      {tab === "terminal" && command && (
                        <button
                          type="button"
                          onClick={() => openInTerminal(run)}
                          data-testid="coding-agent-run-terminal-open"
                          className="text-[11px] px-2 py-0.5 rounded-md border border-white/10 text-[var(--text-muted)] hover:bg-white/5 cursor-pointer"
                        >
                          {t("codingAgent.livePreviewOpenApp")}
                        </button>
                      )}
                      {tab === "browser" && (
                        <button
                          type="button"
                          onClick={() => dispatchOpenApp("vnc")}
                          data-testid="coding-agent-open-vnc"
                          className="text-[11px] px-2 py-0.5 rounded-md border border-white/10 text-[var(--text-muted)] hover:bg-white/5 cursor-pointer"
                        >
                          {t("codingAgent.openVnc")}
                        </button>
                      )}
                    </div>
                    <div id="coding-agent-live-pane-timeline" role="tabpanel" hidden={tab !== "timeline"} className="px-4 py-3">
                      <CodingRunTimeline
                        lines={activity}
                        times={activityAt}
                        startedAt={run.startedAt}
                        live
                        embedded
                        working={{
                          label: t("codingAgent.chatWorking"),
                          busy: t("codingAgent.chatBusy"),
                          tokens: (run.tokensUsed ?? 0) > 0 ? `${tokens(run.tokensUsed ?? 0)} ${t("codingAgent.tokensWord")}` : undefined,
                          duration: started ? duration(run) : undefined,
                        }}
                      />
                    </div>
                    {command && (
                      // Mounted whatever the tab, hidden otherwise: the terminal
                      // types its command once, and a remount would tail from the top.
                      <div id="coding-agent-live-pane-terminal" role="tabpanel" hidden={tab !== "terminal"} style={{ height: 460, background: "#0d0d1a" }} data-testid="coding-agent-run-terminal">
                        <TerminalApp key={run.id} initialCommand={command} />
                      </div>
                    )}
                    {tab === "browser" && (
                      <div id="coding-agent-live-pane-browser" role="tabpanel" className="h-[420px] bg-black" data-testid="coding-agent-browser-preview" data-open="true">
                        <VNCApp viewOnly pasteButton="hidden" />
                      </div>
                    )}
                  </div>
                );
              })()}
              {!isLive(run.status) && <CodingRunTimeline lines={activity} times={activityAt} startedAt={run.startedAt} live={false} />}

              {/* The summary is the run's closing message, and that is
                  markdown. Drawn through the chat's renderer, which builds
                  elements from the text and never injects HTML — what lets
                  agent-written words on to the owner's screen at all. */}
              <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`}>
                <p className={SECTION_LABEL}>{t("codingAgent.summaryTitle")}</p>
                <CodingRunSummary
                  key={run.id}
                  runId={run.id}
                  report={reportFile?.name ?? null}
                  summary={run.summary}
                  live={isLive(run.status)}
                />
              </div>

              {/* The plan, as the run last wrote it. */}
              {todos.length > 0 && (
                <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid="coding-agent-run-plan">
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

              {/* The agents: the run itself and every helper it sent out —
                  the ones still working, and the ones back with how long
                  they took. The owner asked to see how many and what each
                  did, not a count. */}
              {(isLive(run.status) || run.team || (run.activeSubagents?.length ?? 0) > 0 || (run.subagents?.length ?? 0) > 0 || (run.subagentsTotal ?? 0) > 0) && (
                <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid="coding-agent-run-agents">
                  <p className={SECTION_LABEL}>
                    {t("codingAgent.agentsTitle")}
                    <span className="normal-case tracking-normal font-normal text-[var(--text-secondary)]" data-testid="coding-agent-run-agents-count">
                      {t("codingAgent.agentsWorking", { n: isLive(run.status) ? 1 + (run.activeSubagents?.length ?? 0) : 0 })}
                      {" · "}
                      {t("codingAgent.agentsFinished", { n: (run.subagents?.length ?? 0) + (isLive(run.status) ? 0 : 1) })}
                      {(run.subagentsTotal ?? 0) > 0 && ` · ${helpers.map(([k, n]) => `${n}× ${k}`).join(", ")}`}
                    </span>
                  </p>
                  <ul className="mt-2 space-y-1" data-testid="coding-agent-active-subagents">
                    <li className="flex items-start gap-2 text-[11px]">
                      <span className={`material-symbols-rounded shrink-0 ${isLive(run.status) ? "text-amber-400 animate-pulse" : "text-[var(--text-muted)]"}`} style={{ fontSize: 13 }} aria-hidden="true">{isLive(run.status) ? "sync" : "check_circle"}</span>
                      <span className="text-[var(--text-primary)] font-medium shrink-0">{t("codingAgent.agentMain")}</span>
                      <span className="text-[var(--text-muted)] break-words min-w-0">{run.model ?? run.modelsUsed?.[0] ?? ""}{started ? ` · ${duration(run)}` : ""}</span>
                    </li>
                    {run.activeSubagents?.map((a, i) => (
                      <li key={`live-${i}`} className="flex items-start gap-2 text-[11px]" data-testid="coding-agent-subagent-live">
                        <span className="material-symbols-rounded text-sky-400 animate-pulse shrink-0" style={{ fontSize: 13 }} aria-hidden="true">sync</span>
                        <span className="text-sky-300 font-medium shrink-0">{a.type}</span>
                        <span className="text-[var(--text-muted)] break-words min-w-0">{a.description}</span>
                        <span className="ml-auto shrink-0 text-[var(--text-muted)]">{t("codingAgent.helperFor", { t: elapsedShort(a.startedAt, now) })}</span>
                      </li>
                    ))}
                    {[...(run.subagents ?? [])].reverse().map((a, i) => (
                      <li key={`done-${i}`} className="flex items-start gap-2 text-[11px]" data-testid="coding-agent-subagent-done" data-refused={a.refused || undefined}>
                        <span className={`material-symbols-rounded shrink-0 ${a.refused ? "text-amber-400" : "text-emerald-400/80"}`} style={{ fontSize: 13 }} aria-hidden="true">{a.refused ? "block" : "check_circle"}</span>
                        <span className={`font-medium shrink-0 ${a.refused ? "text-amber-300" : "text-emerald-300/90"}`}>{a.type}</span>
                        <span className="text-[var(--text-muted)] break-words min-w-0">{a.description}</span>
                        <span className="ml-auto shrink-0 text-[var(--text-muted)]">{a.refused ? t("codingAgent.helperRefused") : t("codingAgent.helperFor", { t: elapsedShort(a.startedAt, a.endedAt) })}</span>
                      </li>
                    ))}
                  </ul>
                  {run.team && (
                    <CodingRunTeamMembers
                      key={`${run.id}/${run.team.id}`}
                      teamId={run.team.id}
                      runId={run.id}
                      runs={runs.map((r) => ({ id: r.id, status: r.status }))}
                      live={isLive(run.status)}
                      onOpenRun={showRun}
                    />
                  )}
                </div>
              )}

              {run.error && (
                <div className="mt-3 rounded-xl bg-red-500/[0.06] border border-red-500/30 px-4 py-3" data-testid="coding-agent-run-error">
                  <p className="text-[11px] font-medium text-red-300">{t("codingAgent.errorTitle")}</p>
                  <pre className="mt-1 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words font-sans leading-relaxed">{run.error}</pre>
                </div>
              )}

                </div>
                <aside className="min-w-0" data-testid="coding-agent-run-rail">
              {/* The figures. */}
              <div className="mt-3 grid grid-cols-2 @md:grid-cols-4 @3xl:grid-cols-2 gap-2" data-testid="coding-agent-run-figures">
                <StatTile label={t("codingAgent.statSteps")} value={started ? String(run.numTurns) : "—"} />
                <StatTile label={t("codingAgent.statFiles")} value={String(run.filesTouched.length)} testId="coding-agent-stat-files" />
                <StatTile label={t("codingAgent.statDuration")} value={started ? duration(run) : "—"} />
                <StatTile
                  label={t("codingAgent.statTokens")}
                  value={(run.tokensUsed ?? 0) > 0 ? <AnimatedNumber value={run.tokensUsed ?? 0} format={tokens} testId="coding-agent-stat-tokens" /> : "—"}
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

              {/* The run's evidence: screenshots it took while verifying its
                  work, its report.md, and whatever test output it saved. */}
              {artifacts.length > 0 && (
                <div className={`mt-3 ${CARD_SURFACE} px-4 py-3`} data-testid="coding-agent-artifacts" data-folded={artifactsFolded || undefined}>
                  <div className="flex items-center justify-between gap-2">
                    <p className={SECTION_LABEL}>
                      {t("codingAgent.artifactsTitle")}
                      <span className="ml-1.5 normal-case tracking-normal font-normal text-[var(--text-muted)]">({artifacts.length})</span>
                    </p>
                    {artifacts.length > ARTIFACT_PREVIEW && (
                      <button
                        type="button"
                        onClick={() => setArtifactsOpenFor(artifactsFolded ? run.id : null)}
                        aria-expanded={!artifactsFolded}
                        data-testid="coding-agent-artifacts-toggle"
                        className="text-[11px] text-[var(--text-secondary)] hover:text-white underline decoration-white/20"
                      >
                        {artifactsFolded ? t("codingAgent.artifactsShowAll", { n: artifacts.length }) : t("codingAgent.artifactsShowFewer")}
                      </button>
                    )}
                  </div>
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
                              the text it was made from is in the run's report.
                              The file name IS the label — several players can
                              sit in this list, and "audio" three times over
                              tells a screen-reader user nothing about which
                              is which (the same fix ChatPopup's audioLabel is). */}
                          <audio controls preload="none" aria-label={a.name} src={artifactUrl(run.id, a.name)} className="h-8 max-w-full" />
                        </div>
                      ))}
                    </div>
                  )}
                  {files.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {files.map((a) => (
                        <li key={a.name} className="text-[11px]">
                          <a
                            href={artifactUrl(run.id, a.name)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--text-secondary)] hover:text-white underline decoration-white/20 break-all"
                          >
                            {a.name}
                          </a>
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
        {view.face === "project" && (() => {
          const p = view.project;
          const projectQuery = p.kind === "codeProject"
            ? `projectId=${encodeURIComponent(p.folder)}`
            : `directory=${encodeURIComponent(p.directory)}`;
          const projectLive = runs.some((r) => runBelongsTo(r, p) && isLive(r.status));
          // The pull request for the branch the project is on: one opened from
          // this page, or one a run opened for that same branch.
          const runPr = git?.branch ? runs.find((r) => runBelongsTo(r, p) && r.pr?.url && r.pr.number && r.pr.branch === git.branch)?.pr : undefined;
          const projectPr = projectPrs[p.directory] ?? (runPr?.url && runPr.number ? { number: runPr.number, url: runPr.url } : null);
          const lastSubject = git?.lastCommit?.subject ?? p.lastCommit?.subject ?? null;
          const lastDate = git?.lastCommit?.date ?? p.lastCommit?.date ?? null;
          return (<>
            <CodingAgentBreadcrumb
              crumbs={[
                { label: t("codingAgent.projectsTitle"), onClick: () => setOpenProjectDir(null), testId: "coding-agent-crumb-projects" },
                { label: p.name },
              ]}
              onBack={() => setOpenProjectDir(null)}
              backLabel={t("codingAgent.back")}
            navLabel={t("codingAgent.breadcrumbLabel")}
              backTestId="coding-agent-project-back"
            />
            <div className="mt-3 flex-1 min-h-0 flex flex-col" data-testid="coding-agent-project-page">
              {/* One row: who this is and what it is. The folder under it is
                  one tap to copy — the home row no longer carries that. */}
              <div className="flex items-center gap-2 flex-wrap">
                <ProjectIcon project={p} size="w-7 h-7" />
                <h2 className="text-sm font-semibold text-[var(--text-primary)] break-words">{p.name}</h2>
                {p.kind === "codeProject" && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-[var(--text-muted)] border-white/20">
                    {t("codingAgent.codeProject")}
                  </span>
                )}
                {p.onDesktop && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-sky-300 border-sky-400/40">
                    {t("codingAgent.onDesktop")}
                  </span>
                )}
                {projectLive && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 text-amber-400 border-amber-400/40">
                    {t("codingAgent.runInProgress")}
                  </span>
                )}
                {p.onDesktop && (
                  <button
                    type="button"
                    onClick={() => dispatchOpenApp(installedAppId(p.folder))}
                    className={`${BTN_SECONDARY} ml-auto`}
                  >
                    {t("codingAgent.open")}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => void copyFolder(p.directory)}
                title={t("codingAgent.copyFolder")}
                aria-label={t("codingAgent.copyFolder")}
                data-testid="coding-agent-project-copy"
                className="mt-1 flex items-center gap-1 text-[11px] font-mono text-[var(--text-muted)] opacity-70 hover:opacity-100 hover:text-white"
              >
                {p.directory}
                <span className="material-symbols-rounded" style={{ fontSize: 12 }} aria-hidden="true">
                  {copiedFolder === p.directory ? "check" : "content_copy"}
                </span>
                {copiedFolder === p.directory && <span className="font-sans">{t("codingAgent.copied")}</span>}
              </button>
              {/* The git state on ONE line: branch, commits, the newest
                  commit, and whether the folder has reached GitHub — the
                  store road starts there. */}
              <div className={`mt-3 ${INSET_SURFACE} px-3 py-1.5 flex items-center gap-x-2 gap-y-1 flex-wrap text-[11px] text-[var(--text-muted)]`} data-testid="coding-agent-git-info">
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">account_tree</span>
                {git?.branch && <span className="font-mono text-[var(--text-primary)]">{git.branch}</span>}
                {git && <span>{t("codingAgent.gitCommits", { n: git.commits })}</span>}
                <span className="break-all">
                  {lastSubject && lastDate ? <>{firstLine(lastSubject, 70)} · {timeAgo(lastDate, t)}</> : t("codingAgent.noCommits")}
                </span>
                <span className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                  {/* On GitHub: the repository's page, and the way to a pull
                      request for the branch the project is on (or the one
                      already open for it). Not yet: a quiet Back up, the one
                      road there — the green button it used to be shouted over
                      the whole page. */}
                  {githubWebUrl(git?.remote) ? (
                    <>
                      <a
                        href={githubWebUrl(git?.remote) ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        title={t("codingAgent.openOnGithub")}
                        data-testid="coding-agent-project-github"
                        className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--text-secondary)] hover:text-white underline decoration-white/20"
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
                        {githubRepoName(git?.remote)}
                      </a>
                      {projectPr ? (
                        <a href={projectPr.url} target="_blank" rel="noreferrer" data-testid="coding-agent-project-pr" className={BTN_SECONDARY}>
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">merge</span>
                          {t("codingAgent.viewPr", { n: projectPr.number })}
                        </a>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void createPr({ projectId: p.kind === "codeProject" ? p.folder : null, directory: p.directory }, `project-${p.folder}`)}
                          disabled={busy === `pr-project-${p.folder}`}
                          data-testid="coding-agent-project-create-pr"
                          className={BTN_SECONDARY}
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">merge</span>
                          {busy === `pr-project-${p.folder}` ? t("codingAgent.createPrBusy") : t("codingAgent.createPr")}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {git?.remote
                        ? <span className="font-mono break-all">{git.remote}</span>
                        : <span>{t("codingAgent.gitNoRemote")}</span>}
                      {!git?.remote && github?.connected && (git?.lastCommit || p.lastCommit) && (
                        <button
                          type="button"
                          onClick={() => void backup({ projectId: p.kind === "codeProject" ? p.folder : null, directory: p.directory }, `project-${p.folder}`)}
                          disabled={busy === `backup-project-${p.folder}`}
                          data-testid="coding-agent-project-backup"
                          className="text-[11px] text-[var(--text-secondary)] hover:text-white underline decoration-white/20 disabled:opacity-50"
                        >
                          {busy === `backup-project-${p.folder}` ? t("codingAgent.backupBusy") : t("codingAgent.backup")}
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>
              {/* Four tabs, each with the whole width: the folder, what changed,
                  the runs, the team. The runs sat in a 22rem rail before and
                  their rows wrapped three deep. */}
              <CodingProjectWorkspace
                key={projectQuery}
                query={projectQuery}
                live={projectLive}
                fill
                filesDirectory={!standalone && p.kind === "folder" ? p.directory : undefined}
                runsCount={visibleRuns.length}
                runsLive={projectLive}
                runs={<div className="pt-1" data-testid="coding-agent-project-runs">{runsList}</div>}
                team={(
                  /* Keyed by the WHOLE scope the card reads by — the folder
                     and the code-project id — so a project that changes kind
                     under the same folder is a fresh card, never one holding
                     the previous team. */
                  <div className="pt-1">
                    <CodingTeamCard
                      key={`${p.directory}|${p.kind === "codeProject" ? p.folder : ""}`}
                      directory={p.directory}
                      projectId={p.kind === "codeProject" ? p.folder : null}
                      onOpenRun={(id) => showRun(id)}
                      onPlan={standalone ? undefined : () => openNewAppCard({ project: p.directory, team: true })}
                    />
                  </div>
                )}
              />
            </div>
          </>);
        })()}

        {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
      </div>
      </div>

    </div>
  );
}
