/**
 * The chat's coding-run badges.
 *
 * Two bugs shaped this, both found on the real box:
 *
 * 1. `coding_agent_run` answers 202 with a run id in milliseconds, so the
 *    chat's tool pill for it reaches "done" almost at once while the run works
 *    on. Anything driven by the tool-call lifecycle goes quiet while the box is
 *    busy — so these badges follow the DEVICE's run record instead.
 * 2. The first version dropped the badge when the run ended, and runs here take
 *    9-15 seconds: it appeared and vanished while the owner was still reading
 *    the message above it. The badge now STAYS and reports the outcome.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { cleanup, renderHook } from "@testing-library/react";
import { translations } from "@/lib/translations";
import CodingAgentActivityPill from "@/components/CodingAgentActivityPill";
import { artifactUrl, IDLE_POLL_MS, isCodingAgentTool, useCodingAgentActivity } from "@/lib/use-coding-agent-activity";
import { notifyCodingRunStarted, notifyCodingTeamChanged, onCodingRunStarted } from "@/lib/ui-events";

const NOW = Date.now();
const RUNNING = {
  id: "run-k3x9q2ab",
  projectId: "timer",
  task: "Build a countdown timer",
  status: "running",
  startedAt: NOW,
  completedAt: null,
  source: "agent",
};

function runsResponse(runs: unknown[]) {
  return new Response(JSON.stringify({ runs }), { status: 200, headers: { "content-type": "application/json" } });
}

const en = translations.en;
const LABELS = {
  running: en["codingAgent.chatWorking"],
  runningOwner: en["codingAgent.chatWorkingOwner"],
  completed: en["codingAgent.chatFinished"],
  failed: en["codingAgent.chatFailed"],
  stopped: en["codingAgent.chatStopped"],
  paused: en["codingAgent.chatPaused"],
  draft: en["codingAgent.chatDraft"],
  gave_up: en["codingAgent.chatGaveUp"],
  timeLeft: en["codingAgent.timeLeft"],
  tokensWord: en["codingAgent.tokensWord"],
  liveWork: en["codingAgent.chatLiveWork"],
  showDetails: en["codingAgent.showDetails"],
  hideDetails: en["codingAgent.hideDetails"],
  thinking: en["codingAgent.thinking"],
  filesTouched: en["codingAgent.chatFilesTouched"],
  turns: en["codingAgent.chatTurns"],
  plan: en["codingAgent.chatPlan"],
  done: en["codingAgent.chatDone"],
  now: en["codingAgent.chatNow"],
  more: en["codingAgent.chatMore"],
  busy: en["codingAgent.chatBusy"],
  dismiss: en["codingAgent.chatDismiss"],
  steps: {
    screenshot: en["codingAgent.chatScreenshot"],
    lookingAtPage: en["codingAgent.chatLookingAtPage"],
    openingPage: en["codingAgent.chatOpeningPage"],
    drivingPage: en["codingAgent.chatDrivingPage"],
    closingPage: en["codingAgent.chatClosingPage"],
    write: en["codingAgent.chatWrite"],
    edit: en["codingAgent.chatEdit"],
    read: en["codingAgent.chatRead"],
    plan: en["codingAgent.chatPlan"],
  },
};
const OPEN = en["codingAgent.liveView"];
/** The Pause / Resume control's words — the app's own, plus the chat's in-flight ones. */
const CONTROL_LABELS = {
  ...LABELS,
  pause: en["codingAgent.pause"],
  resume: en["codingAgent.resume"],
  pausing: en["codingAgent.chatPausing"],
  resuming: en["codingAgent.chatResuming"],
  pauseFailed: en["codingAgent.pauseFailed"],
  resumeFailed: en["codingAgent.resumeFailed"],
};

/** A run's plan as TodoWrite last wrote it: one done, one on, one to go. */
const TODOS = [
  { content: "Scaffold the page", status: "completed" },
  { content: "Wire the game loop", status: "in_progress", activeForm: "Wiring the game loop" },
  { content: "Add tests", status: "pending" },
] as const;
/**
 * The header is the expand/collapse control. Reached by test id, not by role
 * and name: jsdom computes an accessible name by walking the whole tree, and
 * on the box — where the suite shares the CPU with a live coding run — a few
 * of those queries per test blew the 5 s budget. Its role is asserted once.
 */
const header = () => screen.getByTestId("coding-agent-activity-toggle");
/**
 * How many times the RUNS route was asked. Every poll is two requests since
 * the team list rides on the same beat (`/team?slim=1`), so a test about the
 * poll's cadence counts the run reads, not the fetches.
 */
const runPolls = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/coding-agent/runs")).length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("which tools mean a run may have started", () => {
  it("recognises the coding-agent family and nothing else", () => {
    // The whole coding family since 2026-10-30: a team, a run message, a
    // project tool and the scaffold a run follows all start or change
    // something a card shows.
    for (const name of ["coding_agent_run", "coding_agent_status", "clawbox__coding_agent_run", "coding_team_run", "coding_run_message", "coding_project_status", "code_project_init"]) {
      expect(isCodingAgentTool(name), name).toBe(true);
    }
    for (const name of ["bash", "code_project_build", "web_search", "email_send"]) {
      expect(isCodingAgentTool(name), name).toBe(false);
    }
  });
});

describe("useCodingAgentActivity", () => {
  it("asks the device once when the chat opens, and reports a run in flight", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => { urls.push(String(url)); return runsResponse([RUNNING]); });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));

    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0]).toMatchObject({ id: "run-k3x9q2ab", projectId: "timer", status: "running" });
    expect(urls[0]).toMatch(/\/setup-api\/coding-agent\/runs\?limit=/);
    // The evidence folder rides on the same request — the card thumbnails it.
    expect(urls[0]).toMatch(/[?&]artifacts=1/);
  });

  it("carries the run's newest steps and screenshots, and nothing the card does not draw", async () => {
    const progress = Array.from({ length: 12 }, (_, i) => `step ${i}`);
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([{
      ...RUNNING,
      progress,
      thinkingTokens: 1200,
      numTurns: 4,
      artifacts: [
        { name: "notes.txt", bytes: 10, kind: "text" },
        { name: "shot-1.png", bytes: 100, kind: "image" },
        { name: "shot-2.png", bytes: 100, kind: "image" },
        { name: "shot-3.png", bytes: 100, kind: "image" },
        { name: "shot-4.png", bytes: 100, kind: "image" },
        { name: 7, kind: "image" },
      ],
    }])));

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    const run = result.current.runs[0];
    // The last eight, in order — the runner keeps more, the card has no room.
    expect(run.progress).toEqual(progress.slice(-8));
    // Images only, the newest three, oldest first.
    expect(run.screenshots).toEqual(["shot-2.png", "shot-3.png", "shot-4.png"]);
    expect(run.thinkingTokens).toBe(1200);
    expect(run.numTurns).toBe(4);
    expect(run).not.toHaveProperty("artifacts");
  });

  it("tolerates a record without progress or artifacts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([RUNNING])));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0]).toMatchObject({ progress: [], screenshots: [], thinkingTokens: 0, numTurns: 0, todos: [] });
  });

  it("carries where the run's pull request stands — the phase only — and null when there is none it can read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([
      { ...RUNNING, id: "run-pr", status: "completed", pr: { phase: "review", number: 7, url: "https://example.test/pr/7" } },
      { ...RUNNING, id: "run-none", pr: null },
      { ...RUNNING, id: "run-odd", pr: { phase: "sideways" } },
      { ...RUNNING, id: "run-old" },
    ])));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(4));
    const phases = Object.fromEntries(result.current.runs.map((r) => [r.id, r.prPhase]));
    expect(phases).toEqual({ "run-pr": "review", "run-none": null, "run-odd": null, "run-old": null });
    expect(result.current.runs[0]).not.toHaveProperty("pr");
  });

  it("reads a pull request that was never opened — blocked with no number, nothing committed — as none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([
      { ...RUNNING, id: "run-empty", status: "completed", pr: { phase: "blocked", number: null, detail: "Nothing was committed, so there is no pull request to open." } },
      { ...RUNNING, id: "run-held", status: "completed", pr: { phase: "blocked", number: 42, detail: "A check failed." } },
    ])));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(2));
    const phases = Object.fromEntries(result.current.runs.map((r) => [r.id, r.prPhase]));
    // The first is done with, like a run with auto-PR off; the second is on GitHub, waiting for the owner.
    expect(phases).toEqual({ "run-empty": null, "run-held": "blocked" });
  });

  it("carries the run's plan, and only the items it can draw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([{
      ...RUNNING,
      todos: [...TODOS, { content: "Odd", status: "weird" }, { status: "completed" }, "nope", null],
    }])));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0].todos).toEqual([...TODOS, { content: "Odd", status: "pending" }]);
  });

  it("reads a plan that is not a list as no plan", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([{ ...RUNNING, todos: "soon" }])));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0].todos).toEqual([]);
  });

  it("builds the served URL of a screenshot with both parts encoded", () => {
    expect(artifactUrl("run-k3x9q2ab", "after fix.png"))
      .toBe("/setup-api/coding-agent/artifacts?runId=run-k3x9q2ab&file=after%20fix.png");
  });

  it("KEEPS the badge after the run ends, carrying the outcome", async () => {
    vi.useFakeTimers();
    let status = "running";
    const fetchMock = vi.fn(async () =>
      runsResponse([{ ...RUNNING, status, completedAt: status === "running" ? null : NOW + 12_000 }]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.runs[0].status).toBe("running");

    status = "completed";
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

    // Still there — this is the regression the owner reported.
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].status).toBe("completed");
    expect(result.current.runs[0].completedAt).toBe(NOW + 12_000);
  });

  it("hands back the SAME list while a poll answers what is already on screen", async () => {
    // Every poll parses a fresh answer. Handed back as it came, it re-rendered
    // the whole chat every five seconds for as long as a run was live, to draw
    // exactly what was already there.
    vi.useFakeTimers();
    const other = { ...RUNNING, id: "run-other", task: "Another", startedAt: NOW + 1 };
    let progress = ["Read src/app.ts"];
    const fetchMock = vi.fn(async () =>
      runsResponse([{ ...RUNNING, progress, subagentsByType: { explorer: 1 } }, other]));
    vi.stubGlobal("fetch", fetchMock);

    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useCodingAgentActivity(true); });
    await act(async () => { await Promise.resolve(); });
    const first = result.current.runs;
    expect(first).toHaveLength(2);

    // React may call a component once more to find out that an update
    // changed nothing (it then bails out of the commit); from there on an
    // unchanged answer costs no render at all.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    const settled = renders;
    for (let i = 0; i < 3; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5); // still polling: a run is live
    expect(result.current.runs).toBe(first);
    expect(renders).toBe(settled);

    // One run moves on: a new list, the run that moved a new object, the one
    // that did not the very same.
    progress = ["Read src/app.ts", "Edit src/app.ts"];
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    const moved = result.current.runs;
    expect(moved).not.toBe(first);
    expect(moved[0]).not.toBe(first[0]);
    expect(moved[0].progress).toEqual(["Read src/app.ts", "Edit src/app.ts"]);
    expect(moved[1]).toBe(first[1]);
  });

  it("keeps badges as the conversation continues, and drops to the slow idle check once nothing runs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => runsResponse([{ ...RUNNING, status: "completed", completedAt: NOW + 9_000 }]));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ open }) => useCodingAgentActivity(open), {
      initialProps: { open: true },
    });
    await act(async () => { await Promise.resolve(); });
    const calls = runPolls(fetchMock);

    // Messages keep arriving and the chat re-renders: the badge stays, and
    // only the slow idle check asks — not the five-second poll.
    rerender({ open: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 100); });
    expect(result.current.runs).toHaveLength(1);
    expect(runPolls(fetchMock)).toBe(calls);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(runPolls(fetchMock)).toBe(calls + 1);
  });

  it("asks once more after a run it watched settles — the review pass starts after the record is written", async () => {
    // The runner persists the settled record before it commits and starts
    // the automatic review pass, so the poll that saw the finish cannot have
    // seen the run that follows it. One round more; not a timer.
    vi.useFakeTimers();
    let status = "running";
    // At work: its harness has spoken (a session id), so it is past its start
    // and on the five-second beat, not the start beat.
    const fetchMock = vi.fn(async () =>
      runsResponse([{ ...RUNNING, sessionId: "sess-k3x9q2ab", status, completedAt: status === "running" ? null : NOW + 12_000 }]));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(runPolls(fetchMock)).toBe(1);

    status = "completed";
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(runPolls(fetchMock)).toBe(2); // saw it settle
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(runPolls(fetchMock)).toBe(3); // the one round owed
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1_000); });
    expect(runPolls(fetchMock)).toBe(3); // then only the slow idle check
  });

  it("finds a run started where the chat cannot see it — API, MCP, another session — with the idle check, no refresh", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => runsResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.runs).toHaveLength(0);

    // No event, no nudge: the run simply appears on the device.
    fetchMock.mockImplementation(async () => runsResponse([{ ...RUNNING, startedAt: Date.now() }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_POLL_MS + 100); });
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].status).toBe("running");
  });

  it("keeps checking after a failed request — one blip used to stop polling until a reload", async () => {
    vi.useFakeTimers();
    let fail = true;
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error("offline");
      return runsResponse([RUNNING]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(runPolls(fetchMock)).toBe(1);

    fail = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_POLL_MS + 100); });
    expect(runPolls(fetchMock)).toBe(2);
    expect(result.current.runs).toHaveLength(1);
  });

  it("does not idle-check a hidden tab — coming back into view re-asks instead", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => runsResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      renderHook(() => useCodingAgentActivity(true));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3); });
      expect(runPolls(fetchMock)).toBe(1);
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("asks again when the desktop says a run started — begun from the Coding Agent app while the chat sat open", async () => {
    // Nothing the chat sees passes through it for such a run, so without
    // this the card only ever appeared if the chat was reopened in time.
    const fetchMock = vi.fn(async () => runsResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(runPolls(fetchMock)).toBe(1);
    expect(result.current.runs).toHaveLength(0);

    fetchMock.mockImplementation(async () => runsResponse([RUNNING]));
    act(() => { notifyCodingRunStarted(); });
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(runPolls(fetchMock)).toBe(2);
  });

  it("does not hear the desktop while the chat is closed", async () => {
    const fetchMock = vi.fn(async () => runsResponse([RUNNING]));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useCodingAgentActivity(false));
    act(() => { notifyCodingRunStarted(); });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks again when the tab comes back into view", async () => {
    const fetchMock = vi.fn(async () => runsResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    try {
      renderHook(() => useCodingAgentActivity(true));
      await act(async () => { await Promise.resolve(); });
      expect(runPolls(fetchMock)).toBe(1);

      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => { await Promise.resolve(); });
      expect(runPolls(fetchMock)).toBe(2);
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("does not adopt runs that finished before this conversation", async () => {
    const old = {
      ...RUNNING, id: "run-yesterday", status: "completed",
      startedAt: NOW - 86_400_000, completedAt: NOW - 86_390_000,
    };
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([old])));

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.runs).toHaveLength(0);
  });

  it("asks nothing at all while the chat is closed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => runsResponse([RUNNING]));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useCodingAgentActivity(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the badges alone when the device cannot be reached", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (fail) throw new Error("offline");
      return runsResponse([RUNNING]);
    }));

    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    // A failed request must not rewrite what already happened.
    fail = true;
    act(() => { result.current.nudge(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.runs).toHaveLength(1);
  });
});

describe("the badge", () => {
  const pill = (over: Record<string, unknown> = {}) => {
    render(
      <CodingAgentActivityPill
        run={{
          id: "run-k3x9q2ab", projectId: "timer", task: "x",
          startedAt: NOW - 95_000, completedAt: null,
          status: "running", source: "agent", ...over,
        } as never}
        labels={LABELS}
        openLabel={OPEN}
      />,
    );
    return screen.getByTestId("coding-agent-activity");
  };

  it("names the work, the project and how long it has been going", () => {
    const el = pill();
    expect(el.textContent).toContain(LABELS.running);
    expect(el.textContent).toContain("timer");
    expect(el.textContent).toMatch(/1m 3[0-9]s/);
    expect(el).toHaveAttribute("role", "status");
    expect(el).toHaveAttribute("data-status", "running");
  });

  it("reports the outcome once the run is over, and freezes the time it took", () => {
    const el = pill({ status: "completed", startedAt: NOW - 95_000, completedAt: NOW - 83_000 });
    expect(el.textContent).toContain(LABELS.completed);
    expect(el.textContent).toContain("12s"); // completedAt - startedAt, not "now"
    expect(el).toHaveAttribute("data-status", "completed");
    // A settled badge must not keep announcing itself as it scrolls by.
    expect(el).toHaveAttribute("aria-live", "off");
  });

  it("says plainly when a run did not finish", () => {
    expect(pill({ status: "failed", completedAt: NOW }).textContent).toContain(LABELS.failed);
  });

  it("says plainly when a run was stopped", () => {
    expect(pill({ status: "stopped", completedAt: NOW }).textContent).toContain(LABELS.stopped);
  });

  it("does not credit the assistant for a run the owner started", () => {
    const el = pill({ source: "owner" });
    expect(el.textContent).toContain(LABELS.runningOwner);
    expect(el.textContent).not.toContain(LABELS.running);
  });

  it("shows the newest progress line while the run is live, as a chip", () => {
    const el = pill({ progress: ["Write app.js", "$ npm test"] });
    expect(el.textContent).toContain("npm test");
    expect(el.textContent).not.toContain("app.js"); // collapsed: the newest step only
    expect(screen.getByTestId("coding-agent-activity-progress")).toBeInTheDocument();
  });

  it("drops the progress line once the run has settled — the card reports the outcome, not its last step", () => {
    const el = pill({ status: "completed", completedAt: NOW, progress: ["$ npm test"] });
    expect(el.textContent).not.toContain("npm test");
  });

  it("offers a way into the app only when there is somewhere to go", () => {
    const onOpen = vi.fn();
    const run = {
      id: "run-x", projectId: null, task: "x", startedAt: NOW,
      completedAt: null, status: "running" as const, source: "agent" as const,
      subagentsTotal: 0, subagentsActive: 0, subagentsByType: {}, tokensUsed: 0, thinkingTokens: 0,
      filesTouched: 0, numTurns: 0, progress: [], screenshots: [], todos: [],
      transcriptPath: null, sessionId: null, directory: null,
    };
    const { rerender } = render(
      <CodingAgentActivityPill run={run} labels={LABELS} openLabel={OPEN} onOpen={onOpen} />,
    );
    screen.getByTitle(OPEN).click();
    expect(onOpen).toHaveBeenCalledTimes(1);

    rerender(<CodingAgentActivityPill run={run} labels={LABELS} openLabel={OPEN} />);
    expect(screen.queryByTitle(OPEN)).not.toBeInTheDocument();
  });
});

/**
 * View: the run's own page in the app, full-screen. The pill used to carry an
 * underlined "open" link and a separate "Live view" that popped a floating
 * terminal; the owner asked for one button, and the live terminal lives on
 * the run's page now.
 */
describe("the card's View button", () => {
  it("is the one way into the app, whatever the run's state", () => {
    const onOpen = vi.fn();
    const base = {
      id: "run-live001", projectId: "timer", task: "x",
      startedAt: NOW - 30_000, completedAt: null as number | null,
      source: "agent" as const,
      subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
      tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, numTurns: 0,
      progress: [], screenshots: [], todos: [],
      transcriptPath: "/home/clawbox/.claude-ds/projects/x/s.jsonl", sessionId: null, directory: "/home/clawbox/Projects/timer",
    };
    const { rerender } = render(
      <CodingAgentActivityPill run={{ ...base, status: "running" }} labels={LABELS} openLabel={OPEN} onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByTestId("coding-agent-activity-view"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("coding-agent-activity-live-view")).toBeNull();
    rerender(
      <CodingAgentActivityPill run={{ ...base, status: "completed", completedAt: NOW }} labels={LABELS} openLabel={OPEN} onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByTestId("coding-agent-activity-view"));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

/**
 * The owner's ask: a run lasts many minutes and its card is the last thing in
 * the transcript, so it sat under every new message the whole time. The × on
 * the header row puts the card away; the CHAT owns what is dismissed (its
 * `dismissedCodingRuns`, tested in chat-coding-card-dismiss.test.tsx), so the
 * card only asks.
 */
describe("the card's × (dismiss)", () => {
  const base = {
    id: "run-k3x9q2ab", projectId: "timer", task: "x",
    startedAt: NOW - 30_000, completedAt: null as number | null,
    status: "running" as const, source: "agent" as const,
    subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
    tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, numTurns: 0,
    progress: [], screenshots: [], todos: [],
    transcriptPath: null, sessionId: null, directory: null,
  };

  it("asks the chat to put the card away, and does not expand the card on the way", () => {
    const onDismiss = vi.fn();
    render(<CodingAgentActivityPill run={base} labels={LABELS} openLabel={OPEN} onOpen={vi.fn()} onDismiss={onDismiss} />);
    const close = screen.getByTestId("coding-agent-activity-dismiss");
    // Named for a screen reader: an icon-only button beside two others.
    expect(close).toHaveAttribute("aria-label", LABELS.dismiss);
    expect(close).toHaveAttribute("title", LABELS.dismiss);
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // The click stopped at the button — the card is the toggle, and putting
    // it away is not a request to open it first.
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("coding-agent-activity-details")).not.toBeInTheDocument();
  });

  it("does not collapse a card that was open, either — the chat unmounts it, the card changes nothing itself", () => {
    const onDismiss = vi.fn();
    render(<CodingAgentActivityPill run={base} labels={LABELS} openLabel={OPEN} onDismiss={onDismiss} />);
    fireEvent.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByTestId("coding-agent-activity-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(header()).toHaveAttribute("aria-expanded", "true");
  });

  it("is there on a finished card too — the record can be put away like the live one", () => {
    const onDismiss = vi.fn();
    render(
      <CodingAgentActivityPill run={{ ...base, status: "completed", completedAt: NOW }} labels={LABELS} openLabel={OPEN} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByTestId("coding-agent-activity-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("sits in the header row beside the chevron and View, and leaves both working", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(<CodingAgentActivityPill run={base} labels={LABELS} openLabel={OPEN} onOpen={onOpen} onDismiss={onDismiss} />);
    const close = screen.getByTestId("coding-agent-activity-dismiss");
    const view = screen.getByTestId("coding-agent-activity-view");
    // Same row: the three share one parent, in the order chevron · View · ×.
    expect(close.parentElement).toBe(view.parentElement);
    expect(close.parentElement).toBe(header().parentElement);
    expect(view.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(view);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("is not drawn at all when nothing would answer it", () => {
    render(<CodingAgentActivityPill run={base} labels={LABELS} openLabel={OPEN} onOpen={vi.fn()} />);
    expect(screen.queryByTestId("coding-agent-activity-dismiss")).not.toBeInTheDocument();
  });
});

describe("the card, expanded", () => {
  const SHOT_URL = artifactUrl("run-k3x9q2ab", "after.png");
  const card = (over: Record<string, unknown> = {}, onPreview?: (src: string, alt: string) => void) => {
    render(
      <CodingAgentActivityPill
        run={{
          id: "run-k3x9q2ab", projectId: "timer", task: "x",
          startedAt: NOW - 30_000, completedAt: null,
          status: "running", source: "agent",
          subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
          transcriptPath: null, sessionId: null, directory: null,
          tokensUsed: 46_000, thinkingTokens: 0, filesTouched: 3, numTurns: 0,
          progress: ["Write style.css", "Now the JavaScript:", "$ node --check /home/clawbox/clawbox/data/app.js", "mcp__clawbox__browser_screenshot"],
          screenshots: ["before.png", "after.png"],
          todos: [],
          ...over,
        }}
        labels={LABELS}
        openLabel={OPEN}
        onOpen={vi.fn()}
        onPreview={onPreview}
      />,
    );
    return screen.getByTestId("coding-agent-activity");
  };

  it("collapsed, the newest step is a 'Screenshot' chip — never the raw mcp__ name", () => {
    const el = card();
    expect(el.textContent).toContain(LABELS.steps.screenshot);
    expect(el.textContent).not.toMatch(/mcp__/);
    expect(header()).toHaveAttribute("role", "button");
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("coding-agent-activity-details")).not.toBeInTheDocument();
  });

  it("the collapsed Screenshot chip opens the newest screenshot in the chat's preview", () => {
    const onPreview = vi.fn();
    card({}, onPreview);
    const chip = screen.getByTestId("coding-agent-activity-progress").querySelector("button");
    expect(chip?.textContent).toContain(LABELS.steps.screenshot);
    fireEvent.click(chip!);
    expect(onPreview).toHaveBeenCalledWith(SHOT_URL, "after.png");
    // Opening the picture is not a request to expand the card.
    expect(header()).toHaveAttribute("aria-expanded", "false");
  });

  it("the Screenshot chip is not a control when the run has saved no picture yet", () => {
    card({ screenshots: [] }, vi.fn());
    const line = screen.getByTestId("coding-agent-activity-progress");
    expect(line.querySelector("button")).toBeNull();
    expect(line.textContent).toContain(LABELS.steps.screenshot);
  });

  it("a click expands the card into the live-work panel: the last steps as chips, the counters, the screenshots", () => {
    const el = card();
    fireEvent.click(el);
    expect(header()).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByTestId("coding-agent-activity-details");
    expect(details.textContent).toContain(LABELS.liveWork);

    const steps = screen.getByTestId("coding-agent-activity-steps");
    const chips = Array.from(steps.querySelectorAll("li"));
    expect(chips).toHaveLength(4);
    expect(chips[0].textContent).toContain(`${LABELS.steps.write}`);
    expect(chips[0].textContent).toContain("style.css");
    expect(chips[1].textContent).toContain("Now the JavaScript:");
    expect(chips[2].textContent).toContain("node --check data/app.js"); // device prefix gone
    expect(chips[3].textContent).toContain(LABELS.steps.screenshot);
    expect(steps.textContent).not.toMatch(/mcp__/);
    // The one-line chip gives way to the list; the same step is not shown twice.
    expect(screen.queryByTestId("coding-agent-activity-progress")).not.toBeInTheDocument();

    const counters = screen.getByTestId("coding-agent-activity-counters").textContent ?? "";
    expect(counters).toContain(`46k ${LABELS.tokensWord}`);
    expect(counters).toContain(`3 ${LABELS.filesTouched}`);
    // Turns arrive with the final result; a live run must not claim "0 turns".
    expect(counters).not.toContain(LABELS.turns);

    const imgs = Array.from(screen.getByTestId("coding-agent-activity-screenshots").querySelectorAll("img"));
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([artifactUrl("run-k3x9q2ab", "before.png"), SHOT_URL]);
    expect(imgs[1]).toHaveAttribute("alt", "after.png");
    expect(imgs[1]).toHaveAttribute("loading", "lazy");
  });

  it("shows thinking tokens and turns once there are any", () => {
    card({ thinkingTokens: 2_300, numTurns: 12, status: "completed", completedAt: NOW });
    fireEvent.click(header());
    const counters = screen.getByTestId("coding-agent-activity-counters").textContent ?? "";
    expect(counters).toContain(LABELS.thinking.replace("{n}", "2k"));
    expect(counters).toContain(`12 ${LABELS.turns}`);
  });

  it("a thumbnail opens that screenshot in the chat's preview, without collapsing the card", () => {
    const onPreview = vi.fn();
    card({}, onPreview);
    fireEvent.click(header());
    fireEvent.click(screen.getByTitle("after.png"));
    expect(onPreview).toHaveBeenCalledWith(SHOT_URL, "after.png");
    expect(header()).toHaveAttribute("aria-expanded", "true");
  });

  it("a click inside the expanded panel — to read a step or the counters — does not collapse it", () => {
    card();
    fireEvent.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "true");

    // A free-text step is a plain span, not a button: nothing of its own to
    // stop the click, so the panel has to.
    const steps = screen.getByTestId("coding-agent-activity-steps");
    const text = steps.querySelector('[data-kind="text"]');
    expect(text?.textContent).toContain("Now the JavaScript:");
    fireEvent.click(text!);
    expect(header()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByTestId("coding-agent-activity-counters"));
    expect(header()).toHaveAttribute("aria-expanded", "true");

    // The panel's own surface — the gap between two thumbnails, say.
    fireEvent.click(screen.getByTestId("coding-agent-activity-details"));
    expect(header()).toHaveAttribute("aria-expanded", "true");

    // The header still collapses it: the panel is inert, the card is not.
    fireEvent.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles from the keyboard with Enter and Space, and ignores other keys", () => {
    card();
    fireEvent.keyDown(header(), { key: "Enter" });
    expect(header()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(header(), { key: " " });
    expect(header()).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(header(), { key: "Tab" });
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(header()).toHaveAttribute("tabindex", "0");
  });

  it("names its state for a screen reader and says what a press does", () => {
    card();
    expect(header()).toHaveAttribute("title", LABELS.showDetails);
    fireEvent.click(header());
    expect(header()).toHaveAttribute("title", LABELS.hideDetails);
  });

  it("the open link goes to the app and does not toggle the card", () => {
    card();
    fireEvent.click(screen.getByTitle(OPEN));
    expect(header()).toHaveAttribute("aria-expanded", "false");
  });

  it("a finished run stays expandable — its steps are the record of what it did", () => {
    const el = card({ status: "completed", completedAt: NOW, numTurns: 6 });
    expect(screen.queryByTestId("coding-agent-activity-progress")).not.toBeInTheDocument();
    fireEvent.click(el);
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("coding-agent-activity-steps").querySelectorAll("li")).toHaveLength(4);
    expect(screen.getByTestId("coding-agent-activity-counters").textContent).toContain(`6 ${LABELS.turns}`);
  });

  it("the panel does not narrate its every change inside the live card", () => {
    card();
    fireEvent.click(header());
    expect(screen.getByTestId("coding-agent-activity-details")).toHaveAttribute("aria-live", "off");
  });
});

/**
 * The owner's next ask, in their words: "Add some animation to indicate
 * Agent Working. In live work show summaries of current tasks if possible."
 * The summaries are the run's own TodoWrite plan; the animation is three
 * compositor-only signs of life that stop the moment the run does.
 */
describe("the plan and the signs of life", () => {
  const card = (over: Record<string, unknown> = {}) => {
    render(
      <CodingAgentActivityPill
        run={{
          id: "run-k3x9q2ab", projectId: "timer", task: "x",
          startedAt: NOW - 30_000, completedAt: null,
          status: "running", source: "agent",
          subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
          transcriptPath: null, sessionId: null, directory: null,
          tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, numTurns: 0,
          progress: ["Read app.js", "Plan: 3 tasks, 1 done"],
          screenshots: [],
          todos: [...TODOS],
          ...over,
        }}
        labels={LABELS}
        openLabel={OPEN}
      />,
    );
    return screen.getByTestId("coding-agent-activity");
  };

  it("collapsed and live, says what the run is on now in its own words, above the newest step", () => {
    const el = card();
    const now = screen.getByTestId("coding-agent-activity-now");
    expect(now.textContent).toContain(`${LABELS.now}:`);
    expect(now.textContent).toContain("Wiring the game loop"); // the activeForm, not the content
    expect(now.textContent).not.toContain("Wire the game loop");
    // The step chip is still there, after it: the tool call and the intent
    // both fit — and its counts are in the owner's words, never the runner's
    // "3 tasks, 1 done".
    const chip = screen.getByTestId("coding-agent-activity-progress");
    expect(chip.textContent).toContain(LABELS.plan);
    expect(chip.textContent).toContain(`1/3 ${LABELS.done}`);
    expect(chip.textContent).not.toContain("tasks");
    expect(now.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.textContent).not.toContain("Add tests"); // collapsed: the list waits for a click
  });

  it("falls back to the item's content when the tool sent no present-tense form", () => {
    card({ todos: [{ content: "Wire the game loop", status: "in_progress" }] });
    expect(screen.getByTestId("coding-agent-activity-now").textContent).toContain("Wire the game loop");
  });

  it("has no 'now' line without an item in progress, or once the run has settled", () => {
    card({ todos: [{ content: "Add tests", status: "pending" }] });
    expect(screen.queryByTestId("coding-agent-activity-now")).not.toBeInTheDocument();
    cleanupRender();
    card({ status: "completed", completedAt: NOW });
    expect(screen.queryByTestId("coding-agent-activity-now")).not.toBeInTheDocument();
  });

  it("expanded, draws the plan as a checklist above the steps — done, in progress, pending", () => {
    card();
    fireEvent.click(header());
    const plan = screen.getByTestId("coding-agent-activity-plan");
    expect(plan.textContent).toContain(`${LABELS.plan} · 1/3 ${LABELS.done}`);
    const items = Array.from(screen.getByTestId("coding-agent-activity-todos").querySelectorAll("li"));
    expect(items.map((li) => li.getAttribute("data-status"))).toEqual(["completed", "in_progress", "pending"]);
    expect(items[0].textContent).toContain("✓");
    expect(items[0].textContent).toContain("Scaffold the page");
    expect(items[1].textContent).toContain("●");
    expect(items[1].textContent).toContain("Wiring the game loop");
    expect(items[2].textContent).toContain("○");
    expect(items[2].textContent).toContain("Add tests");
    // The state a screen reader hears — the glyphs are aria-hidden and a
    // colour or a strike-through is not voiced: "current step" on the one in
    // progress, the word "done" before a finished item, a pending item bare.
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(items[2]).not.toHaveAttribute("aria-current");
    expect(items[0].querySelector(".sr-only")?.textContent?.trim()).toBe(LABELS.done);
    expect(items[1].querySelector(".sr-only")).toBeNull();
    expect(items[2].querySelector(".sr-only")).toBeNull();
    // Intent first, then the tool calls that carry it out.
    const steps = screen.getByTestId("coding-agent-activity-steps");
    expect(plan.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Expanded, the checklist IS the "now" line; it is not said twice.
    expect(screen.queryByTestId("coding-agent-activity-now")).not.toBeInTheDocument();
  });

  it("folds a long plan to eight items around the one in progress, and counts the rest", () => {
    const todos = Array.from({ length: 14 }, (_, i) => ({
      content: `task ${i}`,
      status: i < 9 ? "completed" : i === 9 ? "in_progress" : "pending",
    }));
    card({ todos });
    fireEvent.click(header());
    const items = Array.from(screen.getByTestId("coding-agent-activity-todos").querySelectorAll("li"));
    expect(items).toHaveLength(8);
    expect(items.some((li) => li.getAttribute("data-status") === "in_progress")).toBe(true);
    expect(items[items.length - 1].textContent).toContain("task 11"); // a little of what comes next
    expect(screen.getByTestId("coding-agent-activity-todos-more").textContent)
      .toBe(LABELS.more.replace("{n}", "6"));
    expect(screen.getByTestId("coding-agent-activity-plan").textContent).toContain(`9/14 ${LABELS.done}`);
  });

  it("shows no plan section for a run that never planned", () => {
    card({ todos: [] });
    fireEvent.click(header());
    expect(screen.queryByTestId("coding-agent-activity-plan")).not.toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-activity-steps")).toBeInTheDocument();
  });

  it("moves while the run is live: the glyph breathes, three dots step, the item in progress pulses", () => {
    const el = card();
    const dots = screen.getByTestId("coding-agent-activity-working");
    expect(dots).toHaveClass("coding-agent-working");
    expect(dots.querySelectorAll("span")).toHaveLength(3);
    expect(dots).toHaveAttribute("aria-label", LABELS.busy);
    // The 🤖 and the "now" marker, collapsed…
    expect(el.querySelectorAll(".coding-agent-pulse").length).toBeGreaterThanOrEqual(2);
    // …and the in-progress item's dot, expanded.
    fireEvent.click(header());
    const active = screen.getByTestId("coding-agent-activity-todos").querySelector('li[data-status="in_progress"]');
    expect(active?.querySelector(".coding-agent-pulse")).not.toBeNull();
    const done = screen.getByTestId("coding-agent-activity-todos").querySelector('li[data-status="completed"]');
    expect(done?.querySelector(".coding-agent-pulse")).toBeNull();
  });

  it("is still once the run has settled — nothing animates on a finished card", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      const el = card({ status, completedAt: NOW });
      expect(screen.queryByTestId("coding-agent-activity-working")).not.toBeInTheDocument();
      expect(el.querySelector(".coding-agent-pulse")).toBeNull();
      fireEvent.click(header());
      expect(el.querySelector(".coding-agent-pulse")).toBeNull();
      expect(el.querySelector(".coding-agent-working")).toBeNull();
      cleanupRender();
    }
  });

  it("is animated by the compositor only, and holds still under reduced motion", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf-8");
    const block = css.slice(css.indexOf("Coding agent card"));
    expect(block.length).toBeGreaterThan(0);
    for (const name of ["coding-agent-breathe", "coding-agent-dot"]) {
      const frames = /@keyframes\s+NAME\s*\{([\s\S]*?)\n\}/.source.replace("NAME", name);
      const body = new RegExp(frames).exec(block)?.[1] ?? "";
      expect(body, `@keyframes ${name}`).not.toBe("");
      // Every animated property is one the compositor owns — no filter, no
      // blur, no layout property, on a Jetson that is already running the run.
      const props = Array.from(body.matchAll(/([a-z-]+)\s*:/g)).map((m) => m[1]);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) expect(["opacity", "transform"], `${name} animates ${p}`).toContain(p);
    }
    const guard = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(block)?.[1] ?? "";
    expect(guard).toContain(".coding-agent-pulse");
    expect(guard).toContain(".coding-agent-working-dot");
    expect(guard).toContain("animation: none");
  });
});

/** Unmount between two renders inside one test, the way the setup's afterEach does. */
function cleanupRender() {
  cleanup();
}

// ── The 2026-10-30 redesign: teams on the same beat, members hidden, the settled card ──

function pollResponse(runs: unknown[], teams: unknown[] | null) {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/coding-agent/team")) {
      if (teams === null) return new Response(JSON.stringify({ error: "owner_only" }), { status: 403 });
      return new Response(JSON.stringify({ teams }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return runsResponse(runs);
  });
}

const TEAM_PAYLOAD = {
  id: "team-k3x9q2ab",
  goal: "Settings drawer and export",
  projectId: "sca",
  directory: "/srv/projects/sca",
  status: "working",
  source: "agent",
  createdAt: NOW - 60_000,
  finishedAt: null,
  error: null,
  metrics: { tokensUsed: 46_000 },
  card: { phase: "working", tasksDone: 1, tasksTotal: 2, tasks: [{ id: "T1", title: "Drawer", status: "complete", verdict: "accepted", workerRunId: "run-00000002", reviewerRunId: null }], prNumber: null, resultLine: null, agents: [{ role: "worker", runId: "run-00000002", state: "done" }] },
};

describe("useCodingAgentActivity — teams and member runs", () => {
  it("reads the slim team list on the same beat as the runs and hands the teams back with their card", async () => {
    const fetchMock = pollResponse([RUNNING], [TEAM_PAYLOAD]);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringMatching(/\/setup-api\/coding-agent\/runs\?limit=/),
      "/setup-api/coding-agent/team?slim=1",
    ]);
    expect(result.current.teams[0]).toMatchObject({
      id: "team-k3x9q2ab", projectId: "sca", goal: "Settings drawer and export", status: "working",
      tasksDone: 1, tasksTotal: 2, prNumber: null, tokensUsed: 46_000,
    });
    expect(result.current.teams[0].tasks).toHaveLength(1);
    expect(result.current.teams[0].agents).toHaveLength(1);
    expect(result.current.runs).toHaveLength(1);
  });

  it("keeps the runs when the team list is refused — a signed-in person who is not the owner", async () => {
    vi.stubGlobal("fetch", pollResponse([RUNNING], null));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.teams).toEqual([]);
  });

  it("never draws a team's member run as a card of its own once the team is listed", async () => {
    const member = { ...RUNNING, id: "run-member001", team: { id: "team-k3x9q2ab", role: "worker", taskId: "T1" } };
    vi.stubGlobal("fetch", pollResponse([member, RUNNING], [TEAM_PAYLOAD]));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0].id).toBe("run-k3x9q2ab");
    expect(result.current.runs[0].teamId).toBeNull();
    expect(result.current.teams).toHaveLength(1);
  });

  it("holds a member whose team is not listed yet for one poll, then shows it on its own", async () => {
    vi.useFakeTimers();
    const member = { ...RUNNING, id: "run-member001", team: { id: "team-missing1", role: "worker", taskId: "T1" } };
    vi.stubGlobal("fetch", pollResponse([member], []));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    // First sight: held, no flicker.
    expect(result.current.runs).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    // Still no team after a poll: the run is its own card after all.
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].teamId).toBe("team-missing1");
  });

  it("keeps polling fast while a team works even when no run does", async () => {
    vi.useFakeTimers();
    const fetchMock = pollResponse([], [TEAM_PAYLOAD]);
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(runPolls(fetchMock)).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(runPolls(fetchMock)).toBe(2);
  });

  it("asks again when the desktop says a team changed", async () => {
    const fetchMock = pollResponse([], []);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await act(async () => { await Promise.resolve(); });
    expect(runPolls(fetchMock)).toBe(1);
    fetchMock.mockImplementation(pollResponse([], [TEAM_PAYLOAD]));
    act(() => { notifyCodingTeamChanged(); });
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
  });

  it("carries the settled card's fields: the result's first sentence, the error's first line, the PR number, the refused line", async () => {
    vi.stubGlobal("fetch", pollResponse([
      { ...RUNNING, id: "run-done00001", status: "completed", completedAt: NOW + 9_000, summaryLine: "Added the drawer.", pr: { number: 12, phase: "merged" } },
      { ...RUNNING, id: "run-fail00001", status: "failed", completedAt: NOW + 9_000, error: "Build failed: exit 1\nmore" },
      { ...RUNNING, id: "run-pause0001", status: "paused", denials: [{ text: "Read: /srv/notes.md", rule: null, refusal: null }] },
    ], []));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(3));
    const byId = Object.fromEntries(result.current.runs.map((r) => [r.id, r]));
    expect(byId["run-done00001"]).toMatchObject({ summaryLine: "Added the drawer.", prNumber: 12, needsYou: false, errorLine: null });
    expect(byId["run-fail00001"]).toMatchObject({ errorLine: "Build failed: exit 1", summaryLine: null });
    expect(byId["run-pause0001"]).toMatchObject({ needsYou: true, refusedLine: "Read: /srv/notes.md" });
  });
});

describe("CodingAgentActivityPill — the settled card and Needs you", () => {
  const SETTLED_LABELS = { ...LABELS, needsYou: en["codingAgent.chatNeedsYou"], files: en["codingAgent.chatFiles"], pr: en["codingAgent.chatPr"] };
  const base = {
    ...RUNNING, subagentsTotal: 2, subagentsActive: 0, subagentsByType: {}, tokensUsed: 46_000, thinkingTokens: 0, filesTouched: 2, numTurns: 9,
    progress: ["$ bun test"], screenshots: [], todos: [], transcriptPath: null, sessionId: null, directory: null, teamId: null,
  };

  it("done: the result's first sentence, files and time, a PR chip, Open — no progress, no dots", () => {
    render(
      <CodingAgentActivityPill
        run={{ ...base, status: "completed", completedAt: NOW + 9 * 60_000, summaryLine: "Added a settings drawer with three toggles.", prNumber: 12, errorLine: null, needsYou: false, refusedLine: null } as never}
        labels={SETTLED_LABELS}
        openLabel={OPEN}
        onOpen={() => {}}
      />,
    );
    const result = screen.getByTestId("coding-agent-activity-result");
    expect(result).toHaveTextContent("Added a settings drawer with three toggles.");
    expect(result).toHaveAttribute("data-tone", "result");
    expect(screen.getByTestId("coding-agent-activity")).toHaveTextContent("2 files");
    expect(screen.getByTestId("coding-agent-activity-pr")).toHaveTextContent("PR #12");
    expect(screen.getByTestId("coding-agent-activity-view")).toHaveTextContent("Open");
    expect(screen.queryByTestId("coding-agent-progressbar")).toBeNull();
    expect(screen.queryByTestId("coding-agent-activity-progress")).toBeNull();
    expect(screen.queryByTestId("coding-agent-activity-subagents")).toBeNull();
    expect(screen.queryByTestId("coding-agent-activity-needs-you")).toBeNull();
  });

  it("failed: the error's first line in the danger tone", () => {
    render(
      <CodingAgentActivityPill
        run={{ ...base, status: "failed", completedAt: NOW + 9_000, summaryLine: null, errorLine: "Build failed: exit 1", prNumber: null, needsYou: false, refusedLine: null } as never}
        labels={SETTLED_LABELS}
        openLabel={OPEN}
      />,
    );
    const result = screen.getByTestId("coding-agent-activity-result");
    expect(result).toHaveTextContent("Build failed: exit 1");
    expect(result).toHaveAttribute("data-tone", "danger");
    expect(screen.queryByTestId("coding-agent-activity-pr")).toBeNull();
  });

  it("paused on a refusal: the Needs you chip and the refused line", () => {
    render(
      <CodingAgentActivityPill
        run={{ ...base, status: "paused", summaryLine: null, errorLine: null, prNumber: null, needsYou: true, refusedLine: "Read: /srv/notes.md" } as never}
        labels={SETTLED_LABELS}
        openLabel={OPEN}
      />,
    );
    expect(screen.getByTestId("coding-agent-activity-needs-you")).toHaveTextContent("Needs you");
    const result = screen.getByTestId("coding-agent-activity-result");
    expect(result).toHaveTextContent("Read: /srv/notes.md");
    expect(result).toHaveAttribute("data-tone", "attention");
  });

  it("Open is a 32-px button and × a 44-px target", () => {
    render(<CodingAgentActivityPill run={{ ...base, teamId: null } as never} labels={SETTLED_LABELS} openLabel={OPEN} onOpen={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId("coding-agent-activity-view").style.minHeight).toBe("32px");
    expect(screen.getByTestId("coding-agent-activity-dismiss").style.width).toBe("44px");
    expect(screen.getByTestId("coding-agent-activity-dismiss").style.height).toBe("44px");
  });
});

describe("the card's Pause and Resume (the owner's ask of 2026-10-30)", () => {
  const base = {
    ...RUNNING, subagentsTotal: 0, subagentsActive: 0, subagentsByType: {}, tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, numTurns: 0,
    progress: [], screenshots: [], todos: [], transcriptPath: null, sessionId: null, directory: null, teamId: null,
    summaryLine: null, errorLine: null, prNumber: null, needsYou: false, refusedLine: null, pauseReason: null,
  };
  const ok = (run: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify({ run }), { status, headers: { "content-type": "application/json" } });
  const refused = (error: string, kind = "owner_only") =>
    new Response(JSON.stringify({ error, kind }), { status: 403, headers: { "content-type": "application/json" } });
  const posted = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as { runId: string }, method: (init as RequestInit).method }));

  it("Pause: posts the run to coding-agent/pause and the card reads paused at once, before the record catches up", async () => {
    const fetchMock = vi.fn(async () => ok({ ...base, status: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<CodingAgentActivityPill run={{ ...base, status: "running" } as never} labels={CONTROL_LABELS} openLabel={OPEN} onOpen={() => {}} canControl onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    const card = screen.getByTestId("coding-agent-activity");
    const pause = screen.getByTestId("coding-agent-activity-pause");
    expect(pause).toHaveAttribute("aria-label", "Pause");
    expect(screen.queryByTestId("coding-agent-activity-resume")).toBeNull();
    fireEvent.click(pause);
    // Disabled while the request is out — a second press costs no second request.
    expect(pause).toBeDisabled();
    expect(pause).toHaveAttribute("aria-label", "Pausing…");
    await waitFor(() => expect(card).toHaveAttribute("data-status", "paused"));
    expect(posted(fetchMock)).toEqual([{ url: "/setup-api/coding-agent/pause", method: "POST", body: { runId: "run-k3x9q2ab" } }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The pause route only ASKS the harness to stop; the optimistic word stands and Resume is now the control.
    expect(screen.getByTestId("coding-agent-activity-resume")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-activity-pause")).toBeNull();
    expect(card).toHaveTextContent(en["codingAgent.chatPaused"]);
    expect(screen.queryByTestId("coding-agent-activity-working")).toBeNull();
    // The press did not collapse the card on the way.
    expect(card).toHaveAttribute("data-expanded", "true");
  });

  it("Resume: posts to coding-agent/resume, flips to running and tells the desktop a run is on its way", async () => {
    const fetchMock = vi.fn(async () => ok({ ...base, status: "running" }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const started = vi.fn();
    const off = onCodingRunStarted(started);
    try {
      render(<CodingAgentActivityPill run={{ ...base, status: "paused", needsYou: true } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl />);
      fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
      const card = screen.getByTestId("coding-agent-activity");
      expect(screen.queryByTestId("coding-agent-activity-pause")).toBeNull();
      const resume = screen.getByTestId("coding-agent-activity-resume");
      expect(resume).toHaveAttribute("aria-label", "Resume");
      fireEvent.click(resume);
      expect(resume).toHaveAttribute("aria-label", "Resuming…");
      await waitFor(() => expect(card).toHaveAttribute("data-status", "running"));
      expect(posted(fetchMock)).toEqual([{ url: "/setup-api/coding-agent/resume", method: "POST", body: { runId: "run-k3x9q2ab" } }]);
      expect(started).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("coding-agent-activity-pause")).toBeInTheDocument();
      expect(screen.getByTestId("coding-agent-activity-working")).toBeInTheDocument();
      // Running, the card no longer wears "Needs you".
      expect(screen.queryByTestId("coding-agent-activity-needs-you")).toBeNull();
    } finally {
      off();
    }
  });

  it("a run that gave up offers Resume too — its session is intact, as in the app", () => {
    render(<CodingAgentActivityPill run={{ ...base, status: "gave_up", completedAt: NOW + 9_000 } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.getByTestId("coding-agent-activity-resume")).toBeInTheDocument();
  });

  it("the record's own status wins once it moves: the optimistic word is dropped, not kept for a later pause", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ ...base, status: "running" }, 202)));
    const { rerender } = render(<CodingAgentActivityPill run={{ ...base, status: "paused" } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    fireEvent.click(screen.getByTestId("coding-agent-activity-resume"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-activity")).toHaveAttribute("data-status", "running"));
    // The poller confirms, then the run pauses again on its own.
    rerender(<CodingAgentActivityPill run={{ ...base, status: "running" } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl />);
    rerender(<CodingAgentActivityPill run={{ ...base, status: "paused" } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl />);
    expect(screen.getByTestId("coding-agent-activity")).toHaveAttribute("data-status", "paused");
    expect(screen.getByTestId("coding-agent-activity-resume")).toBeInTheDocument();
  });

  it("a refusal shows the route's line under the card and leaves the status alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => refused("The owner started this run; only they can pause it.")));
    render(<CodingAgentActivityPill run={{ ...base, status: "running" } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    fireEvent.click(screen.getByTestId("coding-agent-activity-pause"));
    const line = await screen.findByTestId("coding-agent-activity-error");
    expect(line).toHaveTextContent("The owner started this run; only they can pause it.");
    expect(screen.getByTestId("coding-agent-activity")).toHaveAttribute("data-status", "running");
    // The control is back for another try.
    expect(screen.getByTestId("coding-agent-activity-pause")).not.toBeDisabled();
  });

  it("a refusal with no readable body falls back to the catalogue's line", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    render(<CodingAgentActivityPill run={{ ...base, status: "paused" } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    fireEvent.click(screen.getByTestId("coding-agent-activity-resume"));
    expect(await screen.findByTestId("coding-agent-activity-error")).toHaveTextContent(en["codingAgent.resumeFailed"]);
  });

  it("is hidden for a viewer who may not control the run — a non-owner chat — and on a settled card", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<CodingAgentActivityPill run={{ ...base, status: "running" } as never} labels={CONTROL_LABELS} openLabel={OPEN} onOpen={() => {}} onDismiss={() => {}} />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.queryByTestId("coding-agent-activity-pause")).toBeNull();
    expect(screen.queryByTestId("coding-agent-activity-resume")).toBeNull();
    // Open and × stay.
    expect(screen.getByTestId("coding-agent-activity-view")).toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-activity-dismiss")).toBeInTheDocument();
    unmount();
    render(<CodingAgentActivityPill run={{ ...base, status: "paused" } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl={false} />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.queryByTestId("coding-agent-activity-resume")).toBeNull();
    cleanup();
    for (const status of ["completed", "failed", "stopped", "queued", "draft"]) {
      render(<CodingAgentActivityPill run={{ ...base, status, completedAt: NOW + 1_000 } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl />);
      fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
      expect(screen.queryByTestId("coding-agent-activity-pause"), status).toBeNull();
      expect(screen.queryByTestId("coding-agent-activity-resume"), status).toBeNull();
      cleanup();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a paused run says WHY when an allowance ran out, and only then", () => {
    const why = "Paused: the daily image allowance is used up. It resets at 09:00 UTC.";
    const { unmount } = render(<CodingAgentActivityPill run={{ ...base, status: "paused" } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl pausedWhy={why} />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.getByTestId("coding-agent-activity-pause-reason")).toHaveTextContent(why);
    expect(screen.getByTestId("coding-agent-activity-resume")).toBeInTheDocument();
    unmount();
    // An owner's pause has nothing to explain; a running run neither, whatever the host hands over.
    render(<CodingAgentActivityPill run={{ ...base, status: "paused" } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl pausedWhy={null} />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.queryByTestId("coding-agent-activity-pause-reason")).toBeNull();
    cleanup();
    render(<CodingAgentActivityPill run={{ ...base, status: "running" } as never} labels={CONTROL_LABELS} openLabel={OPEN} canControl pausedWhy={why} />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.queryByTestId("coding-agent-activity-pause-reason")).toBeNull();
  });

  it("the control is a 32-px button in Open's tokens, beside Open and ×, on the expanded card only", () => {
    render(<CodingAgentActivityPill run={{ ...base, status: "running" } as never} labels={CONTROL_LABELS} openLabel={OPEN} onOpen={() => {}} onDismiss={() => {}} canControl />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    const pause = screen.getByTestId("coding-agent-activity-pause");
    const view = screen.getByTestId("coding-agent-activity-view");
    expect(pause.style.minHeight).toBe("32px");
    expect(pause.style.minWidth).toBe("32px");
    expect(pause.style.background).toBe(view.style.background);
    expect(pause.style.border).toBe(view.style.border);
    expect(pause.title).toBe("Pause");
    // Header row order: the toggle, Pause, Open, ×.
    const row = pause.parentElement!;
    const ids = Array.from(row.children).map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(["coding-agent-activity-toggle", "coding-agent-activity-pause", "coding-agent-activity-view", "coding-agent-activity-dismiss"]);
  });

  it("the collapsed card shows no Pause: the row keeps Open and × alone until the card is expanded", () => {
    render(<CodingAgentActivityPill run={{ ...base, status: "running" } as never} labels={CONTROL_LABELS} openLabel={OPEN} onOpen={() => {}} onDismiss={() => {}} canControl />);
    expect(screen.queryByTestId("coding-agent-activity-pause")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.getByTestId("coding-agent-activity-pause")).toBeInTheDocument();
  });
});

describe("the model the run runs on (the owner, 2026-11-01)", () => {
  const base = {
    id: "run-model001", projectId: "timer", task: "Build a countdown timer",
    startedAt: NOW - 30_000, completedAt: null as number | null,
    status: "running" as const, source: "agent" as const,
    subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
    tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, numTurns: 0,
    progress: [], screenshots: [], todos: [],
    transcriptPath: null, sessionId: null, directory: null,
  };

  it("names what answered on the card, short, with the full id as its tooltip", () => {
    render(<CodingAgentActivityPill run={{ ...base, model: "gpt-5.6-sol", requestedModel: "gpt-6-astra" }} labels={LABELS} openLabel={OPEN} />);
    const chip = screen.getByTestId("coding-agent-activity-model");
    expect(chip).toHaveTextContent(/^GPT 5\.6 Sol$/);
    expect(chip).toHaveAttribute("title", "gpt-5.6-sol");
  });

  it("falls back to what the run was started with, and draws nothing when nothing is known", () => {
    const { rerender } = render(<CodingAgentActivityPill run={{ ...base, requestedModel: "claude-opus-5-5" }} labels={LABELS} openLabel={OPEN} />);
    expect(screen.getByTestId("coding-agent-activity-model")).toHaveTextContent("Opus 5.5");
    rerender(<CodingAgentActivityPill run={base} labels={LABELS} openLabel={OPEN} />);
    expect(screen.queryByTestId("coding-agent-activity-model")).toBeNull();
  });

  it("carries the model fields from the runs route to the card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => runsResponse([{ ...RUNNING, model: "claude-opus-5-5", modelsUsed: ["claude-opus-5-5", 7], requestedModel: "claude-opus-5-5" }])));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0]).toMatchObject({ model: "claude-opus-5-5", modelsUsed: ["claude-opus-5-5"], requestedModel: "claude-opus-5-5" });
  });
});
