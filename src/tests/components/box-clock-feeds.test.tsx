import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen, waitFor } from "@/tests/helpers/test-utils";
import MemoryShardApp from "@/components/MemoryShardApp";
import CodingAgentApp from "@/components/CodingAgentApp";
import { I18nProvider } from "@/lib/i18n";
import { useCodingAgentActivity } from "@/lib/use-coding-agent-activity";
import { fetchBackgroundTasks } from "@/lib/background-task-client";
import { _resetBoxClockForTests, boxClockOffsetMs } from "@/lib/box-clock";

/**
 * TASK-2138: a window opened on its own page (/app/<id>) has no desktop
 * notice poll under it, so its own status read is what tells it the box's
 * clock — and its "x ago"s are held to that, not to the browser's.
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const MINUTE = 60_000;
/** The browser is ten minutes ahead of the box. */
const BOX_LEAD_MS = -10 * MINUTE;

function answer(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Service Unavailable",
    headers: new Headers({ date: new Date(Date.now() + BOX_LEAD_MS).toUTCString() }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const MEMORY = {
  available: true,
  provider: "ollama",
  model: "qwen3-embedding:0.6b",
  location: "local",
  health: "healthy",
  semanticAvailable: true,
  indexIdentity: "valid",
  fingerprint: "a1b2c3d4e5f6",
  sourceCount: 2,
  files: 41,
  chunks: 318,
  vectors: 318,
  pendingFiles: 0,
  failedItems: 0,
  dirty: false,
  indexBytes: 4_194_304,
  error: "",
  run: { status: "idle", mode: "", trigger: "", startedAtMs: 0, finishedAtMs: 0, durationMs: 0, error: "" },
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 },
  nextRunAtMs: 0,
  enabled: true,
  setupComplete: true,
};

beforeEach(() => {
  _resetBoxClockForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Memory Shard on its own page", () => {
  it("says a run the box finished three minutes ago finished 3m ago, not 13m", async () => {
    const finishedAtMs = Date.now() + BOX_LEAD_MS - 3 * MINUTE;
    const memory = {
      ...MEMORY,
      run: { ...MEMORY.run, status: "succeeded", startedAtMs: finishedAtMs - 20_000, finishedAtMs, durationMs: 20_000 },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("/setup-api/clawkeep/memory")) return answer(memory);
      if (url.startsWith("/setup-api/preferences")) return answer({ ui_language: "en" });
      return answer({});
    }));
    render(<I18nProvider><MemoryShardApp /></I18nProvider>);
    expect(await screen.findByText(/finished 3m ago/, undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByText(/finished 13m ago/)).toBeNull();
    expect(boxClockOffsetMs()).toBeLessThan(-9 * MINUTE);
  });
});

describe("the Coding Agent on its own page", () => {
  it("learns the box's clock from its status read", async () => {
    // Every read refused: what is learnt comes off the answer itself.
    vi.stubGlobal("fetch", vi.fn(async () => answer({ error: "busy" }, 503)));
    render(<I18nProvider><CodingAgentApp /></I18nProvider>);
    await waitFor(() => expect(boxClockOffsetMs()).toBeLessThan(-9 * MINUTE), { timeout: 10_000 });
    expect(boxClockOffsetMs()).toBeGreaterThan(-11 * MINUTE);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith("/setup-api/coding-agent/status"))).toBe(true);
  });
});

describe("the background tasks list", () => {
  it("learns the box's clock from its answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ tasks: [] })));
    expect(await fetchBackgroundTasks()).toEqual([]);
    expect(boxClockOffsetMs()).toBeLessThan(-9 * MINUTE);
    expect(boxClockOffsetMs()).toBeGreaterThan(-11 * MINUTE);
  });
});

describe("the chat's coding runs poll", () => {
  it("learns the box's clock from the runs answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ runs: [] })));
    renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(boxClockOffsetMs()).toBeLessThan(-9 * MINUTE), { timeout: 10_000 });
    expect(boxClockOffsetMs()).toBeGreaterThan(-11 * MINUTE);
  });

  it("holds the recent-runs window on the box's clock: a run the box finished a minute ago is this chat's", async () => {
    // Nothing has told the page the box's clock before the chat opens: the
    // runs answer itself does. On the browser's clock, ten minutes ahead, the
    // window opened at box + 8 min and the run was dropped as old.
    const boxNow = Date.now() + BOX_LEAD_MS;
    const run = {
      id: "run-k3x9q2ab",
      projectId: "timer",
      task: "Build a countdown timer",
      status: "completed",
      startedAt: boxNow - MINUTE,
      completedAt: boxNow - 30_000,
      source: "agent",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => (
      String(input).includes("/coding-agent/runs") ? answer({ runs: [run] }) : answer({ teams: [] })
    )));
    const { result } = renderHook(() => useCodingAgentActivity(true));
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(["run-k3x9q2ab"]), { timeout: 10_000 });
  });
});
