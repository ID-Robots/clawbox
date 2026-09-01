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
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentApp, { installedAppId, NEW_APP_NAME_MAX } from "@/components/CodingAgentApp";
import { MAX_PROJECT_NAME_LENGTH } from "@/lib/code-projects";
import { CHAT_MESSAGE_EVENT, CODING_AGENT_CHANGED_EVENT, CODING_RUN_STARTED_EVENT, NEW_APP_EVENT } from "@/lib/ui-events";

// One stable `t`, as the real hook provides (it is memoised on the locale
// table) — a fresh function per render would be a different contract.
const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t }),
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
    defaultDirectory: opts.projectsDir === undefined ? "/home/clawbox/Projects" : opts.projectsDir,
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
    if (url.startsWith("/setup-api/coding-agent/git?")) {
      // The route answers `{ git }` for the one project the query names.
      gitReads.push(url);
      return json({ git: opts.git ?? { branch: null, commits: 0, remote: null, lastCommit: null } });
    }
    if (url === "/setup-api/coding-agent/git" && init?.method === "POST") {
      // A backup: the folder is pushed, private, to a repo named after it.
      posts.push({ url, body: JSON.parse(String(init.body)) });
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
      // The route answers the whole status, re-read after the change.
      return json({ ...payload(), defaultDirectory: body.defaultDirectory ?? null });
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
  // Runs moved off home onto the project's page: enter it first (once).
  if (!screen.queryByTestId("coding-agent-project-page")) {
    fireEvent.click(await screen.findByTestId("coding-agent-project-site"));
    await screen.findByTestId("coding-agent-project-page");
  }
  await screen.findByTestId("coding-agent-runs-toggle");
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
      expect(screen.getByTestId("coding-agent-wizard-effort-ultracode")).toHaveAttribute("aria-checked", "true");
      expect(screen.getByTestId("coding-agent-wizard-effort-low")).toHaveAttribute("aria-checked", "false");
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

    // Home lists projects only — no runs at all (the owner asked them off).
    await screen.findByTestId("coding-agent-project-site");
    expect(screen.queryByText("somewhere else")).toBeNull();
    expect(screen.queryByText("inside the project")).toBeNull();

    fireEvent.click(screen.getByTestId("coding-agent-project-site"));
    expect(await screen.findByTestId("coding-agent-project-page")).toBeInTheDocument();
    // The git block shows what the route answered — branch, commit count,
    // origin — and a code project is asked about by its id, not its folder.
    const gitInfo = screen.getByTestId("coding-agent-git-info");
    await waitFor(() => expect(gitInfo.textContent).toContain("main"));
    expect(gitInfo.textContent).toContain(t("codingAgent.gitCommits", { n: 7 }));
    expect(gitInfo.textContent).toContain("git@github.com:owner/site.git");
    expect(gitInfo.textContent).not.toContain(translations.en["codingAgent.gitNoRemote"]);
    expect(gitReads).toEqual(["/setup-api/coding-agent/git?projectId=site"]);
    // The project page lists the project's runs and not the stranger.
    expect(await screen.findByText("inside the project")).toBeInTheDocument();
    expect(screen.queryByText("somewhere else")).toBeNull();

    fireEvent.click(screen.getByTestId("coding-agent-project-back"));
    expect(screen.queryByTestId("coding-agent-project-page")).toBeNull();
    expect(screen.queryByText("inside the project")).toBeNull();
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
    it("shows the runs straight away, and can still be collapsed", async () => {
      // Reversed deliberately: the history is why the window gets opened once
      // the switch is already on.
      stubFetch({ enabled: true, readiness: READY }, [RUN], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      const toggle = await screen.findByTestId("coding-agent-runs-toggle");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(await screen.findByText("Add a dark mode toggle")).toBeInTheDocument();
      expect(toggle.textContent).toContain("(1)");

      fireEvent.click(toggle);
      expect(screen.queryByText("Add a dark mode toggle")).not.toBeInTheDocument();
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

    it("says a run is in flight on the button itself, without being opened", async () => {
      stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, status: "running", completedAt: null, summary: null }], { projects: [SITE_PROJECT] });
      render(<CodingAgentApp />);
      await openRuns();
      const toggle = await screen.findByTestId("coding-agent-runs-toggle");
      await waitFor(() => expect(toggle.textContent).toContain(translations.en["codingAgent.statusRunning"]));
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
        expect(opened).toEqual([`cd '${RUN.directory}' && claude-ds --resume ${session}`]);
      } finally {
        window.removeEventListener("clawbox:open-terminal", onTerminal);
      }
    });

    it("labels a review pass with the run it reviewed, and a tap jumps there", async () => {
      // The record carries reviewOf but the row used to read as an ordinary
      // run whose task was a wall of the fixed review text.
      const reviewed = { ...RUN, id: "run-reviewed1" };
      const review = {
        ...RUN, id: "run-review001", reviewOf: "run-reviewed1", summary: "Nothing real was found.",
        task: "Automatic review pass. Adversarially review the work you just delivered in this folder: read the diff of your last commit",
      };
      stubFetch({ enabled: true, readiness: READY }, [review, reviewed], { projects: [SITE_PROJECT] });
      // jsdom has no scrollIntoView; record which row the app asked for.
      const scrolled: string[] = [];
      const proto = Element.prototype as { scrollIntoView?: unknown };
      const original = proto.scrollIntoView;
      proto.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.dataset.runId ?? ""); };
      try {
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
        expect(await screen.findByText(/Added the toggle/)).toBeInTheDocument();
        expect(scrolled).toEqual(["run-reviewed1"]);
      } finally {
        proto.scrollIntoView = original;
      }
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

  it("copies the folder name — the name a run is given — on one tap", async () => {
    stubFetch({ enabled: true, readiness: READY }, [], { projects: [PROJECT] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      render(<CodingAgentApp />);
      const copy = await screen.findByTestId("coding-agent-copy-site");
      expect(copy.textContent).toContain("site");
      fireEvent.click(copy);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("site"));
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
    await waitFor(() => expect(screen.getByTestId("coding-agent-git-info").textContent).toContain("git@github.com:yalexx/site.git"));
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
