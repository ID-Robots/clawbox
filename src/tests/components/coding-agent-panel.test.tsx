/**
 * Settings → System → Coding agent (src/components/CodingAgentPanel.tsx).
 *
 * The switch renders what the route answers — never what was clicked — and
 * the panel shows the owner what a run needs and what recent runs did, using
 * the real English strings so a missing key fails here rather than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentPanel from "@/components/CodingAgentPanel";

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

function stubFetch(status: { enabled: boolean; readiness: typeof READY | typeof NOT_READY }, runs: unknown[] = []) {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) {
      return json({ ...status, ready: status.enabled && status.readiness.ready, running: 0, harnessCommand: "claude-ds", maxTaskChars: 4000 });
    }
    if (url.startsWith("/setup-api/coding-agent/runs")) return json({ runs });
    if (url === "/setup-api/coding-agent/enable" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ url, body });
      return json({ enabled: body.enabled, ready: body.enabled && status.readiness.ready, readiness: status.readiness, running: 0, harnessCommand: "claude-ds", maxTaskChars: 4000 });
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

describe("CodingAgentPanel", () => {
  it("renders the switch off and turns it on only after the route says so", async () => {
    stubFetch({ enabled: false, readiness: READY });
    render(<CodingAgentPanel />);
    const toggle = await screen.findByRole("switch", { name: translations.en["codingAgent.switchLabel"] });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { enabled: true } }]));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("names the desktop app so the owner does not think the switch disables it", async () => {
    stubFetch({ enabled: false, readiness: READY });
    render(<CodingAgentPanel />);
    expect(await screen.findByText(/Coding Agent app on the desktop is not affected/)).toBeInTheDocument();
  });

  it("lists what a run needs and says what is missing", async () => {
    stubFetch({ enabled: true, readiness: NOT_READY });
    render(<CodingAgentPanel />);
    expect(await screen.findByText(translations.en["codingAgent.readiness"])).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toMatch(/Claude Code is not installed/);
    expect(screen.getByText("Claude Code").parentElement?.textContent).toMatch(/missing/);
    expect(screen.getByText("ClawBox AI").parentElement?.textContent).toMatch(/connected/);
  });

  it("shows recent runs with their outcome, and the summary on demand", async () => {
    stubFetch({ enabled: true, readiness: READY }, [RUN]);
    render(<CodingAgentPanel />);
    expect(await screen.findByText("Add a dark mode toggle")).toBeInTheDocument();
    expect(screen.getByText(translations.en["codingAgent.statusCompleted"])).toBeInTheDocument();
    expect(screen.getByText(/4 turns · 1 files changed/)).toBeInTheDocument();
    expect(screen.getByText(/1 actions were not allowed/)).toBeInTheDocument();
    expect(screen.queryByText(/Added the toggle/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: translations.en["codingAgent.showDetails"] }));
    expect(await screen.findByText(/Added the toggle/)).toBeInTheDocument();
  });

  it("offers Stop only for a running run and posts its id", async () => {
    stubFetch({ enabled: true, readiness: READY }, [{ ...RUN, status: "running", completedAt: null, summary: null }]);
    render(<CodingAgentPanel />);
    const stop = await screen.findByRole("button", { name: translations.en["codingAgent.stop"] });
    fireEvent.click(stop);
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/stop", body: { id: "run-k3x9q2ab" } }));
  });

  it("says when there is nothing to show yet", async () => {
    stubFetch({ enabled: true, readiness: READY }, []);
    render(<CodingAgentPanel />);
    expect(await screen.findByText(translations.en["codingAgent.noRuns"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: translations.en["codingAgent.stop"] })).not.toBeInTheDocument();
  });
});
