/**
 * The desktop's corner card for long work Settings started
 * (src/components/BackgroundTaskCards.tsx).
 *
 * Pinned: a running task shows its steps, a bar with the percentage and the
 * time left once there is a rate, and its live log behind a disclosure; it
 * cannot be dismissed while it runs; an ended one says how it ended and can be
 * closed; the hook polls the tasks route, draws what is worth drawing, and
 * asks at once when a surface says it started something.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import BackgroundTaskCards, { useBackgroundTasks } from "@/components/BackgroundTaskCards";
import {
  BACKGROUND_TASK_EVENT,
  formatEtaParts,
  notifyBackgroundTaskStarted,
  visibleBackgroundTasks,
  type BackgroundTaskView,
} from "@/lib/background-task-client";

function task(over: Partial<BackgroundTaskView> = {}): BackgroundTaskView {
  return {
    id: "t1", kind: "whisper-engine-install", group: "whisper-engine", title: "Installing speech (Whisper)", meta: null,
    state: "running",
    steps: [
      { id: "install", label: "Build faster-whisper", state: "running", weight: 9 },
      { id: "wire", label: "Switch voice notes to it", state: "pending", weight: 1 },
    ],
    status: "Building CTranslate2 (cmake)", completed: null, total: null,
    startedAt: 1_000, updatedAt: 2_000, stepStartedAt: 1_000, finishedAt: null, error: null, result: null,
    log: ["Installing speech on this box (faster-whisper)…", "Building CTranslate2 (cmake)"], logCount: 2,
    runner: "r", dismissed: false, percent: 42.5, etaSeconds: 300,
    ...over,
  };
}

function renderCards(tasks: BackgroundTaskView[], onDismiss = vi.fn()) {
  render(<I18nProvider><BackgroundTaskCards tasks={tasks} onDismiss={onDismiss} /></I18nProvider>);
  return onDismiss;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("BackgroundTaskCards", () => {
  it("draws a running task: headline, steps, percent, time left, and no close button", () => {
    renderCards([task()]);
    const card = screen.getByTestId("background-task-card");
    expect(card).toHaveAttribute("data-task-state", "running");
    expect(card).toHaveTextContent("Installing speech (Whisper)");
    expect(screen.getByTestId("background-task-headline")).toHaveTextContent("Building CTranslate2 (cmake)");
    expect(screen.getByTestId("background-task-percent")).toHaveTextContent("42%");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42.5");
    expect(screen.getByTestId("background-task-eta")).toBeInTheDocument();
    expect(screen.getByTestId("background-task-steps")).toHaveTextContent("Build faster-whisper");
    expect(screen.queryByTestId("background-task-dismiss")).toBeNull();
  });

  it("opens and closes the live log", () => {
    renderCards([task()]);
    expect(screen.queryByTestId("background-task-log")).toBeNull();
    fireEvent.click(screen.getByTestId("background-task-log-toggle"));
    expect(screen.getByTestId("background-task-log")).toHaveTextContent("Installing speech on this box (faster-whisper)…");
    expect(screen.getByTestId("background-task-log-toggle")).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByTestId("background-task-log-toggle"));
    expect(screen.queryByTestId("background-task-log")).toBeNull();
  });

  it("draws no ETA where the server gave none", () => {
    renderCards([task({ etaSeconds: null, percent: null })]);
    expect(screen.queryByTestId("background-task-eta")).toBeNull();
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("says how a failed task ended and lets it be closed", () => {
    const onDismiss = renderCards([task({ state: "failed", error: "no CUDA toolkit", finishedAt: 5_000 })]);
    expect(screen.getByTestId("background-task-headline")).toHaveTextContent("no CUDA toolkit");
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByTestId("background-task-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("t1");
  });

  it("reads a success's own closing line", () => {
    renderCards([task({ state: "succeeded", finishedAt: 5_000, result: { status: "Speech on this box is installed." } })]);
    expect(screen.getByTestId("background-task-headline")).toHaveTextContent("Speech on this box is installed.");
  });
});

describe("visibleBackgroundTasks / formatEtaParts", () => {
  it("keeps running tasks, unseen failures and fresh successes", () => {
    const now = 100 * 60 * 1000;
    const list = [
      task({ id: "run" }),
      task({ id: "failed", state: "failed", finishedAt: 1 }),
      task({ id: "interrupted", state: "interrupted", finishedAt: 1 }),
      task({ id: "gone", state: "failed", finishedAt: 1, dismissed: true }),
      task({ id: "fresh", state: "succeeded", finishedAt: now - 60_000 }),
      task({ id: "stale", state: "succeeded", finishedAt: now - 60 * 60 * 1000 }),
    ];
    expect(visibleBackgroundTasks(list, now).map((t) => t.id)).toEqual(["run", "failed", "interrupted", "fresh"]);
  });

  it("rounds the time left up to whole minutes", () => {
    expect(formatEtaParts(null)).toBeNull();
    expect(formatEtaParts(30)).toEqual({ hours: 0, minutes: 1 });
    expect(formatEtaParts(61)).toEqual({ hours: 0, minutes: 2 });
    expect(formatEtaParts(3_900)).toEqual({ hours: 1, minutes: 5 });
  });
});

describe("useBackgroundTasks", () => {
  it("asks the tasks route, and again at once when a surface starts a task", async () => {
    const answers = [[] as BackgroundTaskView[], [task()]];
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ tasks: answers.shift() ?? [task()] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBackgroundTasks(true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.tasks).toEqual([]);
    act(() => notifyBackgroundTaskStarted("t1"));
    await waitFor(() => expect(result.current.tasks.map((t) => t.id)).toEqual(["t1"]));
    expect(fetchMock.mock.calls[0][0]).toBe("/setup-api/background-jobs/tasks");
  });

  it("asks nothing while disabled (not the owner's desktop)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBackgroundTasks(false));
    window.dispatchEvent(new CustomEvent(BACKGROUND_TASK_EVENT));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.tasks).toEqual([]);
  });

  it("hides a dismissed card at once and tells the server", async () => {
    const failed = task({ state: "failed", error: "boom", finishedAt: Date.now() });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? new Response("{}") : new Response(JSON.stringify({ tasks: [failed] })));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBackgroundTasks(true));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    act(() => result.current.dismiss("t1"));
    expect(result.current.tasks).toHaveLength(0);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ id: "t1", action: "dismiss" });
  });
});
