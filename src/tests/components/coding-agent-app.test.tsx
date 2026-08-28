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
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentApp, { installedAppId, NEW_APP_NAME_MAX } from "@/components/CodingAgentApp";
import { MAX_PROJECT_NAME_LENGTH } from "@/lib/code-projects";
import { buildNewAppPrompt, CHAT_MESSAGE_EVENT, CODING_AGENT_CHANGED_EVENT } from "@/lib/ui-events";

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

/** The device, as far as this component can tell. */
function stubFetch(
  status: { enabled: boolean; readiness: typeof READY | typeof NOT_READY },
  runsArg: unknown[] = [],
  opts: { artifacts?: Record<string, string>; projects?: unknown[]; projectsDir?: string | null; transcriptPath?: string } = {},
) {
  let runs = runsArg;
  posts = [];
  const projects = {
    directory: opts.projectsDir === undefined ? "/home/clawbox/Projects" : opts.projectsDir,
    projects: opts.projects ?? [],
  };
  const payload = () => ({
    enabled: status.enabled,
    ready: status.enabled && status.readiness.ready,
    readiness: status.readiness,
    running: 0,
    harnessCommand: "claude-ds",
    maxTaskChars: 4000,
    defaultDirectory: null,
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The runs list is behind a button now — open it the way a person would. */
/** The runs list is OPEN by default now — this only waits for it. */
async function openRuns() {
  await screen.findByTestId("coding-agent-runs-toggle");
}

/** Click the toggle, which now COLLAPSES a list that starts open. */
async function toggleRuns() {
  fireEvent.click(await screen.findByTestId("coding-agent-runs-toggle"));
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

  it("opens Settings on the Coding Agent section from its one Settings link", async () => {
    stubFetch({ enabled: true, readiness: READY });
    const sections: string[] = [];
    const apps: string[] = [];
    const onSection = (e: Event) => sections.push((e as CustomEvent<{ section: string }>).detail.section);
    const onApp = (e: Event) => apps.push((e as CustomEvent<{ appId: string }>).detail.appId);
    window.addEventListener("clawbox:open-settings-section", onSection);
    window.addEventListener("clawbox:open-app", onApp);
    try {
      render(<CodingAgentApp />);
      expect((await screen.findByTestId("coding-agent-state")).textContent).toBe(translations.en["codingAgent.stateOn"]);
      fireEvent.click(screen.getByTestId("coding-agent-open-settings"));
      expect(sections).toEqual(["codingAgent"]);
      expect(apps).toEqual(["settings"]);
      // The cold-open handoff Settings reads on mount, so the link works
      // before the Settings window exists.
      expect((window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection).toBe("codingAgent");
    } finally {
      window.removeEventListener("clawbox:open-settings-section", onSection);
      window.removeEventListener("clawbox:open-app", onApp);
      delete (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection;
    }
  });

  it("is a real link to the standalone Settings page on /app/coding, where no desktop is listening", async () => {
    // "Open in new tab" lands a phone on /app/coding. That page hosts one app
    // and registers no listener for the open-app or open-section events, so
    // a button that only dispatched them would do nothing — and the switch
    // no longer lives on that page. The link has to navigate instead.
    stubFetch({ enabled: true, readiness: READY });
    const sections: string[] = [];
    const onSection = (e: Event) => sections.push((e as CustomEvent<{ section: string }>).detail.section);
    window.addEventListener("clawbox:open-settings-section", onSection);
    window.history.pushState({}, "", "/app/coding");
    try {
      render(<CodingAgentApp />);
      const link = await screen.findByTestId("coding-agent-open-settings");
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "/app/settings?section=codingAgent");
      expect(link.textContent).toContain(translations.en["codingAgent.openSettings"]);
      // jsdom cannot navigate; what matters is that the click reaches the
      // browser as a plain navigation and not as a desktop event.
      link.addEventListener("click", (e) => e.preventDefault(), { once: true });
      fireEvent.click(link);
      expect(sections).toEqual([]);
      expect((window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection).toBeUndefined();
    } finally {
      window.removeEventListener("clawbox:open-settings-section", onSection);
      window.history.pushState({}, "", "/");
    }
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
      stubFetch({ enabled: true, readiness: READY }, [RUN]);
      render(<CodingAgentApp />);
      const toggle = await screen.findByTestId("coding-agent-runs-toggle");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(await screen.findByText("Add a dark mode toggle")).toBeInTheDocument();
      expect(toggle.textContent).toContain("(1)");

      fireEvent.click(toggle);
      expect(screen.queryByText("Add a dark mode toggle")).not.toBeInTheDocument();
    });

    it("pages the list rather than showing an unbounded history", async () => {
      const many = Array.from({ length: 23 }, (_, i) => ({ ...RUN, id: `run-${String(i).padStart(8, "0")}`, task: `task number ${i}` }));
      stubFetch({ enabled: true, readiness: READY }, many);
      render(<CodingAgentApp />);
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
      stubFetch({ enabled: true, readiness: READY }, [RUN]);
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
      stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, status: "running", completedAt: null, summary: null }]);
      render(<CodingAgentApp />);
      const toggle = await screen.findByTestId("coding-agent-runs-toggle");
      await waitFor(() => expect(toggle.textContent).toContain(translations.en["codingAgent.statusRunning"]));
    });

    it("offers Stop only for a running run and posts its id", async () => {
      stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, status: "running", completedAt: null, summary: null }]);
      render(<CodingAgentApp />);
      await openRuns();
      const stop = await screen.findByRole("button", { name: translations.en["codingAgent.stop"] });
      fireEvent.click(stop);
      await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/stop", body: { runId: "run-k3x9q2ab" } }));
    });

    it("clears the history, but only after a second click", async () => {
      stubFetch({ enabled: true, readiness: READY }, [RUN]);
      render(<CodingAgentApp />);
      await openRuns();
      const clear = await screen.findByTestId("coding-agent-clear");
      expect(clear.textContent).toBe(translations.en["codingAgent.clearRuns"]);

      // First click only arms it — history is not something to lose to a
      // mis-tap.
      fireEvent.click(clear);
      expect(clear.textContent).toBe(translations.en["codingAgent.clearConfirm"]);
      expect(posts).toEqual([]);

      fireEvent.click(clear);
      await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/runs", body: "DELETE" }));
      await waitFor(() => expect(screen.getByText(translations.en["codingAgent.noRuns"])).toBeInTheDocument());
    });

    it("takes the offer back when the list is collapsed", async () => {
      stubFetch({ enabled: true, readiness: READY }, [RUN]);
      render(<CodingAgentApp />);
      await openRuns();
      fireEvent.click(await screen.findByTestId("coding-agent-clear"));
      expect(screen.getByTestId("coding-agent-clear").textContent).toBe(translations.en["codingAgent.clearConfirm"]);

      await toggleRuns(); // collapse
      await toggleRuns(); // and open again
      expect(screen.getByTestId("coding-agent-clear").textContent).toBe(translations.en["codingAgent.clearRuns"]);
      expect(posts).toEqual([]);
    });

    it("offers nothing to clear when there is no history", async () => {
      stubFetch({ enabled: true, readiness: READY }, []);
      render(<CodingAgentApp />);
      await openRuns();
      expect(screen.queryByTestId("coding-agent-clear")).not.toBeInTheDocument();
    });

    it("says when there is nothing to show yet", async () => {
      stubFetch({ enabled: true, readiness: READY }, []);
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
      await openRuns();
      fireEvent.click(await screen.findByTestId("coding-agent-harness-test"));
      await waitFor(() => {
        expect(posts.some((p) => p.url === "/setup-api/code"
          && (p.body as { projectId?: string }).projectId === "harness-test")).toBe(true);
        expect(posts.some((p) => p.url === "/setup-api/coding-agent/run"
          && (p.body as { projectId?: string }).projectId === "harness-test")).toBe(true);
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
    await openRuns();
    expect(await screen.findByTestId("coding-agent-harness-test")).toBeDisabled();
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
    stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, summary: "## What I built\n\n**index.html** with a toggle." }]);
    render(<CodingAgentApp />);
    await openDetails();
    const summary = await screen.findByTestId("coding-agent-summary");
    expect(summary.querySelector("h2")?.textContent).toBe("What I built");
    expect(summary.querySelector("strong")?.textContent).toBe("index.html");
    expect(summary.textContent).not.toContain("##");
    expect(summary.textContent).not.toContain("**");
  });

  it("keeps agent-written HTML as text, and sends links to a new tab", async () => {
    stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, summary: REPORT }]);
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
      { artifacts: { "report.md": REPORT } },
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
    stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, artifacts: [REPORT_ARTIFACT] }]);
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
      const list = await screen.findByTestId("coding-agent-projects");
      // The section sits above the runs.
      expect(list.compareDocumentPosition(screen.getByTestId("coding-agent-runs-toggle")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

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

describe("the New app wizard", () => {
  let messages: string[];
  const onMessage = (e: Event) => messages.push((e as CustomEvent<{ text: string }>).detail.text);

  beforeEach(() => {
    messages = [];
    window.addEventListener(CHAT_MESSAGE_EVENT, onMessage);
  });
  afterEach(() => {
    window.removeEventListener(CHAT_MESSAGE_EVENT, onMessage);
  });

  async function openWizard() {
    render(<CodingAgentApp />);
    fireEvent.click(await screen.findByTestId("coding-agent-new"));
    return screen.getByTestId("coding-agent-new-card");
  }

  it("holds the name to the same bound the project library enforces", () => {
    expect(NEW_APP_NAME_MAX).toBe(MAX_PROJECT_NAME_LENGTH);
  });

  it("asks for a name and a description before it will hand anything over", async () => {
    stubFetch({ enabled: true, readiness: READY });
    await openWizard();
    fireEvent.click(screen.getByTestId("coding-agent-new-create"));
    expect(screen.getByTestId("coding-agent-new-error").textContent).toBe(translations.en["codingAgent.newNameRequired"]);
    expect(messages).toEqual([]);

    fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Pomodoro timer" } });
    fireEvent.click(screen.getByTestId("coding-agent-new-create"));
    expect(screen.getByTestId("coding-agent-new-error").textContent).toBe(translations.en["codingAgent.newWhatRequired"]);
    expect(messages).toEqual([]);

    // A description longer than the run route would accept is refused
    // here, with the route's own ceiling in the message.
    fireEvent.change(screen.getByTestId("coding-agent-new-what"), { target: { value: "x".repeat(4001) } });
    fireEvent.click(screen.getByTestId("coding-agent-new-create"));
    expect(screen.getByTestId("coding-agent-new-error").textContent).toBe(t("codingAgent.newWhatTooLong", { max: 4000 }));
    expect(messages).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("composes the one message, hands it to the chat, closes, and says so", async () => {
    stubFetch({ enabled: true, readiness: READY });
    await openWizard();
    fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "  Pomodoro timer " } });
    fireEvent.change(screen.getByTestId("coding-agent-new-what"), {
      target: { value: "A timer with 25-minute work blocks and 5-minute breaks." },
    });
    fireEvent.change(screen.getByTestId("coding-agent-new-template"), { target: { value: "blank" } });
    fireEvent.click(screen.getByTestId("coding-agent-new-create"));

    expect(messages).toEqual([
      buildNewAppPrompt({
        name: "Pomodoro timer",
        description: "A timer with 25-minute work blocks and 5-minute breaks.",
        template: "blank",
      }),
    ]);
    expect(messages[0]).toBe(
      'Create a new ClawBox app called "Pomodoro timer": A timer with 25-minute work blocks and 5-minute breaks.\n'
      + 'Scaffold it as a code project from the "blank" template, build it with the coding agent, verify it in the browser, and put it on my desktop.',
    );
    // The wizard never calls the run route itself: the assistant does, with
    // the project it has just scaffolded.
    expect(posts).toEqual([]);
    expect(screen.queryByTestId("coding-agent-new-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-new-handed").textContent).toBe(translations.en["codingAgent.newHanded"]);
  });

  it("is not offered on the standalone page, which mounts no chat to hand the message to", async () => {
    // "Open in new tab" renders the app at /app/coding, without ChatPopup:
    // a message dispatched there would reach nothing, while the card said
    // it had been handed over.
    window.history.pushState({}, "", "/app/coding");
    try {
      stubFetch({ enabled: true, readiness: READY }, [], { projects: [PROJECT] });
      render(<CodingAgentApp />);
      await screen.findByTestId("coding-agent-project-site");
      expect(screen.queryByTestId("coding-agent-new")).not.toBeInTheDocument();
      expect(screen.getByTestId("coding-agent-new-needs-desktop").textContent).toBe(translations.en["codingAgent.newNeedsDesktop"]);
      expect(messages).toEqual([]);
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("can be cancelled without saying anything to the chat", async () => {
    stubFetch({ enabled: true, readiness: READY });
    await openWizard();
    fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Half typed" } });
    fireEvent.click(screen.getByTestId("coding-agent-new-cancel"));
    expect(screen.queryByTestId("coding-agent-new-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-new-handed")).not.toBeInTheDocument();
    expect(messages).toEqual([]);
  });
});
