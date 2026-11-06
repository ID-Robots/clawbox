/**
 * The Coding Agent app has NO inputs (the 2026-10-30 redesign, the owner:
 * "delete all inputs from the coding agent ui" — "the chat composes, the app
 * shows"). Home, a project's page on each of its three tabs, a run's page live
 * and settled, and a team's page draw not one `input`, `textarea`, `select` or
 * contenteditable element: a task is composed in the chat's Create card, a
 * correction is a draft in the chat composer (`dispatchOpenChat`), a file is
 * edited in the Files app, and a folder is picked from a listing.
 *
 * The exceptions, named here so the rule stays honest: the Settings page
 * (`CodingAgentSettingsPanel`, the consent face — the effort and role selects,
 * the commit-author fields, the GitHub and provider cards), the first-run
 * wizard (`CodingAgentSetupWizard`, the same consent as a flow) and the
 * project page's Tools fold AFTER the owner taps Change (the MCP-server
 * checklist, `CodingProjectMcpServersCard`, kept as inputs because the route
 * behind it refuses the agent — a sentence in the chat must not grant a run a
 * tool the owner never ticked; `coding-agent-app.test.tsx` pins that the fold
 * is closed on open). The Settings case below is the positive control: the
 * same query finds fields THERE, so a green run on the other faces means
 * "none drawn", not "nothing looked".
 *
 * Realistic fixtures on purpose: a team at work with a chart on home, a live
 * run with its three-tab live card, a settled run with a result, files
 * touched, a commit, a PR and a worktree, a project with a tree, an open file
 * and a Changes tab with a commit log — the states where a field used to sit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentApp from "@/components/CodingAgentApp";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));
// xterm and noVNC never render in jsdom; the live card only needs to know it
// embedded them. Neither mock draws a field, as neither real one does: the
// terminal is a canvas and the browser pane is a view-only picture.
vi.mock("@/components/TerminalApp", () => ({ default: () => <div data-testid="terminal-mock" /> }));
vi.mock("@/components/VNCApp", () => ({ default: () => <div data-testid="vnc-mock" /> }));

const FIELDS = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
/** Every field on the page, named so a failure says which one came back. */
function fields(): string[] {
  return Array.from(document.body.querySelectorAll(FIELDS)).map((el) => {
    const id = el.getAttribute("data-testid") ?? el.getAttribute("id") ?? el.getAttribute("name") ?? "";
    return `${el.tagName.toLowerCase()}${id ? `#${id}` : ""}`;
  });
}

const NOW = Date.now();
const DIR = "/srv/projects/site";
const SITE = {
  folder: "site", directory: DIR, kind: "codeProject", name: "My Site",
  lastCommit: { subject: "Coding agent: add a dark mode toggle", date: NOW - 3 * 3600_000 },
  onDesktop: true, latestRun: null, iconUrl: null,
  app: { name: "My Site", description: "A site", kind: "static", port: null },
};
const SHOP = { ...SITE, folder: "shop", directory: "/srv/projects/shop", kind: "folder", name: "My Shop", onDesktop: false, app: null };

const DONE = {
  id: "run-done0001", task: "Add a dark mode toggle\n\nKeep the palette; the toggle lives in the header.", directory: DIR, projectId: "site",
  source: "agent", status: "completed", startedAt: NOW - 900_000, completedAt: NOW - 60_000,
  summary: "Added the toggle in index.html. Verify by opening the page.", error: null,
  numTurns: 14, maxTurns: 2000, tokensUsed: 48_120, filesTouched: ["index.html", "app.js", "styles.css"], permissionDenials: 0,
  progress: ["Reading index.html", "Writing app.js", "$ npm test"], progressAt: [NOW - 890_000, NOW - 600_000, NOW - 120_000],
  commit: "abc1234def5678",
  pr: {
    phase: "merged", number: 12, url: "https://github.com/owner/site/pull/12", branch: "clawbox/run-done0001", base: "master",
    checks: { total: 2, passed: 2, failed: 0, pending: 0 }, detail: null, startedAt: NOW - 500_000, endedAt: NOW - 70_000, reviewOk: true, foundBy: "opened",
  },
  worktree: { path: "/srv/projects/.worktrees/run-done0001", branch: "clawbox/run-done0001", base: "master", project: DIR, removed: false },
  artifacts: [{ name: "report.md", bytes: 120, kind: "markdown" }, { name: "shot-1.png", bytes: 20_480, kind: "image" }],
  effort: "max", provider: "anthropic",
};
const LIVE = {
  ...DONE, id: "run-live00001", task: "Wire the settings drawer", status: "running", completedAt: null, summary: null,
  commit: null, pr: null, worktree: null, artifacts: [], numTurns: 3, tokensUsed: 2_400,
  progress: ["Reading index.html", "Writing drawer.js"], progressAt: [NOW - 50_000, NOW - 5_000],
  transcriptPath: "/srv/harness/projects/x/s.jsonl",
  plan: [{ text: "Read the layout", done: true }, { text: "Add the drawer", done: false }],
};
const TEAM = {
  id: "team-live000001", goal: "Ship the toggle and the settings drawer", projectId: "site", directory: DIR, source: "agent", status: "working",
  plannerRunId: "run-plan00001", branch: "clawbox/team-live000001", base: "master",
  runs: [{ id: "run-plan00001", role: "planner", taskId: null }, { id: LIVE.id, role: "worker", taskId: "t2" }],
  agents: { planner: 1, workers: 1, reviewers: 0, total: 2 },
  tasks: [
    { task_id: "t1", task_description: "Settings drawer", assigned_to: null, status: "complete", result: "done", depends_on: [], review: { verdict: "accepted", notes: "", at: NOW - 100_000 }, attempts: 1 },
    { task_id: "t2", task_description: "Toggle", assigned_to: LIVE.id, status: "in_progress", result: null, depends_on: ["t1"], review: null, attempts: 1 },
  ],
  log: [{ ts: NOW - 200_000, actor: { kind: "owner" }, type: "team_created", message: "Team created", payload: null }],
  alerts: 0, error: null, shape: null, repoMap: null, singleRun: false, dynamic: false, lastLeadAt: 0, finalReview: null, pr: null,
  createdAt: NOW - 200_000, updatedAt: NOW - 5_000, finishedAt: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubBox() {
  const runs = [LIVE, DONE];
  const teams = [TEAM];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const q = new URL(url, "http://box").searchParams;
    if (url.startsWith("/setup-api/coding-agent/status")) {
      return json({
        enabled: true, ready: true, readiness: { ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true, problems: [] },
        running: 1, harnessCommand: "claude-ds", maxTaskChars: 4000, defaultDirectory: "/srv/projects", setupComplete: true,
        effort: "max", effortLevels: ["low", "xhigh", "max", "ultracode"], reviewPass: false, historyRetention: "standard",
      });
    }
    if (url === "/setup-api/ai-models/status") return json({ clawaiConfigured: true, clawaiAccountTier: "flash" });
    if (url.startsWith("/setup-api/coding-agent/runs?history=1")) return json({ runs: [], total: 0, offset: 0 });
    if (url.startsWith("/setup-api/coding-agent/runs?id=")) {
      const run = runs.find((r) => r.id === q.get("id"));
      return run ? json({ run }) : json({ error: "no such run" }, 404);
    }
    if (url.startsWith("/setup-api/coding-agent/runs")) return json({ runs });
    if (url.startsWith("/setup-api/coding-agent/team?id=")) {
      const team = teams.find((x) => x.id === q.get("id"));
      return team ? json({ team }) : json({ error: "no such team" }, 404);
    }
    if (url.startsWith("/setup-api/coding-agent/team")) return json({ teams });
    if (url.startsWith("/setup-api/coding-agent/projects")) return json({ directory: "/srv/projects", projects: [SITE, SHOP] });
    if (url.startsWith("/setup-api/coding-agent/tree?") && q.get("file")) {
      return json({ file: { path: q.get("file"), content: "<!doctype html>\n<h1>Hi</h1>\n", size: 28, truncated: false, binary: false } });
    }
    if (url.startsWith("/setup-api/coding-agent/tree?")) {
      return json({ listing: { path: q.get("path") ?? "", truncated: false, entries: [
        { name: "src", type: "directory", size: null, modified: null },
        { name: "index.html", type: "file", size: 120, modified: null },
      ] } });
    }
    if (url.startsWith("/setup-api/coding-agent/git?")) {
      if (url.includes("changes=1")) {
        return json({
          changes: { available: true, truncated: false, additions: 4, deletions: 1, files: [{ path: "index.html", status: "modified", additions: 4, deletions: 1 }] },
          log: [{ sha: "abc1234def5678", subject: "Add a dark mode toggle", date: NOW - 60_000 }, { sha: "0123456789abcdef", subject: "Initial commit", date: NOW - 86_400_000 }],
        });
      }
      if (q.get("diff")) return json({ diff: { path: q.get("diff"), text: "--- a/index.html\n+++ b/index.html\n@@ -1 +1 @@\n-<h1>Hi</h1>\n+<h1>Hello</h1>\n", binary: false, truncated: false } });
      return json({ git: { branch: "master", commits: 12, remote: "git@github.com:owner/site.git", lastCommit: { subject: "Add a dark mode toggle", date: NOW - 60_000 } } });
    }
    if (url === "/setup-api/coding-agent/git") return json({ installed: true, connected: true, login: "owner", loginCommand: "gh auth login" });
    if (url.startsWith("/setup-api/coding-agent/artifacts")) {
      if ((q.get("file") ?? "").endsWith("report.md")) return new Response("# Result\n\nThe toggle works.", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      return json({ error: "There is no such artifact.", kind: "not_found" }, 404);
    }
    if (url === "/setup-api/users/me") return json({ user: null });
    if (init?.method && init.method !== "GET") return json({ ok: true });
    return json({ error: "unexpected" }, 404);
  }));
}

async function openProject() {
  fireEvent.click(await screen.findByTestId("coding-agent-project-site"));
  return screen.findByTestId("coding-agent-project-page");
}

async function openRun(id: string) {
  await openProject();
  await screen.findByTestId(`coding-agent-run-row-${id}`);
  fireEvent.click(screen.getByTestId(`coding-agent-details-${id}`));
  return screen.findByTestId("coding-agent-run-page");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Coding Agent app draws no inputs (the 2026-10-30 rule)", () => {
  it("home: the Now cards, a team's chart and the project rows", async () => {
    stubBox();
    render(<CodingAgentApp />);
    await screen.findByTestId("coding-agent-projects");
    // The team at work is a card with the real chart on it, the live run is
    // drawn inside it — the states that once came with a task box.
    await screen.findByTestId(`coding-agent-live-team-${TEAM.id}`);
    expect(screen.getByTestId("coding-agent-project-site")).toBeInTheDocument();
    expect(fields()).toEqual([]);
  });

  it("a project's page: Activity, then Files with a file open, then Changes with a commit chosen", async () => {
    stubBox();
    render(<CodingAgentApp />);
    const page = await openProject();
    await within(page).findByTestId(`coding-team-row-${TEAM.id}`);
    await within(page).findByTestId(`coding-agent-run-row-${DONE.id}`);
    expect(fields()).toEqual([]);

    fireEvent.click(screen.getByTestId("coding-agent-workspace-files"));
    const tree = await screen.findByTestId("coding-agent-file-tree");
    fireEvent.click(await within(tree).findByTestId("coding-agent-tree-index.html"));
    // The viewer is read-only: the shared editor without `onChange` draws no textarea.
    await screen.findByTestId("coding-agent-file-view");
    await waitFor(() => expect(screen.getByTestId("coding-agent-file-view")).toHaveTextContent("Hi"));
    expect(fields()).toEqual([]);

    fireEvent.click(screen.getByTestId("coding-agent-workspace-changes"));
    await screen.findByTestId("coding-agent-change-label");
    // Newer / Older stand where the commit <select> used to.
    await waitFor(() => expect(screen.getByTestId("coding-agent-change-older")).toBeInTheDocument());
    expect(screen.queryByTestId("coding-agent-change-picker")).toBeNull();
    expect(fields()).toEqual([]);
  });

  it("a live run's page, on each tab of its live card", async () => {
    stubBox();
    render(<CodingAgentApp />);
    const page = await openRun(LIVE.id);
    expect(page).toHaveAttribute("data-live", "true");
    await within(page).findByTestId("coding-agent-live-card");
    expect(fields()).toEqual([]);
    for (const tab of ["terminal", "browser", "timeline"]) {
      fireEvent.click(within(page).getByTestId(`coding-agent-live-tab-${tab}`));
      expect(fields()).toEqual([]);
    }
    // Steering is a draft in the chat composer, not a box on this page.
    expect(within(page).getByTestId("coding-agent-run-message")).toBeInTheDocument();
  });

  it("a settled run's page: result, what changed, the worktree line, the commit and the PR", async () => {
    stubBox();
    render(<CodingAgentApp />);
    const page = await openRun(DONE.id);
    await within(page).findByTestId("coding-agent-summary");
    await within(page).findByTestId("coding-agent-run-changed");
    // The Details fold opened too: the run id with its copy button is text and a button.
    const more = within(page).getByTestId("coding-agent-run-more");
    fireEvent.click(more.querySelector("summary")!);
    expect(fields()).toEqual([]);
  });

  it("a team's page: the chart, the tasks, the PR card and Details", async () => {
    stubBox();
    render(<CodingAgentApp />);
    const project = await openProject();
    const row = await within(project).findByTestId(`coding-team-row-${TEAM.id}`);
    fireEvent.click(within(row).getByText(TEAM.goal));
    const page = await screen.findByTestId("coding-agent-team-page");
    await within(page).findByTestId("coding-team-task-t1");
    expect(within(page).getAllByTestId("coding-team-diagram")).toHaveLength(1);
    const details = within(page).getByTestId("coding-team-details");
    fireEvent.click(details.querySelector("summary")!);
    expect(fields()).toEqual([]);
  });

  it("the named exception: Settings keeps its fields, which is also how this file knows it is looking", async () => {
    stubBox();
    render(<CodingAgentApp />);
    await screen.findByTestId("coding-agent-projects");
    fireEvent.click(screen.getByTestId("coding-agent-open-settings"));
    await screen.findByTestId("coding-agent-settings-panel");
    await waitFor(() => expect(fields().length).toBeGreaterThan(0));
  });
});
