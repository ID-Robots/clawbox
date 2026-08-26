/**
 * The Coding Agent app (src/components/CodingAgentApp.tsx), opened from the
 * desktop icon of the same name.
 *
 * The switch renders what the route answers — never what was clicked — and
 * the panel shows the owner what a run needs and what recent runs did, using
 * the real English strings so a missing key fails here rather than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentApp from "@/components/CodingAgentApp";

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let posts: { url: string; body: unknown }[];

/**
 * The device, as far as this component can tell.
 *
 * `resolveTo` stands in for the route resolving a symlink to its real folder,
 * and `rejectDir` for the containment rules refusing one — both are answers
 * the real route gives, and both are things the field has to render.
 */
function stubFetch(
  status: { enabled: boolean; readiness: typeof READY | typeof NOT_READY; defaultDirectory?: string | null },
  runsArg: unknown[] = [],
  opts: { resolveTo?: string; rejectDir?: string } = {},
) {
  let runs = runsArg;
  posts = [];
  let stored: string | null = status.defaultDirectory ?? null;
  const payload = () => ({
    enabled: status.enabled,
    ready: status.enabled && status.readiness.ready,
    readiness: status.readiness,
    running: 0,
    harnessCommand: "claude-ds",
    maxTaskChars: 4000,
    defaultDirectory: stored,
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
    if (url === "/setup-api/coding-agent/enable" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ url, body });
      if ("defaultDirectory" in body) {
        if (opts.rejectDir && body.defaultDirectory !== null) {
          return json({ error: opts.rejectDir, kind: "invalid" }, 400);
        }
        stored = body.defaultDirectory === null ? null : (opts.resolveTo ?? body.defaultDirectory);
      }
      if (typeof body.enabled === "boolean") status = { ...status, enabled: body.enabled };
      return json(payload());
    }
    if (url === "/setup-api/coding-agent/stop" && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ run: { ...RUN, status: "stopped" } });
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

const RUNS_TOGGLE = translations.en["codingAgent.recentRuns"];

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
  it("renders the switch off and turns it on only after the route says so", async () => {
    stubFetch({ enabled: false, readiness: READY });
    render(<CodingAgentApp />);
    const toggle = await screen.findByRole("switch", { name: translations.en["codingAgent.switchLabel"] });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { enabled: true } }]));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("carries no explanatory prose in the panel body", async () => {
    // The panel read like documentation; the owner asked for it stripped.
    // Labels stay, paragraphs go.
    stubFetch({ enabled: false, readiness: READY });
    render(<CodingAgentApp />);
    await screen.findByText(translations.en["codingAgent.switchLabel"]);
    expect(screen.queryByText(/open the Terminal app and run claude-ds/)).not.toBeInTheDocument();
    expect(screen.queryByText(/works in the background inside a project folder/)).not.toBeInTheDocument();
  });

  it("says nothing at all about readiness when the harness is fine", async () => {
    // A row that always reads "Ready" never tells the owner anything. The
    // checklist earns its space only when something is actually missing.
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentApp />);
    await screen.findByText(translations.en["codingAgent.switchLabel"]);
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

  describe("the default project folder", () => {
    it("shows what the device has stored", async () => {
      stubFetch({ enabled: true, readiness: READY, defaultDirectory: "/home/clawbox/projects" });
      render(<CodingAgentApp />);
      await waitFor(() => expect(screen.getByTestId("coding-agent-folder")).toHaveValue("/home/clawbox/projects"));
    });

    it("saves what was typed, and renders back what the device recorded", async () => {
      // The route resolves symlinks, so what comes back may not be what was
      // typed — the field must show the device's answer, not the draft.
      stubFetch({ enabled: true, readiness: READY }, [], { resolveTo: "/home/clawbox/real" });
      render(<CodingAgentApp />);
      const field = await screen.findByTestId("coding-agent-folder");
      fireEvent.change(field, { target: { value: "/home/clawbox/link" } });
      fireEvent.click(screen.getByRole("button", { name: translations.en["codingAgent.folderSave"] }));

      await waitFor(() => expect(posts).toContainEqual({
        url: "/setup-api/coding-agent/enable", body: { defaultDirectory: "/home/clawbox/link" },
      }));
      await waitFor(() => expect(field).toHaveValue("/home/clawbox/real"));
    });

    it("clears the default with an empty field, rather than saving a blank path", async () => {
      stubFetch({ enabled: true, readiness: READY, defaultDirectory: "/home/clawbox/projects" });
      render(<CodingAgentApp />);
      const field = await screen.findByTestId("coding-agent-folder");
      await waitFor(() => expect(field).toHaveValue("/home/clawbox/projects"));
      fireEvent.change(field, { target: { value: "  " } });
      fireEvent.click(screen.getByRole("button", { name: translations.en["codingAgent.folderSave"] }));
      await waitFor(() => expect(posts).toContainEqual({
        url: "/setup-api/coding-agent/enable", body: { defaultDirectory: null },
      }));
    });

    it("shows the device's own refusal when the folder is not allowed", async () => {
      stubFetch({ enabled: true, readiness: READY }, [], { rejectDir: "The ClawBox OS checkout itself is off limits." });
      render(<CodingAgentApp />);
      fireEvent.change(await screen.findByTestId("coding-agent-folder"), { target: { value: "/home/clawbox/clawbox" } });
      fireEvent.click(screen.getByRole("button", { name: translations.en["codingAgent.folderSave"] }));
      expect(await screen.findByText(/off limits/)).toBeInTheDocument();
    });
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
      await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/stop", body: { id: "run-k3x9q2ab" } }));
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
