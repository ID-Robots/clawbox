"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { estimateRunProgress } from "@/lib/coding-agent-progress";
import { isLive, type CodingRunStatus } from "@/lib/coding-agent-status";
import { useT } from "@/lib/i18n";
import StatusMessage from "./StatusMessage";
import CodingAgentReportPreview from "./CodingAgentReportPreview";
import CodingAgentSettingsPanel from "./CodingAgentSettingsPanel";
import RunProgressBar, { RUN_TONE } from "./RunProgressBar";
import { formatBytes } from "@/lib/format-bytes";
import { renderText } from "@/lib/chat-markdown";
import { artifactUrl } from "@/lib/use-coding-agent-activity";
import {
  buildNewAppPrompt,
  DEFAULT_NEW_APP_TEMPLATE,
  NEW_APP_TEMPLATES,
  dispatchChatMessage,
  dispatchOpenApp,
  onCodingAgentChanged,
  onStandaloneAppPage,
  type NewAppTemplate,
} from "@/lib/ui-events";
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
  todos?: { status?: string }[];
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
  /** The run's evidence folder — screenshots, test output and its report.md.
   *  `markdown` is the kind that opens rendered in the app; every other
   *  non-image opens as the plain text the route serves it as. */
  artifacts?: { name: string; bytes: number; kind: "image" | "markdown" | "text" | "other" }[];
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
  latestRun: Pick<Run, "id" | "status" | "task" | "startedAt" | "completedAt"> | null;
}

/**
 * The longest name the wizard accepts — the same bound as
 * assertProjectName in src/lib/code-projects.ts (MAX_PROJECT_NAME_LENGTH),
 * which is what refuses the name once the assistant scaffolds the project.
 * Checked here so the owner hears it before the handoff, not from a tool
 * error in the chat. Exported so a test can pin the two together; a client
 * component cannot import the library constant, which pulls in fs.
 */
export const NEW_APP_NAME_MAX = 60;
/** The select's option label per starter — the order and default live in ui-events. */
const NEW_APP_TEMPLATE_LABEL: Record<NewAppTemplate, string> = {
  nextjs: "codingAgent.newTemplateNextjs",
  react: "codingAgent.newTemplateReact",
  app: "codingAgent.newTemplateApp",
  blank: "codingAgent.newTemplateBlank",
};

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

/** "just now" / "4m ago" / "2h ago" — how fresh the record is. */
function since(ms: number | undefined): string | null {
  if (!ms) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function firstLine(text: string, max = 100): string {
  const line = text.split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Single-quote a value for the terminal command line. */
function quoted(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * The canned smoke task the Test harness button dispatches: one tiny page,
 * verified through the browser stack, in a dedicated scratch project. It
 * exercises the whole delegation pipeline — spawn, brief, browser MCP,
 * vision description, evidence folder, summary — and says so plainly, so the
 * "a short task is not a small task" bar in the brief does not inflate it.
 */
const HARNESS_TEST_PROJECT = "harness-test";
const HARNESS_TEST_TASK =
  "Harness self-test — a smoke test of the tooling, not a real feature. "
  + "Make index.html in this folder show the text HARNESS OK, centered, white on #1a1a2e, nothing else. "
  + "Then open it with browser_view_local and confirm the description shows that text. "
  + "Keep it minimal and fast: no polish, no extra features, no sub-agents. "
  + "Report what you built and what the description confirmed.";

/** The Settings link, whichever element it renders as. */
const OPEN_SETTINGS_CLASS =
  "flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 shrink-0 no-underline";

/** A run belongs to the project whose folder it worked in — or, for a code
 *  project, the one it was pointed at by id (its folder is under the checkout). */
function runBelongsTo(r: Run, pr: Project): boolean {
  return r.directory === pr.directory || (pr.kind === "codeProject" && r.projectId === pr.folder);
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
 */
function useProjectGit(project: Project | null): GitInfo | null {
  const [git, setGit] = useState<{ dir: string; info: GitInfo } | null>(null);
  const dir = project?.directory ?? null;
  const query = !project
    ? null
    : project.kind === "codeProject"
      ? `projectId=${encodeURIComponent(project.folder)}`
      : `directory=${encodeURIComponent(project.directory)}`;
  useEffect(() => {
    if (!dir || !query) return;
    let gone = false;
    fetch(`/setup-api/coding-agent/git?${query}`, { cache: "no-store" })
      .then(async (res) => (res.ok ? res.json() : null))
      .then((data) => { if (!gone && data?.git) setGit({ dir, info: data.git }); })
      .catch(() => { /* the page simply shows no git block */ });
    return () => { gone = true; };
  }, [dir, query]);
  return git && git.dir === dir ? git.info : null;
}

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
  const [expanded, setExpanded] = useState<string | null>(null);
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
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newWhat, setNewWhat] = useState("");
  const [newTemplate, setNewTemplate] = useState<NewAppTemplate>(DEFAULT_NEW_APP_TEMPLATE);
  const [newError, setNewError] = useState<string | null>(null);
  const [handed, setHanded] = useState(false);
  // Clearing is two clicks, not a browser confirm(): the second click is the
  // confirmation, and collapsing the list takes the offer back.
  const [confirmClear, setConfirmClear] = useState(false);
  // Which face the window shows — see `view` below. The settings page sits
  // over whichever project was open, so Back returns there.
  const [page, setPage] = useState<"home" | "settings">("home");
  const [openProjectDir, setOpenProjectDir] = useState<string | null>(null);

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

  // A running run changes every few seconds; nothing else here does.
  const anyRunning = runs.some((r) => isLive(r.status));
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [anyRunning, load]);

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
   */
  const openInTerminal = (run: Run) => {
    let command: string;
    if (run.status === "running" && run.transcriptPath) {
      command = `${CLAWBOX_ROOT}/scripts/coding-run-preview ${quoted(run.transcriptPath)}`;
    } else if (run.sessionId) {
      command = `cd ${quoted(run.directory)} && claude-ds --resume ${run.sessionId}`;
    } else {
      command = `cd ${quoted(run.directory)}`;
    }
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
      await fetch("/setup-api/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "init", projectId: HARNESS_TEST_PROJECT, name: "Harness Test" }),
      }).catch(() => { /* the run request reports anything that matters */ });
      const res = await fetch("/setup-api/coding-agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: HARNESS_TEST_PROJECT, task: HARNESS_TEST_TASK }),
      });
      if (!res.ok) throw new Error(await readError(res, t("codingAgent.harnessTestFailed")));
      const data = await res.json() as { run?: { id?: string } };
      setShowRuns(true);
      pendingLiveOpen.current = data.run?.id ?? null;
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
      setConfirmClear(false);
      setExpanded(null);
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
    action: "pause" | "resume" | "start" | "stop" | "draft",
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

  const openNew = () => {
    setShowNew(true);
    setHanded(false);
    setNewError(null);
  };

  const closeNew = () => {
    setShowNew(false);
    setNewError(null);
  };

  /**
   * Create: check what the assistant would refuse, compose the one message,
   * hand it to the chat, and get out of the way. No fetch here on purpose —
   * the run route is the assistant's to call, with the project it has just
   * scaffolded, and the owner is in the chat to see it happen.
   */
  const createNew = () => {
    const name = newName.trim();
    const what = newWhat.trim();
    const maxWhat = status?.maxTaskChars ?? 4_000;
    if (!name) return setNewError(t("codingAgent.newNameRequired"));
    if (name.length > NEW_APP_NAME_MAX) return setNewError(t("codingAgent.newNameTooLong", { max: NEW_APP_NAME_MAX }));
    if (!what) return setNewError(t("codingAgent.newWhatRequired"));
    if (what.length > maxWhat) return setNewError(t("codingAgent.newWhatTooLong", { max: maxWhat }));
    dispatchChatMessage(buildNewAppPrompt({ name, description: what, template: newTemplate }));
    setShowNew(false);
    setNewError(null);
    setNewName("");
    setNewWhat("");
    setNewTemplate(NEW_APP_TEMPLATES[0]);
    setHanded(true);
  };

  const openProject = useMemo(
    () => (openProjectDir ? projects.find((pr) => pr.directory === openProjectDir) ?? null : null),
    [projects, openProjectDir],
  );
  const git = useProjectGit(openProject);
  /** The runs a face lists: the open project's own, or — on home — only
   *  those that match no listed project. */
  const visibleRuns = useMemo(() => (
    openProject
      ? runs.filter((r) => runBelongsTo(r, openProject))
      : runs.filter((r) => !projects.some((pr) => runBelongsTo(r, pr)))
  ), [runs, projects, openProject]);
  /**
   * Which face the window shows. Three, exclusive: the settings page sits
   * over whichever project was open, and the project face carries its
   * project so the markup below never re-finds it.
   */
  const view = page === "settings"
    ? { face: "settings" as const }
    : openProject
      ? { face: "project" as const, project: openProject }
      : { face: "home" as const };

  // A window, not a card: keep the app's own background on screen while the
  // first fetch lands, rather than flashing whatever is behind it.
  if (loading) return <div className="h-full bg-[var(--bg-deep)]" data-testid="coding-agent-panel" />;

  const readiness = status?.readiness;
  const checks: { label: string; ok: boolean; okText: string; badText: string }[] = readiness
    ? [
      { label: t("codingAgent.claudeCode"), ok: readiness.claudeInstalled, okText: t("codingAgent.installed"), badText: t("codingAgent.missing") },
      { label: t("codingAgent.wrapper"), ok: readiness.wrapperInstalled, okText: t("codingAgent.installed"), badText: t("codingAgent.missing") },
      { label: t("codingAgent.clawai"), ok: readiness.clawaiConnected, okText: t("codingAgent.connected"), badText: t("codingAgent.notConnected") },
    ]
    : [];

  const statusLabel = (s: Run["status"]) => t(`codingAgent.status${s.charAt(0).toUpperCase()}${s.slice(1)}`);

  return (
    // @container so the panel sizes to its WINDOW, not the viewport — this is
    // a desktop window the owner can resize independently of the screen.
    <div className="h-full flex flex-col bg-[var(--bg-deep)] text-white overflow-y-auto @container" data-testid="coding-agent-panel">
      <div className="mx-auto w-full max-w-2xl px-5 py-4">

        {/* One row: what this is, whether it is on, and where to change that.
            The switch itself lives in Settings now; the chip is read-only and
            says what the route said. */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">smart_toy</span>
            <h1 className="text-sm font-semibold text-[var(--text-primary)]">{t("codingAgent.title")}</h1>
            {status && (
              <span
                data-testid="coding-agent-state"
                className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${
                  status.enabled ? "text-emerald-400 border-emerald-400/40" : "text-[var(--text-muted)] border-white/20"
                }`}
              >
                {status.enabled ? t("codingAgent.stateOn") : t("codingAgent.stateOff")}
              </span>
            )}
          </div>
          {/* On the desktop this opens the Settings window on our section.
              On /app/coding — the page a phone lands on from "Open in new
              tab" — there is no desktop listening, so it is a real link to
              the standalone Settings page instead; a button that dispatched
              into silence would leave the owner with no way to the switch. */}
          {/* The settings live IN this app now — one button, both contexts. */}
          <button
            type="button"
            onClick={() => { setPage(view.face === "settings" ? "home" : "settings"); }}
            data-testid="coding-agent-open-settings"
            aria-expanded={view.face === "settings"}
            className={OPEN_SETTINGS_CLASS}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">settings</span>
            {t("codingAgent.openSettings")}
          </button>
        </div>

        {view.face === "settings" && (
          <div className="mt-3" data-testid="coding-agent-embedded-settings">
            <button
              type="button"
              onClick={() => setPage("home")}
              data-testid="coding-agent-settings-back"
              className="mb-2 flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-muted)] hover:bg-white/5"
            >
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">arrow_back</span>
              {t("codingAgent.back")}
            </button>
            <CodingAgentSettingsPanel />
            {/* Owner tools that used to sit on the runs list: the canned
                smoke run and the history sweep live with the settings now. */}
            <div className="flex items-center justify-between mt-3">
              <button
                type="button"
                onClick={() => void testHarness()}
                disabled={busy === "harness-test" || anyRunning || !status?.enabled || !status?.ready}
                data-testid="coding-agent-harness-test"
                className="text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50"
              >
                {t("codingAgent.harnessTest")}
              </button>
              {runs.length > 0 && (
                <button
                  type="button"
                  onClick={() => (confirmClear ? void clearRuns() : setConfirmClear(true))}
                  disabled={busy === "clear"}
                  data-testid="coding-agent-clear"
                  className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50 ${
                    confirmClear
                      ? "border-red-400/40 text-red-300 hover:bg-red-400/10"
                      : "border-white/10 text-[var(--text-muted)] hover:bg-white/5"
                  }`}
                >
                  {confirmClear ? t("codingAgent.clearConfirm") : t("codingAgent.clearRuns")}
                </button>
              )}
            </div>
          </div>
        )}

        {view.face === "home" && (<>
        {/* Nothing at all when the harness is fine. A row that always says
            "Ready" is a row that never tells the owner anything; the checklist
            appears only when something is actually missing. */}
        {readiness && !readiness.ready && (
          <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-3 py-2">
            {readiness.ready ? null : (
              <>
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
              </>
            )}
          </div>
        )}

        {/* The front door: one button, straight into the wizard whose handoff
            lands in the OpenClaw chat as a run task. Sized like a control, not
            a banner — the owner asked for it smaller. */}
        {!standalone && !showNew && (
          <button
            type="button"
            onClick={openNew}
            data-testid="coding-agent-new"
            className="mt-4 inline-flex items-center gap-2 btn-gradient text-white rounded-lg font-semibold text-sm px-4 py-2 shadow-md shadow-[rgba(249,115,22,0.2)] transition hover:brightness-110"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">add_circle</span>
            {t("codingAgent.createNewProject")}
          </button>
        )}

        {/* The projects, and the way to start one. */}
        <div className="mt-4" data-testid="coding-agent-projects-section">
          <div className="flex items-center justify-between gap-2 px-1">
            <h2 className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
              <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 16 }} aria-hidden="true">folder</span>
              {t("codingAgent.projectsTitle")}
              {projects.length > 0 && <span className="text-[var(--text-muted)]">({projects.length})</span>}
            </h2>

          </div>

          {standalone && (
            <p className="mt-2 px-1 text-[11px] text-[var(--text-muted)]" data-testid="coding-agent-new-needs-desktop">
              {t("codingAgent.newNeedsDesktop")}
            </p>
          )}

          {showNew && (
            <form
              onSubmit={(e) => { e.preventDefault(); createNew(); }}
              data-testid="coding-agent-new-card"
              className="mt-2 rounded-xl bg-white/[0.03] border border-[var(--coral-bright)]/30 px-3 py-3 space-y-2.5"
            >
              <p className="text-xs font-medium text-[var(--text-primary)]">{t("codingAgent.newTitle")}</p>
              <label className="block text-[11px] text-[var(--text-muted)]">
                {t("codingAgent.newNameLabel")}
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setNewError(null); }}
                  maxLength={NEW_APP_NAME_MAX}
                  placeholder={t("codingAgent.newNamePlaceholder")}
                  autoFocus
                  data-testid="coding-agent-new-name"
                  className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:outline-none focus:border-[var(--coral-bright)]/60"
                />
              </label>
              <label className="block text-[11px] text-[var(--text-muted)]">
                {t("codingAgent.newWhatLabel")}
                <textarea
                  value={newWhat}
                  onChange={(e) => { setNewWhat(e.target.value); setNewError(null); }}
                  maxLength={status?.maxTaskChars ?? 4_000}
                  rows={3}
                  placeholder={t("codingAgent.newWhatPlaceholder")}
                  data-testid="coding-agent-new-what"
                  className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]/60 focus:outline-none focus:border-[var(--coral-bright)]/60 resize-y"
                />
              </label>
              <label className="block text-[11px] text-[var(--text-muted)]">
                {t("codingAgent.newTemplateLabel")}
                <select
                  value={newTemplate}
                  onChange={(e) => setNewTemplate(e.target.value as NewAppTemplate)}
                  data-testid="coding-agent-new-template"
                  className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2.5 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--coral-bright)]/60"
                >
                  {NEW_APP_TEMPLATES.map((tpl) => (
                    <option key={tpl} value={tpl}>
                      {t(NEW_APP_TEMPLATE_LABEL[tpl])}
                    </option>
                  ))}
                </select>
              </label>
              {newError && (
                <p className="text-[11px] text-amber-400" role="alert" data-testid="coding-agent-new-error">{newError}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeNew}
                  data-testid="coding-agent-new-cancel"
                  className="text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-muted)] hover:bg-white/5"
                >
                  {t("cancel")}
                </button>
                <button
                  type="submit"
                  data-testid="coding-agent-new-create"
                  className="text-[11px] px-3 py-1 rounded-lg bg-[var(--coral-bright)] text-black font-medium hover:opacity-90"
                >
                  {t("codingAgent.newCreate")}
                </button>
              </div>
            </form>
          )}

          {handed && !showNew && (
            <p className="mt-2 px-1 text-xs text-emerald-400" role="status" data-testid="coding-agent-new-handed">
              {t("codingAgent.newHanded")}
            </p>
          )}

          {projects.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] mt-2 px-1" data-testid="coding-agent-projects-empty">
              {projectsDir ? t("codingAgent.noProjects", { folder: projectsDir }) : t("codingAgent.projectFolderUnset")}
            </p>
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
                    onClick={() => setOpenProjectDir(project.directory)}
                    className="rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-3 py-2 flex items-start justify-between gap-3 cursor-pointer hover:bg-white/[0.06] transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
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
                          ? <>{firstLine(project.lastCommit.subject, 80)} · {since(project.lastCommit.date)}</>
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
                        className="text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 shrink-0"
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
                    className="ml-auto text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 shrink-0"
                  >
                    {t("codingAgent.open")}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => void copyFolder(view.project.folder)}
                className="mt-1 flex items-center gap-1 text-[11px] font-mono text-[var(--text-muted)] opacity-70 hover:opacity-100 hover:text-white"
              >
                {view.project.directory}
                <span className="material-symbols-rounded" style={{ fontSize: 12 }} aria-hidden="true">
                  {copiedFolder === view.project.folder ? "check" : "content_copy"}
                </span>
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
                    ? <>{firstLine(git.lastCommit.subject, 90)} · {since(git.lastCommit.date)}</>
                    : (view.project.lastCommit ? <>{firstLine(view.project.lastCommit.subject, 90)} · {since(view.project.lastCommit.date)}</> : t("codingAgent.noCommits"))}
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
                    className="mt-2 text-xs px-2.5 py-1 rounded-lg border border-emerald-400/40 text-emerald-400 hover:bg-emerald-400/10 disabled:opacity-50"
                  >
                    {busy === `backup-project-${view.project.folder}` ? t("codingAgent.backupBusy") : t("codingAgent.backup")}
                  </button>
                )}
              </div>
            </div>
          </div>

        {/* The runs: on the project's own page — home stays a clean list of
            projects, as the owner asked. */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => { setShowRuns((v) => !v); setConfirmClear(false); setRunsShown(RUNS_PAGE); }}
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
                  const details = [run.error, run.summary].filter(Boolean).join("\n\n");
                  const artifacts = run.artifacts ?? [];
                  const open = expanded === run.id;
                  const tone = RUN_TONE[run.status];
                  const action = RUN_ACTION[run.status];
                  return (
                    <li key={run.id} className="rounded-xl bg-white/[0.03] border border-[var(--border-subtle)] px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded-full px-2 py-0.5 ${tone.chip}`}>
                              {statusLabel(run.status)}
                            </span>
                            {/* Only while they are actually out: a count that
                                lingers at 0 is noise on every finished run. */}
                            {/* A run at high effort can be silent for minutes
                                on its first turn. Show that it is thinking, so
                                quiet never reads as stuck. */}
                            {run.status === "running" && (run.thinkingTokens ?? 0) > 0 && (
                              <span
                                data-testid="coding-agent-thinking"
                                className="text-[10px] font-semibold border rounded-full px-2 py-0.5 text-violet-300 border-violet-400/40"
                              >
                                {t("codingAgent.thinking", { n: run.thinkingTokens ?? 0 })}
                              </span>
                            )}
                            {/* One green dot per sub-agent, so the fan-out is
                                visible at a glance rather than read as a
                                number. Filled while working, hollow once done. */}
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
                                      i < (run.subagentsActive ?? 0)
                                        ? "bg-emerald-400 animate-pulse"
                                        : "bg-emerald-400/35"
                                    }`}
                                  />
                                ))}
                                <span className="text-[10px] font-semibold text-emerald-400 ml-0.5">
                                  {run.subagentsTotal}
                                </span>
                              </span>
                            )}
                            {run.projectId && <span className="text-[11px] text-[var(--text-muted)]">{run.projectId}</span>}
                            <span className="text-[11px] font-mono text-[var(--text-muted)] opacity-60">{run.id}</span>
                          </div>
                          <p className="text-xs text-[var(--text-primary)] mt-1 break-words">{firstLine(run.task, 80)}</p>
                          <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                            {t("codingAgent.runMeta", { turns: run.numTurns, files: run.filesTouched.length, duration: duration(run) })}
                            {" · "}
                            {run.source === "owner" ? t("codingAgent.startedByOwner") : t("codingAgent.startedByAgent")}
                            {run.effort && ` · ${t(`codingAgent.effort.${run.effort}`)}`}
                            {(run.tokensUsed ?? 0) > 0 && ` · ${tokens(run.tokensUsed ?? 0)} ${t("codingAgent.tokensWord")}`}
                            {(run.subagentsTotal ?? 0) > 0
                              && ` · ${Object.entries(run.subagentsByType ?? {}).map(([k, n]) => `${n}× ${k}`).join(", ")}`}
                            {run.permissionDenials > 0 && (
                              <span className="text-amber-400"> · {t("codingAgent.denials", { n: run.permissionDenials })}</span>
                            )}
                          </p>
                          {isLive(run.status) && (
                            <RunProgressBar
                              estimate={estimateRunProgress(run, Date.now())}
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
                              {run.lastActivityAt && `${t("codingAgent.updated")} ${since(run.lastActivityAt)}`}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {/* A held run: its first action, then the way out
                              of it — a draft is discarded, anything with a
                              process or a session behind it is stopped. */}
                          {action && (
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => runAction(run.id, action.route, t(action.failed))}
                                disabled={busy === run.id}
                                data-testid={`coding-agent-${action.route}-${run.id}`}
                                className={`${RUN_BUTTON} ${action.className}`}
                              >
                                {t(action.label)}
                              </button>
                              {run.status === "draft" ? (
                                <button
                                  type="button"
                                  onClick={() => runAction(run.id, "draft", t("codingAgent.discardFailed"), { method: "DELETE" })}
                                  disabled={busy === run.id}
                                  data-testid={`coding-agent-discard-${run.id}`}
                                  className={`${RUN_BUTTON} border-white/10 text-[var(--text-muted)] hover:bg-white/5`}
                                >
                                  {t("codingAgent.discardDraft")}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => runAction(run.id, "stop", t("codingAgent.stopFailed"))}
                                  disabled={busy === run.id}
                                  className={`${RUN_BUTTON} border-white/10 text-[var(--text-primary)] hover:bg-white/5`}
                                >
                                  {t("codingAgent.stop")}
                                </button>
                              )}
                            </div>
                          )}
                          {/* Straight into the session: a live tail while it
                              works, or --resume once it has finished. */}
                          {github?.connected && run.commit && (
                            <button
                              type="button"
                              onClick={() => void backup({ projectId: run.projectId, directory: run.directory }, run.id)}
                              disabled={busy === `backup-${run.id}`}
                              data-testid={`coding-agent-backup-${run.id}`}
                              className="text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 disabled:opacity-50"
                            >
                              {busy === `backup-${run.id}` ? t("codingAgent.backupBusy") : t("codingAgent.backup")}
                            </button>
                          )}
                          {run.status !== "draft" && (
                          <button
                            type="button"
                            onClick={() => openInTerminal(run)}
                            data-testid={`coding-agent-terminal-${run.id}`}
                            title={run.status === "running" ? t("codingAgent.openLive") : t("codingAgent.openResume")}
                            className="text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
                          >
                            {run.status === "running" ? t("codingAgent.openLive") : t("codingAgent.openResume")}
                          </button>
                          )}
                          {(details || artifacts.length > 0) && (
                            <button
                              type="button"
                              onClick={() => setExpanded(open ? null : run.id)}
                              aria-expanded={open}
                              className="text-xs px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5"
                            >
                              {open ? t("codingAgent.hideDetails") : t("codingAgent.showDetails")}
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Which helpers are out and what each is doing — a
                          count alone does not say whether the run is stuck on
                          one search or fanned across three files. */}
                      {(run.activeSubagents?.length ?? 0) > 0 && (
                        <ul className="mt-2 space-y-1" data-testid="coding-agent-active-subagents">
                          {run.activeSubagents?.map((a, i) => (
                            <li key={i} className="flex items-start gap-2 text-[11px]">
                              <span className="material-symbols-rounded text-sky-400 animate-pulse shrink-0" style={{ fontSize: 13 }} aria-hidden="true">
                                sync
                              </span>
                              <span className="text-sky-300 font-medium shrink-0">{a.type}</span>
                              <span className="text-[var(--text-muted)] break-words min-w-0">{a.description}</span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* What was refused, spelled out. The count alone said
                          "1 action was not allowed" and left the owner to
                          guess which — and the answer is usually a command
                          shape worth knowing about. */}
                      {open && (run.deniedActions?.length ?? 0) > 0 && (
                        <div className="mt-2" data-testid="coding-agent-denied">
                          <p className="text-[11px] font-medium text-amber-400">
                            {t("codingAgent.deniedTitle")}
                          </p>
                          <ul className="mt-1 space-y-0.5">
                            {run.deniedActions?.map((d, i) => (
                              <li key={i} className="text-[11px] font-mono text-[var(--text-muted)] break-all">{d}</li>
                            ))}
                          </ul>
                          <p className="text-[11px] text-[var(--text-muted)] opacity-60 mt-1 leading-relaxed">
                            {t("codingAgent.deniedHelp")}
                          </p>
                        </div>
                      )}

                      {/* The run's evidence: screenshots it took while
                          verifying its work, its report.md, and whatever test
                          output it saved. Images render as thumbnails; a
                          markdown file opens rendered in the app's own
                          dialog; every other file opens in a new tab as the
                          plain text the route serves it as. */}
                      {open && artifacts.length > 0 && (() => {
                        const images = artifacts.filter((a) => a.kind === "image");
                        const files = artifacts.filter((a) => a.kind !== "image");
                        return (
                          <div className="mt-2" data-testid="coding-agent-artifacts">
                            <p className="text-[11px] font-medium text-sky-300">
                              {t("codingAgent.artifactsTitle")}
                            </p>
                            {images.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-2">
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
                                    <img
                                      src={artifactUrl(run.id, a.name)}
                                      alt={a.name}
                                      loading="lazy"
                                      className="h-20 w-auto max-w-[10rem] object-cover"
                                    />
                                  </a>
                                ))}
                              </div>
                            )}
                            {files.length > 0 && (
                              <ul className="mt-1.5 space-y-0.5">
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
                        );
                      })()}

                      {open && run.error && (
                        <pre className="mt-2 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words font-sans leading-relaxed">
                          {run.error}
                        </pre>
                      )}
                      {/* The summary is the run's closing message, and that is
                          markdown — "## What I built", a table of files. Drawn
                          through the chat's renderer, the same one the
                          assistant's replies use, so it reads like the chat
                          instead of like a wall of hashes and pipes. The
                          renderer builds elements from the text and never
                          injects HTML, which is what lets agent-written words
                          on to the owner's screen at all. The renderer's own
                          tables and code blocks scroll sideways inside
                          themselves; min-w-0 keeps a long token from widening
                          the row past the window. */}
                      {open && run.summary && (
                        <div
                          data-testid="coding-agent-summary"
                          className="mt-2 text-xs text-[var(--text-secondary)] leading-relaxed max-h-64 overflow-y-auto min-w-0 break-words [&_img]:max-w-full"
                        >
                          {renderText(run.summary, t("chat.table"))}
                        </div>
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
              className="w-full mt-2 px-3 py-1.5 rounded-lg border border-white/[0.08] text-[11px] text-[var(--text-muted)] hover:bg-white/5"
            >
              {t("codingAgent.more")} ({visibleRuns.length - runsShown})
            </button>
          )}
        </div>
        </>)}

        {error && <div className="mt-3"><StatusMessage type="error" message={error} /></div>}
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
