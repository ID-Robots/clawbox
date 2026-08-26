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
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { renderHook } from "@testing-library/react";
import { translations } from "@/lib/translations";
import CodingAgentActivityPill from "@/components/CodingAgentActivityPill";
import { isCodingAgentTool, useCodingAgentActivity } from "@/lib/use-coding-agent-activity";

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

const LABELS = {
  running: translations.en["codingAgent.chatWorking"],
  runningOwner: translations.en["codingAgent.chatWorkingOwner"],
  completed: translations.en["codingAgent.chatFinished"],
  failed: translations.en["codingAgent.chatFailed"],
  stopped: translations.en["codingAgent.chatStopped"],
};
const OPEN = translations.en["codingAgent.chatOpenApp"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("which tools mean a run may have started", () => {
  it("recognises the coding-agent family and nothing else", () => {
    for (const name of ["coding_agent_run", "coding_agent_status", "clawbox__coding_agent_run"]) {
      expect(isCodingAgentTool(name), name).toBe(true);
    }
    for (const name of ["bash", "code_project_init", "web_search", "email_send"]) {
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

  it("keeps badges as the conversation continues, and stops polling once nothing runs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => runsResponse([{ ...RUNNING, status: "completed", completedAt: NOW + 9_000 }]));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ open }) => useCodingAgentActivity(open), {
      initialProps: { open: true },
    });
    await act(async () => { await Promise.resolve(); });
    const calls = fetchMock.mock.calls.length;

    // Messages keep arriving and the chat re-renders: the badge stays, and no
    // timer is quietly ticking behind it.
    rerender({ open: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current.runs).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBe(calls);
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

  it("offers a way into the app only when there is somewhere to go", () => {
    const onOpen = vi.fn();
    const run = {
      id: "run-x", projectId: null, task: "x", startedAt: NOW,
      completedAt: null, status: "running" as const, source: "agent" as const,
    };
    const { rerender } = render(
      <CodingAgentActivityPill run={run} labels={LABELS} openLabel={OPEN} onOpen={onOpen} />,
    );
    screen.getByRole("button", { name: OPEN }).click();
    expect(onOpen).toHaveBeenCalledTimes(1);

    rerender(<CodingAgentActivityPill run={run} labels={LABELS} openLabel={OPEN} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
