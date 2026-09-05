import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// The Coding Agent app's project page and run page, on a real desktop against
// a mocked device: a project's files and changes beside its runs (the Claude
// Code web layout), the one breadcrumb every page but home carries, the
// browser preview above a live run's terminal, and the Live view that fills
// the window with both. The routes the workspace reads are answered here
// rather than in the shared helper, because this is the only spec that walks
// them and the helper's device has no projects on purpose.

const PROJECT = {
  folder: "site",
  directory: "/home/clawbox/projects/site",
  kind: "folder",
  name: "My Site",
  lastCommit: { subject: "Coding agent: add a dark mode toggle", date: Date.now() - 3600_000 },
  onDesktop: false,
  latestRun: null,
};

const RUN = {
  id: "run-e2e00001",
  task: "Add a dark mode toggle",
  directory: PROJECT.directory,
  projectId: null,
  source: "agent",
  status: "running",
  startedAt: Date.now() - 60_000,
  completedAt: null,
  summary: null,
  error: null,
  numTurns: 2,
  filesTouched: [],
  permissionDenials: 0,
  progress: ["$ npm test"],
  transcriptPath: "/home/clawbox/.claude-ds/projects/x/s.jsonl",
};

test.beforeEach(async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      ai_model_configured: true,
      telegram_configured: false,
    },
  });
  // Registered after the helper's catch-all, so these answer first. The
  // helper's device has the agent switched off and its setup unfinished,
  // which lands the app on its wizard; this one is on, ready and set up.
  await page.route("**/setup-api/coding-agent/status*", (route) =>
    route.fulfill({ json: {
      enabled: true, ready: true, running: 0, setupComplete: true,
      readiness: { ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true, problems: [] },
      harnessCommand: "claude-ds", maxTaskChars: 4000, defaultDirectory: "/home/clawbox/projects",
      effort: "ultracode", effortLevels: ["low", "xhigh", "max", "ultracode"], reviewPass: false,
    } }));
  await page.route("**/setup-api/coding-agent/projects*", (route) =>
    route.fulfill({ json: { directory: "/home/clawbox/projects", projects: [PROJECT] } }));
  await page.route("**/setup-api/coding-agent/runs*", (route) => route.fulfill({ json: { runs: [RUN] } }));
  await page.route("**/setup-api/coding-agent/tree*", (route) => {
    const url = new URL(route.request().url());
    const file = url.searchParams.get("file");
    if (file !== null) {
      return route.fulfill({ json: { file: { path: file, content: "<h1>Hi</h1>\n<p>there</p>\n", size: 24, truncated: false, binary: false } } });
    }
    const p = url.searchParams.get("path") ?? "";
    const entries = p === ""
      ? [{ name: "src", type: "directory", size: null, modified: null }, { name: "index.html", type: "file", size: 24, modified: null }]
      : [{ name: "app.js", type: "file", size: 3, modified: null }];
    return route.fulfill({ json: { listing: { path: p, truncated: false, entries } } });
  });
  await page.route("**/setup-api/coding-agent/git?*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("diff")) {
      return route.fulfill({ json: { diff: { path: "index.html", diff: "@@ -1 +1 @@\n-<h1>Hello</h1>\n+<h1>Hi</h1>", truncated: false, binary: false } } });
    }
    if (url.searchParams.has("changes")) {
      return route.fulfill({ json: {
        changes: { available: true, truncated: false, additions: 1, deletions: 1, files: [{ path: "index.html", status: "modified", additions: 1, deletions: 1 }] },
        log: [{ sha: "a".repeat(40), subject: "Coding agent: add a dark mode toggle", date: Date.now() - 3600_000 }],
      } });
    }
    return route.fulfill({ json: { git: { branch: "main", commits: 3, remote: null, lastCommit: PROJECT.lastCommit } } });
  });
});

test("a project's page carries its files and changes, and a run's page its breadcrumb, browser preview and live view", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await page.getByTestId("shelf-app-coding").click();
  const win = page.getByTestId("chrome-window-coding");
  await expect(win).toBeVisible();

  // Home: a lean row, no folder path on it.
  const row = win.getByTestId("coding-agent-project-site");
  await expect(row).toContainText("My Site");
  await expect(row).not.toContainText(PROJECT.directory);
  await row.click();

  // The project page: the git line, then the workspace.
  await expect(win.getByTestId("coding-agent-project-page")).toBeVisible();
  await expect(win.getByTestId("coding-agent-breadcrumb")).toContainText("My Site");
  await expect(win.getByTestId("coding-agent-git-info")).toContainText("main");
  await expect(win.getByTestId("coding-agent-project-copy")).toContainText(PROJECT.directory);
  const tree = win.getByTestId("coding-agent-file-tree");
  await expect(tree.getByTestId("coding-agent-tree-src")).toBeVisible();
  await tree.getByTestId("coding-agent-tree-src").click();
  await expect(tree.getByTestId("coding-agent-tree-src/app.js")).toBeVisible();
  await tree.getByTestId("coding-agent-tree-index.html").click();
  await expect(win.getByTestId("coding-agent-file-view")).toContainText("<p>there</p>");

  await win.getByTestId("coding-agent-workspace-changes").click();
  await expect(win.getByTestId("coding-agent-change-totals")).toContainText("Files changed: 1");
  await win.getByTestId("coding-agent-change-index.html").click();
  const diff = win.getByTestId("coding-agent-diff");
  await expect(diff).toContainText("+<h1>Hi</h1>");
  await expect(diff.locator("[data-diff-line=del]")).toHaveText("-<h1>Hello</h1>");

  // The run, from the project's own list.
  await win.getByTestId("coding-agent-details-run-e2e00001").click();
  const runPage = win.getByTestId("coding-agent-run-page");
  await expect(runPage).toBeVisible();
  await expect(win.getByTestId("coding-agent-crumb-project")).toHaveText("My Site");
  await expect(win.getByTestId("coding-agent-browser-preview")).toBeVisible();
  await expect(win.getByTestId("coding-agent-run-terminal")).toBeVisible();

  // Live view: the screen over the terminal, nothing else.
  await win.getByTestId("coding-agent-run-live-view").click();
  await expect(runPage).toHaveAttribute("data-live-view", "true");
  await expect(win.getByTestId("coding-agent-live-view")).toBeVisible();
  await expect(win.getByTestId("coding-agent-run-rail")).toHaveCount(0);
  await win.getByTestId("coding-agent-run-live-view").click();
  await expect(win.getByTestId("coding-agent-run-rail")).toBeVisible();

  // Back leads to the project, and the first crumb home.
  await win.getByTestId("coding-agent-run-back").click();
  await expect(win.getByTestId("coding-agent-project-page")).toBeVisible();
  await win.getByTestId("coding-agent-crumb-projects").click();
  await expect(win.getByTestId("coding-agent-project-site")).toBeVisible();
});
