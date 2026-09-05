/**
 * The Coding Agent app (src/components/CodingAgentApp.tsx), opened from the
 * desktop icon of the same name.
 *
 * The app shows the owner whether the agent is on, what a run needs and what
 * recent runs did, using the real English strings so a missing key fails
 * here rather than on screen. The switch and the other settings live in
 * Settings → Coding Agent now (coding-agent-settings-panel.test.tsx); the
 * app only links there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentApp, { installedAppId, NEW_APP_NAME_MAX } from "@/components/CodingAgentApp";
import { MAX_PROJECT_NAME_LENGTH } from "@/lib/code-projects";
import { CHAT_MESSAGE_EVENT, CODING_AGENT_CHANGED_EVENT, CODING_RUN_STARTED_EVENT, NEW_APP_EVENT, OPEN_CODING_RUN_EVENT } from "@/lib/ui-events";

// One stable `t`, as the real hook provides (it is memoised on the locale
// table) — a fresh function per render would be a different contract.
const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
// xterm never renders in jsdom; the run page only needs to know it embedded one.
vi.mock("@/components/TerminalApp", () => ({
  default: ({ initialCommand }: { initialCommand?: string }) => <div data-testid="terminal-mock" data-command={initialCommand ?? ""} />,
}));

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t }),
}));
// noVNC never connects in jsdom; the run page only needs to know it embedded
// the screen, and that it embedded it as a picture (view-only, no paste).
vi.mock("@/components/VNCApp", () => ({
  default: ({ viewOnly, pasteButton }: { viewOnly?: boolean; pasteButton?: string }) => (
    <div data-testid="vnc-mock" data-view-only={String(Boolean(viewOnly))} data-paste={pasteButton ?? "overlay"} />
  ),
}));

const READY = { ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true, problems: [] as string[] };
const NOT_READY = {
  ready: false, wrapperInstalled: true, claudeInstalled: false, clawaiConnected: true,
  problems: ["Claude Code is not installed on this ClawBox. Run: sudo bash install.sh --step coding_harness"],
};

const RUN = {
  id: "run-k3x9q2ab",
  task: "Add a dark mode toggle",
  directory: "/home/clawbox/clawbox/data/code-projects/site",
  projectId: "site",
  source: "agent",
  status: "completed",
  startedAt: Date.now() - 90_000,
  completedAt: Date.now() - 5_000,
  summary: "Added the toggle in index.html. Verify by opening the page.",
  error: null,
  numTurns: 4,
  filesTouched: ["index.html"],
  permissionDenials: 1,
  progress: [],
};

const PROJECT = {
  folder: "site",
  directory: "/home/clawbox/Projects/site",
  kind: "folder",
  name: "My Site",
  lastCommit: { subject: "Coding agent: add a dark mode toggle", date: Date.now() - 3 * 3600_000 },
  onDesktop: true,
  latestRun: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let posts: { url: string; body: unknown }[];
/** Every git-block read, query string included — which project it asked about. */
let gitReads: string[];

/** The device, as far as this component can tell. */
function stubFetch(
  // `setupComplete` defaults to true: every test below is about a box whose
  // owner has been through the wizard, which is also what the route answers
  // for any box with the switch on. Pass false to get the wizard itself.
  status: { enabled: boolean; readiness: typeof READY | typeof NOT_READY; setupComplete?: boolean },
  runsArg: unknown[] = [],
  opts: {
    artifacts?: Record<string, string>; projects?: unknown[]; projectsDir?: string | null; transcriptPath?: string;
    git?: { branch: string | null; commits: number; remote: string | null; lastCommit: { subject: string; date: number } | null };
    /** The GitHub account, as GET /setup-api/coding-agent/git answers without a query. */
    github?: Record<string, unknown>;
    /** The project's root listing, as the tree route answers it. */
    tree?: { entries: { name: string; type: "file" | "directory"; size: number | null; modified: string | null }[] };
    /** What changed, as `git?…&changes=1` answers it. */
    changes?: Record<string, unknown>;
  } = {},
) {
  let runs = runsArg;
  posts = [];
  gitReads = [];
  const projects = {
    directory: opts.projectsDir === undefined ? "/home/clawbox/Projects" : opts.projectsDir,
    projects: opts.projects ?? [],
  };
  // POST enable moves the device on — a fixture where finishing the wizard
  // left `setupComplete` false would keep the wizard on screen and could never
  // show that the home page comes back. Held as OVERRIDES rather than copies
  // so a test that mutates the object it passed in (as the CODING_AGENT_CHANGED
  // one does) still steers the answer.
  let enabledPosted: boolean | null = null;
  let setupCompletePosted: boolean | null = null;
  // undefined until a post carries the field; null is a posted "clear it".
  let directoryPosted: string | null | undefined;
  const isEnabled = () => enabledPosted ?? status.enabled;
  const payload = () => ({
    enabled: isEnabled(),
    ready: isEnabled() && status.readiness.ready,
    readiness: status.readiness,
    running: 0,
    harnessCommand: "claude-ds",
    maxTaskChars: 4000,
    // The harness self-test now runs in the owner's OWN project folder, so a
    // fixture with no default folder is a box that legitimately refuses to
    // start it. Mirrors the projects payload above, and the tests that mean
    // "nothing is set" pass projectsDir: null and get that here too.
    defaultDirectory: directoryPosted !== undefined
      ? directoryPosted
      : (opts.projectsDir === undefined ? "/home/clawbox/Projects" : opts.projectsDir),
    setupComplete: setupCompletePosted ?? status.setupComplete ?? true,
    effort: "ultracode",
    effortLevels: ["low", "xhigh", "max", "ultracode"],
    reviewPass: false,
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) return json(payload());
    if (url.startsWith("/setup-api/coding-agent/runs") && init?.method === "DELETE") {
      posts.push({ url: "/setup-api/coding-agent/runs", body: "DELETE" });
      const before = runs.length;
      // The device keeps a run still in flight, whatever was asked.
      runs = runs.filter((r) => (r as { status?: string }).status === "running");
      return json({ cleared: before - runs.length });
    }
    if (url.startsWith("/setup-api/coding-agent/runs")) return json({ runs });
    if (url.startsWith("/setup-api/coding-agent/projects")) return json(projects);
    if (url.startsWith("/setup-api/coding-agent/tree?")) {
      return json({ listing: { path: "", truncated: false, ...(opts.tree ?? { entries: [] }) } });
    }
    if (url.startsWith("/setup-api/coding-agent/git?")) {
      // The route answers `{ git }` for the one project the query names, and
      // `{ changes, log }` when the workspace's Changes tab asks.
      gitReads.push(url);
      if (url.includes("changes=1")) {
        return json({ changes: opts.changes ?? { available: true, truncated: false, additions: 0, deletions: 0, files: [] }, log: [] });
      }
      return json({ git: opts.git ?? { branch: null, commits: 0, remote: null, lastCommit: null } });
    }
    if (url === "/setup-api/coding-agent/git" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { action?: string };
      posts.push({ url, body });
      // Create PR: the branch's pull request, opened on GitHub.
      if (body.action === "pr") return json({ number: 12, url: "https://github.com/yalexx/site/pull/12", existing: false, branch: "clawbox/run-1", base: "master" });
      // A backup: the folder is pushed, private, to a repo named after it.
      return json({ repo: "owner/site", created: true });
    }
    if (url === "/setup-api/coding-agent/git") {
      return json(opts.github ?? { installed: false, connected: false, login: null, loginCommand: "gh auth login" });
    }
    if (url === "/setup-api/coding-agent/start" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { runId?: string };
      posts.push({ url, body });
      runs = runs.map((r) => {
        const run = r as { id?: string };
        return run.id === body.runId ? { ...run, status: "running", completedAt: null } : r;
      });
      return json({ started: true, run: runs.find((r) => (r as { id?: string }).id === body.runId) }, 202);
    }
    if (url.startsWith("/setup-api/coding-agent/artifacts")) {
      // The route serves every non-image as text/plain, whatever it holds.
      const file = new URL(url, "http://box").searchParams.get("file") ?? "";
      const text = opts.artifacts?.[file];
      if (text === undefined) return json({ error: "There is no such artifact.", kind: "not_found" }, 404);
      return new Response(text, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url === "/setup-api/coding-agent/stop" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ run: { ...RUN, status: "stopped" } });
    }
    if (url === "/setup-api/code" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ success: true });
    }
    if (url === "/setup-api/coding-agent/browse" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ root: "/home/clawbox", path: "/home/clawbox/Projects/harness-test", parent: "/home/clawbox/Projects", entries: [] });
    }
    if (url === "/setup-api/coding-agent/enable" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      if (typeof body.enabled === "boolean") enabledPosted = body.enabled;
      if (typeof body.setupComplete === "boolean") setupCompletePosted = body.setupComplete;
      // Held like the other overrides: the real route re-reads persisted state,
      // so a later post that says nothing about the folder keeps the saved one.
      if ("defaultDirectory" in body) directoryPosted = body.defaultDirectory as string | null;
      // The route answers the whole status, re-read after the change.
      return json(payload());
    }
    if (url === "/setup-api/coding-agent/run" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      // The started run is in the listing from the next poll on, as the
      // runner's record is on the box — carrying its transcript path when the
      // test says Claude Code has opened the file by then.
      const started = { ...RUN, id: "run-smoke001", status: "running", completedAt: null, transcriptPath: opts.transcriptPath ?? null };
      runs = [started, ...runs];
      return json({ started: true, run: started }, 202);
    }
    return json({ error: "unexpected" }, 404);
  }));
}

beforeEach(() => {
  posts = [];
  gitReads = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The runs list is behind a button now — open it the way a person would. */
/** The runs list is OPEN by default now — this only waits for it. */
/** A code project the RUN fixture belongs to — runs live on project pages now. */
const SITE_PROJECT = { ...PROJECT, kind: "codeProject" };

async function openRuns() {
  // Runs moved off home onto the project's page, into its Runs tab: enter
  // the page (once) and open the tab.
  if (!screen.queryByTestId("coding-agent-project-page")) {
    fireEvent.click(await screen.findByTestId("coding-agent-project-site"));
    await screen.findByTestId("coding-agent-project-page");
  }
  fireEvent.click(await screen.findByTestId("coding-agent-workspace-runs"));
  await screen.findByTestId("coding-agent-project-runs");
}

describe("CodingAgentApp", () => {
  it("says whether the agent is on, as the route said, and offers no switch of its own", async () => {
    stubFetch({ enabled: false, readiness: READY });
    render(<CodingAgentApp />);
    expect((await screen.findByTestId("coding-agent-state")).textContent).toBe(translations.en["codingAgent.stateOff"]);
    // The switch moved to Settings; a second one here would be a second
    // place to get the consent wrong.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-folder")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-effort")).not.toBeInTheDocument();
  });

  describe("first-run setup", () => {
    it("shows the wizard instead of the home page until setup is finished", async () => {
      // A box with no folder and no consent has nothing the home page can
      // offer — every button on it would name something that cannot happen.
      stubFetch({ enabled: false, readiness: READY, setupComplete: false });
      render(<CodingAgentApp />);
      expect(await screen.findByTestId("coding-agent-wizard")).toBeInTheDocument();
      expect(screen.queryByTestId("coding-agent-projects-section")).toBeNull();
      expect(screen.queryByTestId("coding-agent-new")).toBeNull();
    });

    it("starts the steps from the Enable button, GitHub first", async () => {
      stubFetch({ enabled: false, readiness: READY, setupComplete: false });
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-enable"));
      expect(screen.getByTestId("coding-agent-wizard-github")).toBeInTheDocument();
      // GitHub is what a run pushes with, not what it needs to start, so the
      // step can be passed without an account.
      fireEvent.click(screen.getByTestId("coding-agent-wizard-next"));
      expect(screen.getByTestId("coding-agent-wizard-folder")).toBeInTheDocument();
      expect(screen.getByTestId("coding-agent-wizard-browse")).toBeInTheDocument();
    });

    it("proposes Ultracode and says what it costs", async () => {
      stubFetch({ enabled: false, readiness: READY, setupComplete: false });
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-enable"));
      fireEvent.click(screen.getByTestId("coding-agent-wizard-next"));
      expect(screen.getByTestId("coding-agent-wizard-effort-ultracode")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("coding-agent-wizard-effort-low")).toHaveAttribute("aria-pressed", "false");
      // The owner is told before they choose, not by a bill afterwards.
      expect(screen.getByTestId("coding-agent-wizard-cost").textContent)
        .toBe(translations.en["codingAgent.wizardEffortCost"]);
    });

    it("saves the folder, the effort and the switch in ONE post, and marks setup done", async () => {
      stubFetch({ enabled: false, readiness: READY, setupComplete: false });
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-enable"));
      fireEvent.click(screen.getByTestId("coding-agent-wizard-next"));
      fireEvent.change(screen.getByTestId("coding-agent-wizard-folder"), { target: { value: "/home/clawbox/Projects" } });
      fireEvent.click(screen.getByTestId("coding-agent-wizard-next-harness"));
      await waitFor(() => expect(posts.some((p) => p.url === "/setup-api/coding-agent/enable")).toBe(true));
      const post = posts.find((p) => p.url === "/setup-api/coding-agent/enable");
      // The switch goes on here so the offered test run has an agent to run
      // on — and setup is declared UNFINISHED in the same post. Without that
      // explicit false the box has no flag, `enabled` stands in for one, and
      // the app decides setup is complete the moment the switch goes on: the
      // last step appeared for about a second and was replaced by the home
      // page.
      expect(post!.body).toEqual({
        defaultDirectory: "/home/clawbox/Projects",
        effort: "ultracode",
        reviewPass: false,
        enabled: true,
        setupComplete: false,
      });
      expect(await screen.findByTestId("coding-agent-wizard-harness-run")).toBeInTheDocument();
    });

    it("finishes on Skip without starting a run", async () => {
      stubFetch({ enabled: false, readiness: READY, setupComplete: false });
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-enable"));
      fireEvent.click(screen.getByTestId("coding-agent-wizard-next"));
      fireEvent.click(screen.getByTestId("coding-agent-wizard-next-harness"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-harness-skip"));
      await waitFor(() => expect(
        posts.filter((p) => p.url === "/setup-api/coding-agent/enable").length,
      ).toBe(2));
      // The test is an offer, not a gate: skipping completes setup and starts
      // nothing.
      expect(posts.find((p) => p.url === "/setup-api/coding-agent/run")).toBeUndefined();
      expect(posts.at(-1)!.body).toEqual({ setupComplete: true });
      expect(await screen.findByTestId("coding-agent-projects-section")).toBeInTheDocument();
    });

    it("runs the harness test and finishes when the owner asks for it", async () => {
      stubFetch({ enabled: false, readiness: READY, setupComplete: false });
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-enable"));
      fireEvent.click(screen.getByTestId("coding-agent-wizard-next"));
      fireEvent.click(screen.getByTestId("coding-agent-wizard-next-harness"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-harness-run"));
      await waitFor(() => expect(posts.some((p) => p.url === "/setup-api/coding-agent/run")).toBe(true));
      const run = posts.find((p) => p.url === "/setup-api/coding-agent/run");
      // A bare folder name, resolved inside the folder the owner just chose on
      // the previous step — not a code project under data/.
      expect((run!.body as { directory: string }).directory).toBe("harness-test");
      // ...and setup completes, so the owner lands on the home page with the
      // run already in flight — which is where its progress is shown.
      await waitFor(() => expect(posts.at(-1)!.body).toEqual({ setupComplete: true }));
    });
  });

  it("opens its own embedded settings page from the Settings button, and comes back", async () => {
    // The settings moved INTO this app (the owner asked for them back): the
    // button flips to an in-app page hosting the full settings panel — no
    // desktop event, no navigation — and Back returns to the home list.
    stubFetch({ enabled: true, readiness: READY });
    const sections: string[] = [];
    const onSection = (e: Event) => sections.push((e as CustomEvent<{ section: string }>).detail.section);
    window.addEventListener("clawbox:open-settings-section", onSection);
    try {
      render(<CodingAgentApp />);
      expect((await screen.findByTestId("coding-agent-state")).textContent).toBe(translations.en["codingAgent.stateOn"]);
      fireEvent.click(screen.getByTestId("coding-agent-open-settings"));
      expect(await screen.findByTestId("coding-agent-embedded-settings")).toBeInTheDocument();
      // Nothing was dispatched at the desktop — the page is ours now.
      expect(sections).toEqual([]);
      fireEvent.click(screen.getByTestId("coding-agent-settings-back"));
      expect(screen.queryByTestId("coding-agent-embedded-settings")).toBeNull();
    } finally {
      window.removeEventListener("clawbox:open-settings-section", onSection);
    }
  });

  it("uses the same embedded settings on /app/coding — no navigation needed anymore", async () => {
    // Before the move this had to be a real link to /app/settings, because
    // the standalone page had no desktop listening. The panel ships inside
    // the app now, so the phone gets the same button and the same page.
    stubFetch({ enabled: true, readiness: READY });
    window.history.pushState({}, "", "/app/coding");
    try {
      render(<CodingAgentApp />);
      const button = await screen.findByTestId("coding-agent-open-settings");
      expect(button.tagName).toBe("BUTTON");
      fireEvent.click(button);
      expect(await screen.findByTestId("coding-agent-embedded-settings")).toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("expands a project into its own page: project data, git block, and only its runs", async () => {
    // The home list stays clean: a project's history lives on the project's
    // page, and runs that belong to no listed project stay on home.
    const project = { ...PROJECT, kind: "codeProject", directory: "/home/clawbox/clawbox/data/code-projects/site" };
    const inRun = { ...RUN, id: "run-inproj1", task: "inside the project" };
    const outRun = { ...RUN, id: "run-outside1", task: "somewhere else", projectId: null, directory: "/tmp/elsewhere" };
    const git = {
      branch: "main", commits: 7, remote: "git@github.com:owner/site.git",
      lastCommit: { subject: "Coding agent: add a dark mode toggle", date: Date.now() - 3600_000 },
    };
    stubFetch({ enabled: true, readiness: READY }, [inRun, outRun], { projects: [project], git });
    render(<CodingAgentApp />);

    // Home lists the projects and nothing else: every run works in a folder
    // inside the project folder, and the projects route lists that folder,
    // so a run always has a project page. No runs list on home, not even for
    // a stranger.
    await screen.findByTestId("coding-agent-project-site");
    expect(screen.queryByTestId("coding-agent-runs-toggle")).toBeNull();
    expect(screen.queryByText("somewhere else")).toBeNull();
    expect(screen.queryByText("inside the project")).toBeNull();

    fireEvent.click(screen.getByTestId("coding-agent-project-site"));
    expect(await screen.findByTestId("coding-agent-project-page")).toBeInTheDocument();
    // The git block shows what the route answered — branch, commit count,
    // origin — and a code project is asked about by its id, not its folder.
    const gitInfo = screen.getByTestId("coding-agent-git-info");
    await waitFor(() => expect(gitInfo.textContent).toContain("main"));
    expect(gitInfo.textContent).toContain(t("codingAgent.gitCommits", { n: 7 }));
    // The remote is drawn as the repository's PAGE, not the push URL, and
    // beside it the way to a pull request for the branch the project is on.
    const github = within(gitInfo).getByTestId("coding-agent-project-github");
    expect(github).toHaveAttribute("href", "https://github.com/owner/site");
    expect(github.textContent).toContain("owner/site");
    expect(gitInfo.textContent).not.toContain("git@github.com");
    expect(gitInfo.textContent).not.toContain(translations.en["codingAgent.gitNoRemote"]);
    expect(within(gitInfo).getByTestId("coding-agent-project-create-pr")).toBeInTheDocument();
    expect(within(gitInfo).queryByTestId("coding-agent-project-backup")).toBeNull();
    expect(gitReads).toEqual(["/setup-api/coding-agent/git?projectId=site"]);
    // The project page lists the project's runs — in its Runs tab, with the
    // count on the tab — and not the stranger.
    expect(screen.getByTestId("coding-agent-workspace-runs").textContent).toContain("(1)");
    fireEvent.click(screen.getByTestId("coding-agent-workspace-runs"));
    expect(await screen.findByText("inside the project")).toBeInTheDocument();
    expect(screen.queryByText("somewhere else")).toBeNull();

    fireEvent.click(screen.getByTestId("coding-agent-project-back"));
    expect(screen.queryByTestId("coding-agent-project-page")).toBeNull();
    expect(screen.queryByText("inside the project")).toBeNull();
    expect(screen.queryByText("somewhere else")).toBeNull();
  });

  it("shows nothing about runs on home when every run is filed under a project", async () => {
    stubFetch({ enabled: true, readiness: READY }, [RUN], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    await screen.findByTestId("coding-agent-project-site");
    expect(screen.queryByTestId("coding-agent-runs-toggle")).toBeNull();
  });

  it("re-reads the device when Settings says it saved something", async () => {
    // The switch is another window now. Before the move the chip and the
    // switch were one component and could not disagree; the signal is what
    // keeps them agreeing across the split.
    const status = { enabled: false, readiness: READY };
    stubFetch(status);
    render(<CodingAgentApp />);
    expect((await screen.findByTestId("coding-agent-state")).textContent).toBe(translations.en["codingAgent.stateOff"]);

    status.enabled = true;
    window.dispatchEvent(new Event(CODING_AGENT_CHANGED_EVENT));
    await waitFor(() => expect(screen.getByTestId("coding-agent-state").textContent).toBe(translations.en["codingAgent.stateOn"]));
  });

  it("carries no explanatory prose in the panel body", async () => {
    // The panel read like documentation; the owner asked for it stripped.
    // Labels stay, paragraphs go.
    stubFetch({ enabled: false, readiness: READY });
    render(<CodingAgentApp />);
    await screen.findByText(translations.en["codingAgent.title"]);
    expect(screen.queryByText(/open the Terminal app and run claude-ds/)).not.toBeInTheDocument();
    expect(screen.queryByText(/works in the background inside a project folder/)).not.toBeInTheDocument();
  });

  it("reads the help behind a question mark to a screen reader, not only 'expanded'", async () => {
    // The tip is what the question mark is FOR: while it is open the button
    // must be described by it, and the reference must go when it closes.
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentApp />);
    fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
    const mark = await screen.findByTestId("coding-agent-harness-help");
    expect(mark).not.toHaveAttribute("aria-describedby");
    fireEvent.click(mark);
    const tip = screen.getByTestId("coding-agent-harness-help-text");
    expect(tip).toHaveAttribute("role", "tooltip");
    expect(tip.id).not.toBe("");
    expect(mark).toHaveAttribute("aria-describedby", tip.id);
    expect(mark).toHaveAccessibleDescription(translations.en["codingAgent.harnessTestHint"]);
    fireEvent.click(mark);
    expect(mark).not.toHaveAttribute("aria-describedby");
  });

  it("says nothing at all about readiness when the harness is fine", async () => {
    // A row that always reads "Ready" never tells the owner anything. The
    // checklist earns its space only when something is actually missing.
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentApp />);
    await screen.findByText(translations.en["codingAgent.title"]);
    expect(screen.queryByText(translations.en["codingAgent.claudeCode"])).not.toBeInTheDocument();
    expect(screen.queryByText(/ready/i)).not.toBeInTheDocument();
  });

  it("names only what is missing, and how to fix it", async () => {
    stubFetch({ enabled: true, readiness: NOT_READY });
    render(<CodingAgentApp />);
    // Claude Code is the missing one; the two that are fine are not listed.
    expect(await screen.findByText(translations.en["codingAgent.claudeCode"])).toBeInTheDocument();
    expect(screen.queryByText(translations.en["codingAgent.clawai"])).not.toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toMatch(/Claude Code is not installed/);
  });

  describe("recent runs", () => {
    it("lists the runs in the project's Runs tab, with the count on the tab, and never a toggle", async () => {
      stubFetch({ enabled: true, readiness: READY }, [RUN], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      const tab = screen.getByTestId("coding-agent-workspace-runs");
      expect(tab).toHaveAttribute("aria-selected", "true");
      expect(tab.textContent).toContain("(1)");
      expect(await screen.findByText("Add a dark mode toggle")).toBeInTheDocument();
      expect(screen.queryByTestId("coding-agent-runs-toggle")).toBeNull();
      // The other tabs keep the list mounted but hidden.
      fireEvent.click(screen.getByTestId("coding-agent-workspace-files"));
      expect(screen.getByTestId("coding-agent-project-runs").closest("[role=tabpanel]")).toHaveAttribute("hidden");
    });

    it("pages the list rather than showing an unbounded history", async () => {
      const many = Array.from({ length: 23 }, (_, i) => ({ ...RUN, id: `run-${String(i).padStart(8, "0")}`, task: `task number ${i}` }));
      stubFetch({ enabled: true, readiness: READY }, many, { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      await screen.findByTestId("coding-agent-runs");
      expect(screen.getByText("task number 0")).toBeInTheDocument();
      expect(screen.queryByText("task number 10")).not.toBeInTheDocument();

      const more = screen.getByTestId("coding-agent-runs-more");
      expect(more.textContent).toContain("13");
      fireEvent.click(more);
      expect(screen.getByText("task number 10")).toBeInTheDocument();
      expect(screen.queryByText("task number 20")).not.toBeInTheDocument();
    });

    it("opens on the button, with the outcome and the summary on demand", async () => {
      stubFetch({ enabled: true, readiness: READY }, [RUN], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      expect(await screen.findByText("Add a dark mode toggle")).toBeInTheDocument();
      expect(screen.getByText(translations.en["codingAgent.statusCompleted"])).toBeInTheDocument();
      expect(screen.getByText(/4 turns · 1 files changed/)).toBeInTheDocument();
      expect(screen.queryByText(/Added the toggle/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: translations.en["codingAgent.showDetails"] }));
      expect(await screen.findByText(/Added the toggle/)).toBeInTheDocument();
    });

    it("says a run is in flight on the Runs tab itself, without it being opened", async () => {
      stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, status: "running", completedAt: null, summary: null }], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-project-site"));
      await screen.findByTestId("coding-agent-project-page");
      expect(await screen.findByTestId("coding-agent-workspace-runs-live")).toBeInTheDocument();
    });

    it("offers Stop only for a running run and posts its id", async () => {
      stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, status: "running", completedAt: null, summary: null }], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      const stop = await screen.findByRole("button", { name: translations.en["codingAgent.stop"] });
      fireEvent.click(stop);
      await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/stop", body: { runId: "run-k3x9q2ab" } }));
    });

    it("clears the history from the settings page, but only after a second click", async () => {
      stubFetch({ enabled: true, readiness: READY }, [RUN]);
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
      const clear = await screen.findByTestId("coding-agent-clear");
      expect(clear.textContent).toBe(translations.en["codingAgent.clearRuns"]);

      // First click only arms it — history is not something to lose to a
      // mis-tap.
      fireEvent.click(clear);
      expect(clear.textContent).toBe(translations.en["codingAgent.clearConfirm"]);
      expect(posts).toEqual([]);

      fireEvent.click(clear);
      await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/runs", body: "DELETE" }));
    });

    it("offers nothing to clear when there is no history", async () => {
      stubFetch({ enabled: true, readiness: READY }, []);
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
      await screen.findByTestId("coding-agent-embedded-settings");
      // Disabled rather than removed: the owner-tools row is three equal
      // columns, and a button that vanishes leaves a hole in it. A confirmed
      // tap still cannot answer with nothing, which is what this pins.
      expect(await screen.findByTestId("coding-agent-clear")).toBeDisabled();
    });

    it("offers nothing to clear when only drafts and paused runs are left — the route keeps every one of them", async () => {
      // Before this the button stayed up over a list of held runs, and the
      // confirmed second tap cleared nothing at all, with nothing said.
      stubFetch({ enabled: true, readiness: READY }, [
        { ...RUN, id: "run-draft001", status: "draft", completedAt: null, summary: null },
        { ...RUN, id: "run-paused01", status: "paused", completedAt: null, summary: null },
      ]);
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
      await screen.findByTestId("coding-agent-embedded-settings");
      // Held runs are not history: the route keeps every one of them, so the
      // button is disabled rather than offering a tap that clears nothing.
      expect(await screen.findByTestId("coding-agent-clear")).toBeDisabled();
    });

    it("takes the armed Clear back after a few seconds, and whenever the settings page is left", async () => {
      vi.useFakeTimers();
      try {
        stubFetch({ enabled: true, readiness: READY }, [RUN]);
        render(<CodingAgentApp />);
        await act(async () => { await vi.advanceTimersByTimeAsync(50); });
        fireEvent.click(screen.getByTestId("coding-agent-open-settings"));
        const clear = screen.getByTestId("coding-agent-clear");
        fireEvent.click(clear);
        expect(clear.textContent).toBe(translations.en["codingAgent.clearConfirm"]);

        // The offer does not wait around for a stray tap minutes later.
        await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
        expect(clear.textContent).toBe(translations.en["codingAgent.clearRuns"]);
        fireEvent.click(clear);
        expect(clear.textContent).toBe(translations.en["codingAgent.clearConfirm"]);
        expect(posts).toEqual([]);

        // Leaving the page and coming back finds it disarmed too — the
        // state lives in the app, not the page, so it used to survive Back.
        fireEvent.click(screen.getByTestId("coding-agent-settings-back"));
        fireEvent.click(screen.getByTestId("coding-agent-open-settings"));
        expect(screen.getByTestId("coding-agent-clear").textContent).toBe(translations.en["codingAgent.clearRuns"]);
        expect(posts).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows no duration on a draft — its clock has not started", async () => {
      // A draft's startedAt is when it was drafted (the runner overwrites it
      // at start), so "0 turns · 0 files changed · 52m" read as a run that
      // had been going for an hour. The "updated" line already says its age.
      const draft = {
        ...RUN, id: "run-draft001", status: "draft", completedAt: null, summary: null,
        // All zero, as the server drafts them: nothing has run yet.
        numTurns: 0, filesTouched: [], permissionDenials: 0,
        effort: "max", lastActivityAt: Date.now() - 3600_000,
      };
      stubFetch({ enabled: true, readiness: READY }, [draft], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      expect(await screen.findByText(translations.en["codingAgent.statusDraft"])).toBeInTheDocument();
      expect(screen.queryByText(/0 turns/)).not.toBeInTheDocument();
      expect(screen.queryByText(/files changed/)).not.toBeInTheDocument();
      // Nor the effort it was drafted at: settings are read when it starts.
      expect(screen.getByText(translations.en["codingAgent.startedByAgent"]).textContent)
        .toBe(translations.en["codingAgent.startedByAgent"]);
      expect(screen.getByTestId("coding-agent-run-stats").textContent)
        .toContain(`${translations.en["codingAgent.updated"]} ${t("clawkeep.hoursAgo", { count: 1 })}`);
    });

    it("offers the terminal only once the run has a session — one paused before Claude Code announced it has nothing to resume", async () => {
      const noSession = { ...RUN, id: "run-paused01", status: "paused", completedAt: null, summary: null, sessionId: null };
      const session = "61400ab6-0da9-4feb-8ad5-b547239c1367";
      const withSession = { ...RUN, id: "run-paused02", status: "paused", completedAt: null, summary: null, sessionId: session };
      stubFetch({ enabled: true, readiness: READY }, [noSession, withSession], { projects: [SITE_PROJECT] });
      const opened: string[] = [];
      const onTerminal = (e: Event) => opened.push((e as CustomEvent<{ command: string }>).detail.command);
      window.addEventListener("clawbox:open-terminal", onTerminal);
      try {
        render(<CodingAgentApp />);
        await openRuns();
        const terminal = await screen.findByTestId("coding-agent-terminal-run-paused02");
        // The session-less row offered a button that only ran `cd`.
        expect(screen.queryByTestId("coding-agent-terminal-run-paused01")).not.toBeInTheDocument();
        fireEvent.click(terminal);
        // The id is quoted like the paths: run metadata typed into a shell.
        expect(opened).toEqual([`cd '${RUN.directory}' && claude-ds --resume '${session}'`]);
      } finally {
        window.removeEventListener("clawbox:open-terminal", onTerminal);
      }
    });

    it("labels a review pass with the run it reviewed, and a tap opens that run's page", async () => {
      // The record carries reviewOf but the row used to read as an ordinary
      // run whose task was a wall of the fixed review text.
      const reviewed = { ...RUN, id: "run-reviewed1" };
      const review = {
        ...RUN, id: "run-review001", reviewOf: "run-reviewed1", summary: "Nothing real was found.",
        task: "Automatic review pass. Adversarially review the work you just delivered in this folder: read the diff of your last commit",
      };
      stubFetch({ enabled: true, readiness: READY }, [review, reviewed], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      const chip = await screen.findByTestId("coding-agent-review-of");
      expect(chip.textContent).toBe(t("codingAgent.reviewOf", { id: "run-reviewed1" }));
      expect(chip.tagName).toBe("BUTTON");
      expect(screen.getByText(t("codingAgent.reviewPassTitle", { id: "run-reviewed1" }))).toBeInTheDocument();
      expect(screen.queryByText(/Adversarially review/)).not.toBeInTheDocument();
      // The reviewed run says who reviewed it.
      expect(screen.getByTestId("coding-agent-reviewed-by").textContent).toBe(t("codingAgent.reviewedBy", { id: "run-review001" }));

      expect(screen.queryByText(/Added the toggle/)).not.toBeInTheDocument();
      fireEvent.click(chip);
      // The reviewed run's own page, its summary on it — and its reviewer
      // one tap away again.
      const page = await screen.findByTestId("coding-agent-run-page");
      expect(page).toHaveAttribute("data-run-id", "run-reviewed1");
      expect(await screen.findByText(/Added the toggle/)).toBeInTheDocument();
      fireEvent.click(within(page).getByTestId("coding-agent-reviewed-by"));
      expect((await screen.findByTestId("coding-agent-run-page"))).toHaveAttribute("data-run-id", "run-review001");
      expect(await screen.findByText(/Nothing real was found/)).toBeInTheDocument();
    });

    it("tells the desktop when it starts a drafted run, so an open chat looks for it", async () => {
      const draft = { ...RUN, id: "run-draft001", status: "draft", completedAt: null, summary: null };
      stubFetch({ enabled: true, readiness: READY }, [draft], { projects: [SITE_PROJECT] });
      let heard = 0;
      const onStarted = () => { heard += 1; };
      window.addEventListener(CODING_RUN_STARTED_EVENT, onStarted);
      try {
        render(<CodingAgentApp />);
        await openRuns();
        fireEvent.click(await screen.findByTestId("coding-agent-start-run-draft001"));
        await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/start", body: { runId: "run-draft001" } }));
        await waitFor(() => expect(heard).toBe(1));
      } finally {
        window.removeEventListener(CODING_RUN_STARTED_EVENT, onStarted);
      }
    });

    it("shows the sidebar in a wide window — projects and recent runs that open their pages", async () => {
      // A window wide enough for the rail: the observer answers at once.
      const RO = class {
        private cb: ResizeObserverCallback;
        constructor(cb: ResizeObserverCallback) { this.cb = cb; }
        observe(el: Element) { this.cb([{ contentRect: { width: 1200 } } as ResizeObserverEntry], this as unknown as ResizeObserver); void el; }
        unobserve() {}
        disconnect() {}
      };
      vi.stubGlobal("ResizeObserver", RO);
      try {
        stubFetch({ enabled: true, readiness: READY }, [RUN], { projects: [SITE_PROJECT] });
        render(<CodingAgentApp />);
        const sidebar = await screen.findByTestId("coding-agent-sidebar");
        expect(within(sidebar).getByTestId("coding-agent-sidebar-home")).toHaveAttribute("aria-current", "page");
        // With the rail up there is no header row — no title, no state chip,
        // no Settings button: the rail has Settings, the window's title bar
        // names the app, and the row cost the page a row it needs for files.
        expect(screen.queryByTestId("coding-agent-open-settings")).toBeNull();
        expect(screen.queryByTestId("coding-agent-state")).toBeNull();
        expect(within(sidebar).queryByText(t("codingAgent.title"))).toBeNull();
        expect(within(sidebar).getByTestId("coding-agent-sidebar-settings")).toBeInTheDocument();
        // A project entry opens the project's page…
        fireEvent.click(within(await within(sidebar).findByTestId("coding-agent-sidebar-projects")).getByText(SITE_PROJECT.name));
        await screen.findByTestId("coding-agent-project-page");
        // …whose folder fills the column, with the runs and the team as tabs.
        expect(screen.getByTestId("coding-agent-workspace")).toHaveAttribute("data-fill", "true");
        expect(screen.getByTestId("coding-agent-workspace-runs")).toBeInTheDocument();
        expect(screen.getByTestId("coding-agent-workspace-team")).toBeInTheDocument();
        // …and a run entry the run's page.
        fireEvent.click(within(within(sidebar).getByTestId("coding-agent-sidebar-runs")).getByRole("button"));
        expect(await screen.findByTestId("coding-agent-run-page")).toHaveAttribute("data-run-id", RUN.id);
        // The run's data sits in the rail beside its story.
        expect(within(screen.getByTestId("coding-agent-run-rail")).getByTestId("coding-agent-run-figures")).toBeInTheDocument();
        // Home brings the front page back.
        fireEvent.click(within(sidebar).getByTestId("coding-agent-sidebar-home"));
        expect(screen.queryByTestId("coding-agent-run-page")).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("embeds the live terminal on a running run's page in place of the activity log, and keeps the log once it settled", async () => {
      const live = { ...RUN, status: "running", completedAt: null, summary: null, transcriptPath: "/home/clawbox/.claude-ds/projects/x/s.jsonl", progress: ["$ npm test"] };
      stubFetch({ enabled: true, readiness: READY }, [live], { projects: [SITE_PROJECT] });
      const { unmount } = render(<CodingAgentApp />);
      await openRuns();
      fireEvent.click(await screen.findByTestId("coding-agent-details-run-k3x9q2ab"));
      await screen.findByTestId("coding-agent-run-page");
      const terminal = await screen.findByTestId("coding-agent-run-terminal");
      expect(within(terminal).getByTestId("terminal-mock")).toHaveAttribute("data-command", expect.stringContaining("coding-run-preview"));
      expect(screen.queryByTestId("coding-agent-run-activity")).toBeNull();
      // The floating "Live view" is gone from the page's controls.
      expect(screen.queryByTestId("coding-agent-live-run-k3x9q2ab")).toBeNull();
      unmount();

      stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, progress: ["$ npm test"] }], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      fireEvent.click(await screen.findByTestId("coding-agent-details-run-k3x9q2ab"));
      await screen.findByTestId("coding-agent-run-page");
      expect(screen.queryByTestId("coding-agent-run-terminal")).toBeNull();
      expect(await screen.findByTestId("coding-agent-run-activity")).toBeInTheDocument();
    });

    it("opens a run's own page from its row: figures, summary, files and evidence, and Back returns", async () => {
      const run = {
        ...RUN,
        tokensUsed: 1_317_787, thinkingTokens: 658, subagentsTotal: 3, subagentsByType: { explorer: 2, reviewer: 1 },
        modelsUsed: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"], commit: "caea00d",
        deniedActions: ["Bash: curl http://example"],
        todos: [{ content: "Wire the toggle", status: "completed" }, { content: "Test it", status: "in_progress", activeForm: "Testing it" }],
        artifacts: [
          { name: "after.png", bytes: 100, kind: "image" },
          { name: "report.md", bytes: 20, kind: "markdown" },
          { name: "intro.wav", bytes: 4096, kind: "audio" },
        ],
      };
      stubFetch({ enabled: true, readiness: READY }, [run], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      fireEvent.click(await screen.findByTestId("coding-agent-details-run-k3x9q2ab"));
      const page = await screen.findByTestId("coding-agent-run-page");
      expect(page).toHaveAttribute("data-run-id", "run-k3x9q2ab");
      expect(screen.getByTestId("coding-agent-run-title").textContent).toBe("Add a dark mode toggle");
      const figures = screen.getByTestId("coding-agent-run-figures").textContent ?? "";
      expect(figures).toContain("1.3M");
      expect(figures).toContain("caea00d");
      expect(figures).toContain("2× explorer, 1× reviewer");
      expect(figures).toContain("deepseek-v4-pro[1m] + deepseek-v4-flash");
      expect(screen.getByTestId("coding-agent-summary").textContent).toContain("Added the toggle");
      // The rail carries the COUNT, not the roster. A run that touched 29
      // files filled the column with chips and told the reader nothing the
      // figure did not — and the block repeated the tile's own label
      // verbatim ("Files changed" was both `statFiles` and `filesTitle`).
      // Not asserted as "the page never names a file": the summary above
      // says "Added the toggle in index.html", and that sentence is the
      // useful mention — it is the roster in the rail that went.
      expect(screen.getByTestId("coding-agent-stat-files").textContent).toContain("1");
      expect(screen.queryByTestId("coding-agent-run-files")).toBeNull();
      expect(screen.getByTestId("coding-agent-run-plan").textContent).toContain("Testing it");
      expect(screen.getByTestId("coding-agent-denied").textContent).toContain("curl http://example");
      expect(screen.getByRole("link", { name: "after.png" })).toHaveAttribute("href", expect.stringContaining("file=after.png"));
      // A clip the run spoke, named by its file: several players can sit in
      // this list, and three unlabelled ones tell a screen-reader user nothing
      // about which is which.
      expect(within(screen.getByTestId("coding-agent-artifact-audio")).getByLabelText("intro.wav")).toBeInTheDocument();
      expect(screen.getByTestId("coding-agent-run-report")).toBeInTheDocument();
      // The project it belongs to is one tap away, and Back is the way out.
      expect(screen.getByTestId("coding-agent-run-project").textContent).toContain(SITE_PROJECT.name);
      fireEvent.click(screen.getByTestId("coding-agent-run-back"));
      expect(screen.queryByTestId("coding-agent-run-page")).toBeNull();
      expect(await screen.findByTestId("coding-agent-project-page")).toBeInTheDocument();
    });

    it("opens on the run the desktop handed it — the finish card's button — cold and while already open", async () => {
      const other = { ...RUN, id: "run-other001", task: "Something else entirely" };
      stubFetch({ enabled: true, readiness: READY }, [RUN, other], { projects: [SITE_PROJECT] });
      // Cold: the card fired before this window mounted.
      (window as Window & { __clawboxPendingCodingRun?: string }).__clawboxPendingCodingRun = "run-other001";
      render(<CodingAgentApp />);
      expect(await screen.findByTestId("coding-agent-run-page")).toHaveAttribute("data-run-id", "run-other001");
      expect(screen.getByTestId("coding-agent-run-title").textContent).toBe("Something else entirely");
      // Already open: the event alone re-points it.
      act(() => { window.dispatchEvent(new CustomEvent(OPEN_CODING_RUN_EVENT, { detail: { runId: "run-k3x9q2ab" } })); });
      expect(await screen.findByTestId("coding-agent-run-page")).toHaveAttribute("data-run-id", "run-k3x9q2ab");
    });

    /**
     * killRunLeftovers refuses a HELD run on purpose: a paused run is still
     * the owner's to resume, and what it left listening is the very thing the
     * resume carries on against. The page recorded the leftovers all the same
     * and offered the button, so the only thing it could ever do was show that
     * refusal.
     */
    it("offers to end a settled run's leftovers, and never a paused run's", async () => {
      const paused = { ...RUN, id: "run-paused01", status: "paused", completedAt: null, leftover: true };
      stubFetch({ enabled: true, readiness: READY }, [paused], { projects: [SITE_PROJECT] });
      const { unmount } = render(<CodingAgentApp />);
      await openRuns();
      fireEvent.click(await screen.findByTestId("coding-agent-details-run-paused01"));
      await screen.findByTestId("coding-agent-run-page");
      // Resume and Stop are the ways out of a paused run; "End it" is not one.
      expect(screen.getByTestId("coding-agent-resume-run-paused01")).toBeInTheDocument();
      expect(screen.queryByTestId("coding-agent-run-leftover")).toBeNull();
      expect(screen.queryByTestId("coding-agent-kill-run-paused01")).toBeNull();
      unmount();

      stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, leftover: true }], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      fireEvent.click(await screen.findByTestId(`coding-agent-details-${RUN.id}`));
      await screen.findByTestId("coding-agent-run-page");
      expect(await screen.findByTestId("coding-agent-run-leftover")).toBeInTheDocument();
      expect(screen.getByTestId(`coding-agent-kill-${RUN.id}`)).toBeInTheDocument();
    });

    it("says when there is nothing to show yet", async () => {
      stubFetch({ enabled: true, readiness: READY }, [], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      expect(await screen.findByText(translations.en["codingAgent.noRuns"])).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: translations.en["codingAgent.stop"] })).not.toBeInTheDocument();
    });
  });
});

describe("the harness self-test", () => {
  const TRANSCRIPT = "/home/clawbox/.claude-ds/projects/-home-clawbox-clawbox-data-code-projects-harness-test/61400ab6-0da9-4feb-8ad5-b547239c1367.jsonl";

  it("dispatches the canned smoke run into its scratch project and opens the live view", async () => {
    stubFetch({ enabled: true, readiness: READY }, [], { transcriptPath: TRANSCRIPT });
    const opened: string[] = [];
    const onTerminal = (e: Event) => opened.push((e as CustomEvent<{ command: string }>).detail.command);
    window.addEventListener("clawbox:open-terminal", onTerminal);
    try {
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
      fireEvent.click(await screen.findByTestId("coding-agent-harness-test"));
      await waitFor(() => {
        // The folder is made inside the owner's OWN project folder — it used
        // to be scaffolded as a code project under data/code-projects, which
        // is a ClawBox-internal directory they never browse.
        expect(posts.some((p) => p.url === "/setup-api/coding-agent/browse"
          && (p.body as { name?: string }).name === "harness-test")).toBe(true);
        // A BARE NAME, which the run resolver reads as "inside the default
        // project folder" — so the default stays the one place that decides
        // where "inside" is.
        expect(posts.some((p) => p.url === "/setup-api/coding-agent/run"
          && (p.body as { directory?: string }).directory === "harness-test")).toBe(true);
      });
      const runPost = posts.find((p) => p.url === "/setup-api/coding-agent/run");
      // The task names itself a smoke test, so the brief's "complete, polished
      // app" bar does not inflate it into a real feature build.
      expect(String((runPost?.body as { task?: string }).task)).toContain("smoke test");
      // The live view: the Terminal app is handed the preview script on the
      // run's transcript, single-quoted, once the listing carries the path.
      await waitFor(() => expect(opened).toEqual([`/home/clawbox/clawbox/scripts/coding-run-preview '${TRANSCRIPT}'`]));
    } finally {
      window.removeEventListener("clawbox:open-terminal", onTerminal);
    }
  });

  it("is not offered while a run is already in flight — one run at a time is the runner's rule", async () => {
    stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, status: "running", completedAt: null }]);
    render(<CodingAgentApp />);
    fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
    expect(await screen.findByTestId("coding-agent-harness-test")).toBeDisabled();
  });

  it("is offered while a settled run only waits on GitHub Actions — the CI wait occupies no harness", async () => {
    const pr = {
      phase: "waiting", number: 7, url: "https://github.com/o/r/pull/7", branch: "coding/run-k3x9q2ab", base: "main",
      checks: { total: 2, passed: 0, failed: 0, pending: 2 }, detail: null, startedAt: Date.now() - 30_000, endedAt: null,
      reviewOk: true,
    };
    stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, pr }]);
    render(<CodingAgentApp />);
    fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
    expect(await screen.findByTestId("coding-agent-harness-test")).toBeEnabled();
  });

  it("refuses, in the owner's words, when no project folder is set — and asks the box for nothing", async () => {
    // The smoke run lives INSIDE the default project folder, so without one
    // there is nowhere to put it. The refusal is worded through the
    // component's own `t` (the helper is not a component and cannot reach the
    // locale itself), and it happens before any route is touched: a scratch
    // folder made against a folder that does not exist, or a run posted for
    // the resolver to refuse, would each be a worse answer than the sentence.
    stubFetch({ enabled: true, readiness: READY }, [], { projectsDir: null });
    render(<CodingAgentApp />);
    fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
    fireEvent.click(await screen.findByTestId("coding-agent-harness-test"));
    expect(await screen.findByText(translations.en["codingAgent.harnessTestNoFolder"])).toBeInTheDocument();
    expect(translations.en["codingAgent.harnessTestNoFolder"]).toBe("Choose a project folder first.");
    expect(posts.some((p) => p.url === "/setup-api/coding-agent/browse")).toBe(false);
    expect(posts.some((p) => p.url === "/setup-api/coding-agent/run")).toBe(false);
    // The button is handed back: the owner fixes the folder and tries again.
    expect(screen.getByTestId("coding-agent-harness-test")).toBeEnabled();
  });

  it("tells the desktop a run started, once the route has said so", async () => {
    // The chat's run card only probes the box when told; a run started from
    // here while the chat sat open was never adopted.
    stubFetch({ enabled: true, readiness: READY }, []);
    let heard = 0;
    const onStarted = () => { heard += 1; };
    window.addEventListener(CODING_RUN_STARTED_EVENT, onStarted);
    try {
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
      fireEvent.click(await screen.findByTestId("coding-agent-harness-test"));
      await waitFor(() => expect(posts.some((p) => p.url === "/setup-api/coding-agent/run")).toBe(true));
      await waitFor(() => expect(heard).toBe(1));
    } finally {
      window.removeEventListener(CODING_RUN_STARTED_EVENT, onStarted);
    }
  });
});

describe("the summary and the report", () => {
  const SHOW = translations.en["codingAgent.showDetails"];
  /** What a run's closing message looks like — with what an agent must never
   *  get to run on the owner's screen. */
  const REPORT = [
    "## What I built",
    "",
    "**index.html** with a toggle.",
    "",
    "| File | Change |",
    "|---|---|",
    "| index.html | added the toggle |",
    "",
    "See [the docs](https://example.com/docs).",
    "",
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
  ].join("\n");
  const REPORT_ARTIFACT = { name: "report.md", bytes: REPORT.length, kind: "markdown" };
  const TEXT_ARTIFACT = { name: "tests.txt", bytes: 12, kind: "text" };

  async function openDetails() {
    await openRuns();
    fireEvent.click(await screen.findByRole("button", { name: SHOW }));
  }

  it("draws the summary as markdown, not as hashes", async () => {
    stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, summary: "## What I built\n\n**index.html** with a toggle." }], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    await openDetails();
    const summary = await screen.findByTestId("coding-agent-summary");
    expect(summary.querySelector("h2")?.textContent).toBe("What I built");
    expect(summary.querySelector("strong")?.textContent).toBe("index.html");
    expect(summary.textContent).not.toContain("##");
    expect(summary.textContent).not.toContain("**");
  });

  it("keeps agent-written HTML as text, and sends links to a new tab", async () => {
    stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, summary: REPORT }], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    await openDetails();
    const summary = await screen.findByTestId("coding-agent-summary");
    expect(summary.querySelector("script")).toBeNull();
    expect(summary.querySelector("[onerror]")).toBeNull();
    expect(summary.querySelector("img")).toBeNull();
    expect(summary.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(summary.querySelector("table")).not.toBeNull();
    const link = summary.querySelector("a");
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("opens report.md rendered in a dialog, which Escape closes", async () => {
    stubFetch(
      { enabled: true, readiness: READY },
      [{ ...RUN, artifacts: [REPORT_ARTIFACT, TEXT_ARTIFACT] }],
      { artifacts: { "report.md": REPORT }, projects: [SITE_PROJECT] },
    );
    render(<CodingAgentApp />);
    await openDetails();
    // A plain text file still opens the way it did: as a link to the route.
    expect(screen.getByRole("link", { name: "tests.txt" })).toHaveAttribute("href", expect.stringContaining("file=tests.txt"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const opener = screen.getByRole("button", { name: "report.md" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "report.md" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(dialog.querySelector("h2")?.textContent).toBe("What I built"));
    expect(dialog.textContent).not.toContain("##");
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.querySelector("[onerror]")).toBeNull();
    expect(dialog.querySelector("table")).not.toBeNull();
    // Focus moved in with the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The same bytes as text remain a click away.
    expect(screen.getByRole("link", { name: translations.en["codingAgent.reportOpenText"] }))
      .toHaveAttribute("href", expect.stringContaining("file=report.md"));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
  });

  it("says in words when the report cannot be loaded", async () => {
    stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, artifacts: [REPORT_ARTIFACT] }], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "report.md" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(t("codingAgent.reportFailed", { name: "report.md" }));
    fireEvent.click(screen.getByRole("button", { name: translations.en["codingAgent.reportClose"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("projects", () => {
  it("lists each project with its name, last commit and badges, and opens the desktop app", async () => {
    stubFetch({ enabled: true, readiness: READY }, [], {
      projects: [
        PROJECT,
        { ...PROJECT, folder: "scratch", name: "scratch", lastCommit: null, onDesktop: false,
          latestRun: { id: "run-k3x9q2ab", status: "running", task: "x", startedAt: Date.now(), completedAt: null } },
      ],
    });
    const apps: string[] = [];
    const onApp = (e: Event) => apps.push((e as CustomEvent<{ appId: string }>).detail.appId);
    window.addEventListener("clawbox:open-app", onApp);
    try {
      render(<CodingAgentApp />);
      await screen.findByTestId("coding-agent-projects");
      // Runs are no longer on home at all — they live on each project's page.
      expect(screen.queryByTestId("coding-agent-runs-toggle")).not.toBeInTheDocument();

      const site = screen.getByTestId("coding-agent-project-site");
      expect(site.textContent).toContain("My Site");
      expect(site.textContent).toContain("Coding agent: add a dark mode toggle");
      expect(site.textContent).toContain("3h ago");
      expect(site.textContent).toContain(translations.en["codingAgent.onDesktop"]);
      expect(site.textContent).not.toContain(translations.en["codingAgent.runInProgress"]);

      const scratch = screen.getByTestId("coding-agent-project-scratch");
      expect(scratch.textContent).toContain(translations.en["codingAgent.noCommits"]);
      expect(scratch.textContent).toContain(translations.en["codingAgent.runInProgress"]);
      expect(scratch.textContent).not.toContain(translations.en["codingAgent.onDesktop"]);
      // A folder of the owner's is not labelled; only a code project is (below).
      expect(site.textContent).not.toContain(translations.en["codingAgent.codeProject"]);
      // Open exists only for a project the desktop knows.
      expect(screen.queryByTestId("coding-agent-open-scratch")).not.toBeInTheDocument();

      // The id the DESKTOP matches on — page.tsx registers a deployed web app
      // as `installed-<folder>`. The bare folder name opened nothing.
      fireEvent.click(screen.getByTestId("coding-agent-open-site"));
      expect(apps).toEqual([installedAppId("site")]);
      expect(apps).toEqual(["installed-site"]);
    } finally {
      window.removeEventListener("clawbox:open-app", onApp);
    }
  });

  it("lists a code project — where the New app wizard's handoff lands — and says which it is", async () => {
    // The same name as a folder of the owner's: both rows stand.
    const codeProject = {
      ...PROJECT, kind: "codeProject", directory: "/home/clawbox/clawbox/data/code-projects/site",
      name: "Pomodoro timer", lastCommit: null, onDesktop: false,
    };
    stubFetch({ enabled: true, readiness: READY }, [], { projects: [PROJECT, codeProject] });
    render(<CodingAgentApp />);
    const rows = await screen.findAllByTestId("coding-agent-project-site");
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain("Pomodoro timer");
    expect(rows[1].textContent).toContain(translations.en["codingAgent.codeProject"]);
    expect(rows[0].textContent).not.toContain(translations.en["codingAgent.codeProject"]);
  });

  it("draws a project's picture at icon size, not at the width of the row", async () => {
    // InstalledAppIcon's <img> fills whatever box it is handed — it was
    // written for the desktop's colour tiles, where the picture is meant to
    // reach the edge — so the box has to come from the caller. Without one the
    // icon was a bare flex item at 100% of the row, and the name and the chips
    // were pushed onto the line below it.
    const withIcon = { ...PROJECT, iconUrl: "/setup-api/apps/icon/site?v=2" };
    stubFetch({ enabled: true, readiness: READY }, [], { projects: [withIcon] });
    render(<CodingAgentApp />);

    const icon = await screen.findByAltText(PROJECT.name);
    expect(icon).toHaveClass("w-full", "h-full");
    expect(icon.parentElement).toHaveClass("w-6", "h-6");

    // The project's own page shows the same picture, one size up.
    fireEvent.click(screen.getByTestId("coding-agent-project-site"));
    await screen.findByTestId("coding-agent-project-page");
    expect((await screen.findByAltText(PROJECT.name)).parentElement).toHaveClass("w-7", "h-7");
  });

  it("keeps the home row to a name, a commit line and a chevron — the folder copy lives on the project page", async () => {
    // The home list is the way IN: what a row carries is what tells the
    // projects apart. The folder path, the git line and the copy button
    // are the project page's, one tap further.
    stubFetch({ enabled: true, readiness: READY }, [], { projects: [PROJECT] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      render(<CodingAgentApp />);
      const row = await screen.findByTestId("coding-agent-project-site");
      expect(screen.queryByTestId("coding-agent-copy-site")).toBeNull();
      expect(row.textContent).not.toContain(PROJECT.directory);
      fireEvent.click(row);
      const copy = await screen.findByTestId("coding-agent-project-copy");
      expect(copy.textContent).toContain(PROJECT.directory);
      fireEvent.click(copy);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(PROJECT.directory));
      expect(await screen.findByText(translations.en["codingAgent.copied"])).toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  });

  it("opens a project row from the keyboard — Enter or Space, the way a click does", async () => {
    // The row holds buttons of its own, so it is not a <button>; it is a
    // keyboard stop with the button role instead.
    stubFetch({ enabled: true, readiness: READY }, [], { projects: [PROJECT] });
    render(<CodingAgentApp />);
    const row = await screen.findByTestId("coding-agent-project-site");
    expect(row).toHaveAttribute("role", "button");
    expect(row).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(row, { key: "Enter" });
    expect(await screen.findByTestId("coding-agent-project-page")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("coding-agent-project-back"));
    expect(screen.queryByTestId("coding-agent-project-page")).toBeNull();

    fireEvent.keyDown(screen.getByTestId("coding-agent-project-site"), { key: " " });
    expect(await screen.findByTestId("coding-agent-project-page")).toBeInTheDocument();
  });

  it("the project page copies the directory it shows, and names the button for a screen reader", async () => {
    stubFetch({ enabled: true, readiness: READY }, [], { projects: [PROJECT] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-project-site"));
      await screen.findByTestId("coding-agent-project-page");
      const copy = screen.getByTestId("coding-agent-project-copy");
      expect(copy.textContent).toContain(PROJECT.directory);
      expect(copy).toHaveAttribute("aria-label", translations.en["codingAgent.copyFolder"]);
      expect(copy).toHaveAttribute("title", translations.en["codingAgent.copyFolder"]);
      fireEvent.click(copy);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(PROJECT.directory));
      expect(copy.textContent).toContain(translations.en["codingAgent.copied"]);
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    }
  });

  it("files a run pointed at a code project under that project only, never under the folder holding it", async () => {
    // The run worked in the owner's folder AND carries the code project's
    // id: by directory it is the folder's, by id the code project's. It
    // belongs to one page, and the id is the stronger claim.
    const run = { ...RUN, directory: PROJECT.directory };
    const codeProject = { ...PROJECT, kind: "codeProject", directory: "/home/clawbox/clawbox/data/code-projects/site", name: "Pomodoro timer" };
    stubFetch({ enabled: true, readiness: READY }, [run], { projects: [PROJECT, codeProject] });
    render(<CodingAgentApp />);
    const rows = await screen.findAllByTestId("coding-agent-project-site");

    fireEvent.click(rows[0]);
    await screen.findByTestId("coding-agent-project-page");
    expect(screen.queryByText(RUN.task)).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-project-back"));

    fireEvent.click(screen.getAllByTestId("coding-agent-project-site")[1]);
    await screen.findByTestId("coding-agent-project-page");
    expect(await screen.findByText(RUN.task)).toBeInTheDocument();
  });

  it("re-reads the git block when the project's last commit changes, and not otherwise", async () => {
    // The block was read once when the page opened, so after a run committed
    // it kept the old count while the run row below said "Committed as …".
    // The projects poll already surfaces the new commit; the block follows it.
    const project = { ...PROJECT, kind: "codeProject", directory: "/home/clawbox/clawbox/data/code-projects/site" };
    const git = { branch: "main", commits: 1, remote: null, lastCommit: { subject: "first", date: Date.now() - 3600_000 } };
    stubFetch({ enabled: true, readiness: READY }, [], { projects: [project], git });
    render(<CodingAgentApp />);
    fireEvent.click(await screen.findByTestId("coding-agent-project-site"));
    await screen.findByTestId("coding-agent-project-page");
    await waitFor(() => expect(gitReads).toHaveLength(1));

    // A re-read of the box with nothing new is not a git read.
    window.dispatchEvent(new Event(CODING_AGENT_CHANGED_EVENT));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(gitReads).toHaveLength(1);

    project.lastCommit = { subject: "Coding agent: add a footer", date: Date.now() };
    git.commits = 2;
    git.lastCommit = project.lastCommit;
    window.dispatchEvent(new Event(CODING_AGENT_CHANGED_EVENT));
    await waitFor(() => expect(gitReads).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("coding-agent-git-info").textContent).toContain(t("codingAgent.gitCommits", { n: 2 })));
  });

  it("re-reads the git block after a backup, so the remote line follows the push", async () => {
    const git: { branch: string | null; commits: number; remote: string | null; lastCommit: { subject: string; date: number } | null } = {
      branch: "main", commits: 1, remote: null, lastCommit: { subject: "first", date: Date.now() - 3600_000 },
    };
    stubFetch({ enabled: true, readiness: READY }, [], {
      projects: [PROJECT], git,
      github: { installed: true, connected: true, login: "yalexx", loginCommand: "gh auth login" },
    });
    render(<CodingAgentApp />);
    fireEvent.click(await screen.findByTestId("coding-agent-project-site"));
    const backup = await screen.findByTestId("coding-agent-project-backup");
    await waitFor(() => expect(gitReads).toHaveLength(1));
    expect(screen.getByTestId("coding-agent-git-info").textContent).toContain(translations.en["codingAgent.gitNoRemote"]);

    git.remote = "git@github.com:yalexx/site.git";
    fireEvent.click(backup);
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/git", body: { directory: PROJECT.directory } }));
    await waitFor(() => expect(gitReads).toHaveLength(2));
    // The remote is drawn as the repository's page, and the quiet Back up
    // gives way to the GitHub link and Create PR.
    await waitFor(() => expect(within(screen.getByTestId("coding-agent-git-info")).getByTestId("coding-agent-project-github")).toHaveAttribute("href", "https://github.com/yalexx/site"));
    expect(screen.queryByTestId("coding-agent-project-backup")).toBeNull();
    expect(screen.getByTestId("coding-agent-project-create-pr")).toBeInTheDocument();
  });

  it("opens a pull request from the project page for the branch it is on, and links it afterwards", async () => {
    const git = { branch: "clawbox/run-1", commits: 3, remote: "https://github.com/yalexx/site.git", lastCommit: { subject: "Add the toggle", date: Date.now() - 60_000 } };
    stubFetch({ enabled: true, readiness: READY }, [], {
      projects: [PROJECT], git,
      github: { installed: true, connected: true, login: "yalexx", loginCommand: "gh auth login" },
    });
    const toasts: string[] = [];
    const onToast = (e: Event) => toasts.push(String((e as CustomEvent<{ message?: string }>).detail?.message ?? ""));
    window.addEventListener("clawbox:toast", onToast);
    try {
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-project-site"));
      const create = await screen.findByTestId("coding-agent-project-create-pr");
      expect(screen.queryByTestId("coding-agent-project-backup")).toBeNull();
      fireEvent.click(create);
      await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/git", body: { directory: PROJECT.directory, action: "pr" } }));
      const link = await screen.findByTestId("coding-agent-project-pr");
      expect(link).toHaveAttribute("href", "https://github.com/yalexx/site/pull/12");
      expect(link.textContent).toContain(t("codingAgent.viewPr", { n: 12 }));
      expect(screen.queryByTestId("coding-agent-project-create-pr")).toBeNull();
      expect(toasts).toEqual([t("codingAgent.prOpened", { n: 12 })]);
    } finally {
      window.removeEventListener("clawbox:toast", onToast);
    }
  });

  it("says in words when there are none, naming the folder it looked in", async () => {
    stubFetch({ enabled: true, readiness: READY }, [], { projects: [] });
    render(<CodingAgentApp />);
    const empty = await screen.findByTestId("coding-agent-projects-empty");
    expect(empty.textContent).toBe(t("codingAgent.noProjects", { folder: "/home/clawbox/Projects" }));
    expect(screen.queryByTestId("coding-agent-projects")).not.toBeInTheDocument();
  });

  it("says to choose a folder when none is set", async () => {
    stubFetch({ enabled: true, readiness: READY }, [], { projects: [], projectsDir: null });
    render(<CodingAgentApp />);
    const empty = await screen.findByTestId("coding-agent-projects-empty");
    expect(empty.textContent).toBe(translations.en["codingAgent.projectFolderUnset"]);
  });
});

describe("the New app hand-off", () => {
  it("opens the chat with the New app card instead of hosting a second form", async () => {
    // The card composes ONE message for the assistant, so it belongs in the
    // conversation that carries the reply. The same form used to live here as
    // well, so two windows asked for a new app and only one could show what
    // came back. (The card's own behaviour is covered by
    // new-app-wizard-card.test.tsx.)
    stubFetch({ enabled: true, readiness: READY });
    const events: string[] = [];
    const onNewApp = () => events.push(NEW_APP_EVENT);
    window.addEventListener(NEW_APP_EVENT, onNewApp);
    try {
      render(<CodingAgentApp />);
      fireEvent.click(await screen.findByTestId("coding-agent-new"));
      expect(events).toEqual([NEW_APP_EVENT]);
      expect(screen.queryByTestId("coding-agent-new-card")).toBeNull();
      expect(screen.queryByTestId("coding-agent-new-name")).toBeNull();
    } finally {
      window.removeEventListener(NEW_APP_EVENT, onNewApp);
    }
  });
});

describe("the workspace, the breadcrumb and the live view", () => {
  const LIVE = { ...RUN, status: "running", completedAt: null, summary: null, transcriptPath: "/home/clawbox/.claude-ds/projects/x/s.jsonl", progress: ["$ npm test"] };

  it("carries the project's files and changes on its page, and reads the changes only once that tab is opened", async () => {
    stubFetch({ enabled: true, readiness: READY }, [], {
      projects: [SITE_PROJECT],
      tree: { entries: [{ name: "src", type: "directory", size: null, modified: null }, { name: "index.html", type: "file", size: 120, modified: null }] },
      changes: { available: true, truncated: false, additions: 4, deletions: 0, files: [{ path: "index.html", status: "modified", additions: 4, deletions: 0 }] },
    });
    render(<CodingAgentApp />);
    fireEvent.click(await screen.findByTestId("coding-agent-project-site"));
    await screen.findByTestId("coding-agent-project-page");
    const tree = await screen.findByTestId("coding-agent-file-tree");
    await within(tree).findByTestId("coding-agent-tree-index.html");
    expect(within(tree).getByTestId("coding-agent-tree-src")).toBeInTheDocument();
    // The git block read once; the Changes tab has not asked yet.
    await waitFor(() => expect(gitReads).toEqual(["/setup-api/coding-agent/git?projectId=site"]));

    fireEvent.click(screen.getByTestId("coding-agent-workspace-changes"));
    await screen.findByTestId("coding-agent-change-index.html");
    expect(gitReads).toContain("/setup-api/coding-agent/git?projectId=site&changes=1");
    expect(screen.getByTestId("coding-agent-change-totals").textContent).toContain(t("codingAgent.filesChanged", { n: 1 }));
  });

  it("names the trail above a run — Projects › project › run — and Back leads to the project, even for a run handed in from outside", async () => {
    stubFetch({ enabled: true, readiness: READY }, [RUN], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    await screen.findByTestId("coding-agent-project-site");
    // Handed in the way the chat's card and the finish card do it: no
    // project page was opened first.
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_CODING_RUN_EVENT, { detail: { runId: RUN.id } })); });
    await screen.findByTestId("coding-agent-run-page");
    const crumbs = screen.getByTestId("coding-agent-breadcrumb");
    expect(within(crumbs).getByTestId("coding-agent-crumb-projects").textContent).toBe(t("codingAgent.projectsTitle"));
    expect(within(crumbs).getByTestId("coding-agent-crumb-project").textContent).toBe(SITE_PROJECT.name);
    expect(within(crumbs).getByText("Add a dark mode toggle")).toHaveAttribute("aria-current", "page");
    // The arrow says where it goes, for a screen reader too.
    expect(screen.getByTestId("coding-agent-run-back")).toHaveAttribute("aria-label", t("codingAgent.backTo", { name: SITE_PROJECT.name }));
    fireEvent.click(screen.getByTestId("coding-agent-run-back"));
    expect(screen.queryByTestId("coding-agent-run-page")).toBeNull();
    expect(await screen.findByTestId("coding-agent-project-page")).toBeInTheDocument();
    // And the first crumb goes all the way home.
    fireEvent.click(screen.getByTestId("coding-agent-crumb-projects"));
    expect(screen.queryByTestId("coding-agent-project-page")).toBeNull();
    expect(await screen.findByTestId("coding-agent-project-site")).toBeInTheDocument();
  });

  it("uses the same breadcrumb on the settings page, with the header's Settings button gone while it is open", async () => {
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentApp />);
    fireEvent.click(await screen.findByTestId("coding-agent-open-settings"));
    await screen.findByTestId("coding-agent-embedded-settings");
    expect(screen.queryByTestId("coding-agent-open-settings")).toBeNull();
    const crumbs = screen.getByTestId("coding-agent-breadcrumb");
    expect(within(crumbs).getByText(t("codingAgent.openSettings"))).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(crumbs).getByTestId("coding-agent-crumb-home"));
    expect(screen.queryByTestId("coding-agent-embedded-settings")).toBeNull();
    expect(await screen.findByTestId("coding-agent-open-settings")).toBeInTheDocument();
  });

  it("keeps the header row on the setup wizard even in a wide window — the wizard has no rail, and Settings is the way out", async () => {
    const RO = class {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.cb = cb; }
      observe(el: Element) { this.cb([{ contentRect: { width: 1200 } } as ResizeObserverEntry], this as unknown as ResizeObserver); void el; }
      unobserve() {}
      disconnect() {}
    };
    vi.stubGlobal("ResizeObserver", RO);
    try {
      stubFetch({ enabled: false, readiness: READY, setupComplete: false }, [], { projects: [] });
      render(<CodingAgentApp />);
      expect(await screen.findByTestId("coding-agent-open-settings")).toBeInTheDocument();
      expect(screen.getByTestId("coding-agent-state")).toHaveTextContent(t("codingAgent.stateOff"));
      expect(screen.queryByTestId("coding-agent-sidebar")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the header row in a narrow window, where there is no rail to carry it", async () => {
    stubFetch({ enabled: true, readiness: READY }, [RUN], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    expect(await screen.findByTestId("coding-agent-open-settings")).toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-state")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-sidebar")).toBeNull();
  });

  it("shows a few of a run's pictures and the whole evidence list only on request", async () => {
    const pictures = Array.from({ length: 6 }, (_, i) => ({ name: `step-${i + 1}.png`, bytes: 100, kind: "image" as const }));
    const run = { ...RUN, artifacts: [...pictures, { name: "report.md", bytes: 20, kind: "markdown" as const }, { name: "intro.wav", bytes: 4096, kind: "audio" as const }] };
    stubFetch({ enabled: true, readiness: READY }, [run], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    await openRuns();
    fireEvent.click(await screen.findByTestId("coding-agent-details-run-k3x9q2ab"));
    const card = await screen.findByTestId("coding-agent-artifacts");
    // Folded: four thumbnails, no clip, no file list, and the count.
    expect(card).toHaveAttribute("data-folded", "true");
    expect(card.querySelectorAll("img")).toHaveLength(4);
    expect(screen.queryByTestId("coding-agent-artifact-audio")).toBeNull();
    expect(within(card).queryByText("report.md")).toBeNull();
    expect(card.textContent).toContain("(8)");
    const toggle = screen.getByTestId("coding-agent-artifacts-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.textContent).toBe(t("codingAgent.artifactsShowAll", { n: 8 }));
    // Unfolded: everything.
    fireEvent.click(toggle);
    expect(card).not.toHaveAttribute("data-folded");
    expect(card.querySelectorAll("img")).toHaveLength(6);
    expect(within(screen.getByTestId("coding-agent-artifact-audio")).getByLabelText("intro.wav")).toBeInTheDocument();
    expect(within(card).getByText("report.md")).toBeInTheDocument();
    expect(toggle.textContent).toBe(t("codingAgent.artifactsShowFewer"));
    fireEvent.click(toggle);
    expect(card).toHaveAttribute("data-folded", "true");
  });

  it("folds mixed evidence by count, not by kind — a clip and a report among the first four are shown", async () => {
    const run = { ...RUN, artifacts: [
      { name: "intro.wav", bytes: 4096, kind: "audio" as const },
      { name: "report.md", bytes: 20, kind: "markdown" as const },
      { name: "a.png", bytes: 100, kind: "image" as const },
      { name: "b.png", bytes: 100, kind: "image" as const },
      { name: "c.png", bytes: 100, kind: "image" as const },
      { name: "notes.txt", bytes: 10, kind: "text" as const },
    ] };
    stubFetch({ enabled: true, readiness: READY }, [run], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    await openRuns();
    fireEvent.click(await screen.findByTestId("coding-agent-details-run-k3x9q2ab"));
    const card = await screen.findByTestId("coding-agent-artifacts");
    expect(card).toHaveAttribute("data-folded", "true");
    expect(within(screen.getByTestId("coding-agent-artifact-audio")).getByLabelText("intro.wav")).toBeInTheDocument();
    expect(within(card).getByText("report.md")).toBeInTheDocument();
    expect(card.querySelectorAll("img")).toHaveLength(2);
    expect(within(card).queryByText("notes.txt")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-artifacts-toggle"));
    expect(card.querySelectorAll("img")).toHaveLength(3);
    expect(within(card).getByText("notes.txt")).toBeInTheDocument();
  });

  it("shows the browser the run drives above its terminal while it runs — a picture only — folds it on request, and not once it settled", async () => {
    stubFetch({ enabled: true, readiness: READY }, [LIVE], { projects: [SITE_PROJECT] });
    const { unmount } = render(<CodingAgentApp />);
    await openRuns();
    fireEvent.click(await screen.findByTestId("coding-agent-details-run-k3x9q2ab"));
    await screen.findByTestId("coding-agent-run-page");
    const preview = await screen.findByTestId("coding-agent-browser-preview");
    const terminal = screen.getByTestId("coding-agent-run-terminal");
    expect(preview.compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const screenMock = within(preview).getByTestId("vnc-mock");
    expect(screenMock).toHaveAttribute("data-view-only", "true");
    expect(screenMock).toHaveAttribute("data-paste", "hidden");
    // The two share a row while both are showing (side by side in a wide
    // window); with the preview folded the terminal has the row to itself.
    const row = screen.getByTestId("coding-agent-live-row");
    expect(row).toHaveAttribute("data-side-by-side", "true");
    expect(within(row).getByTestId("coding-agent-run-terminal")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("coding-agent-browser-preview-toggle"));
    expect(within(preview).queryByTestId("vnc-mock")).toBeNull();
    expect(row).not.toHaveAttribute("data-side-by-side");
    fireEvent.click(screen.getByTestId("coding-agent-browser-preview-toggle"));
    expect(within(preview).getByTestId("vnc-mock")).toBeInTheDocument();
    unmount();

    stubFetch({ enabled: true, readiness: READY }, [RUN], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    await openRuns();
    fireEvent.click(await screen.findByTestId("coding-agent-details-run-k3x9q2ab"));
    await screen.findByTestId("coding-agent-run-page");
    expect(screen.queryByTestId("coding-agent-browser-preview")).toBeNull();
    expect(screen.queryByTestId("coding-agent-run-live-view")).toBeNull();
  });

  it("fills the page with the browser and the terminal in Live view, hides the rail, and comes back", async () => {
    stubFetch({ enabled: true, readiness: READY }, [LIVE], { projects: [SITE_PROJECT] });
    render(<CodingAgentApp />);
    await openRuns();
    fireEvent.click(await screen.findByTestId("coding-agent-details-run-k3x9q2ab"));
    await screen.findByTestId("coding-agent-run-rail");
    fireEvent.click(screen.getByTestId("coding-agent-run-live-view"));
    const page = screen.getByTestId("coding-agent-run-page");
    expect(page).toHaveAttribute("data-live-view", "true");
    const live = screen.getByTestId("coding-agent-live-view");
    expect(within(live).getByTestId("vnc-mock")).toHaveAttribute("data-view-only", "true");
    expect(within(live).getByTestId("terminal-mock")).toHaveAttribute("data-command", expect.stringContaining("coding-run-preview"));
    expect(screen.queryByTestId("coding-agent-run-rail")).toBeNull();
    expect(screen.queryByTestId("coding-agent-summary")).toBeNull();
    // Stop is still at hand — the view is where the owner watches a run.
    expect(screen.getByTestId("coding-agent-stop-run-k3x9q2ab")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("coding-agent-run-live-view"));
    expect(screen.getByTestId("coding-agent-run-page")).not.toHaveAttribute("data-live-view");
    expect(await screen.findByTestId("coding-agent-run-rail")).toBeInTheDocument();
  });

  it("opens straight into Live view when the chat's View button asks for it, cold and while already open", async () => {
    stubFetch({ enabled: true, readiness: READY }, [LIVE], { projects: [SITE_PROJECT] });
    // Cold: the handoff was parked before the app mounted.
    (window as Window & { __clawboxPendingCodingRun?: string }).__clawboxPendingCodingRun = LIVE.id;
    (window as Window & { __clawboxPendingCodingRunLive?: boolean }).__clawboxPendingCodingRunLive = true;
    render(<CodingAgentApp />);
    expect(await screen.findByTestId("coding-agent-run-page")).toHaveAttribute("data-live-view", "true");
    // Off, then asked again while up.
    fireEvent.click(screen.getByTestId("coding-agent-run-live-view"));
    expect(screen.getByTestId("coding-agent-run-page")).not.toHaveAttribute("data-live-view");
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_CODING_RUN_EVENT, { detail: { runId: LIVE.id, live: true } })); });
    await waitFor(() => expect(screen.getByTestId("coding-agent-run-page")).toHaveAttribute("data-live-view", "true"));
    // A plain open lands on the normal page.
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_CODING_RUN_EVENT, { detail: { runId: LIVE.id } })); });
    await waitFor(() => expect(screen.getByTestId("coding-agent-run-page")).not.toHaveAttribute("data-live-view"));
  });
});
