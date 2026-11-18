import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import ClusterPanel, { useClusterAvailable } from "@/components/ClusterPanel";
import type { ClusterSnapshot, SparkCard, SparkFigures } from "@/lib/cluster-shared";

/**
 * Settings → System → Cluster (TASK-2670): the owner's cluster page. The route's
 * answer is scripted; what is asserted is what a person reads.
 */

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "en",
    localeResolved: true,
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

const GIB = 1024 ** 3;

function figures(over: Partial<SparkFigures> = {}): SparkFigures {
  return {
    cpuPercent: 23,
    memory: { usedBytes: 96 * GIB, totalBytes: 120 * GIB, percent: 80 },
    unifiedMemory: true,
    gpu: { utilPercent: 0, memoryUsedBytes: null, memoryTotalBytes: null },
    temperatureC: 52.3,
    disk: { usedBytes: 300 * GIB, totalBytes: 900 * GIB, percent: 33 },
    uptimeSeconds: 1000,
    ...over,
  };
}

function spark(id: string, hostname: string, over: Partial<SparkCard> = {}): SparkCard {
  return { id, local: id === "local", online: true, hostname, checkedAt: 0, figures: figures(), ...over };
}

function snapshot(over: Partial<ClusterSnapshot> = {}): ClusterSnapshot {
  return {
    enabled: true,
    generatedAt: Date.UTC(2026, 10, 18, 12, 0, 0),
    sparks: [
      spark("local", "spark-a"),
      spark("peer-1", "spark-b"),
      spark("peer-2", "spark-c"),
      spark("peer-3", "spark-d"),
    ],
    engine: {
      configured: true,
      model: "deepseek-test",
      gate: { online: true, latencyMs: 12 },
      metrics: { available: true, active: 3, queued: 2, tokensPerSecond: 24.56 },
    },
    ...over,
  };
}

let answer: unknown;
let status = 200;
let fetchMock: ReturnType<typeof vi.fn>;

function serve() {
  fetchMock = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { ok: status >= 200 && status < 300, status, json: async () => answer };
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  answer = snapshot();
  status = 200;
  serve();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ClusterPanel: the Spark cards", () => {
  it("draws one card per Spark with its hostname, status and every figure", async () => {
    render(<ClusterPanel />);
    const cards = await screen.findAllByTestId(/^cluster-spark-(local|peer-\d)$/);
    expect(cards).toHaveLength(4);
    const a = screen.getByTestId("cluster-spark-local");
    expect(within(a).getByRole("heading", { name: "spark-a" })).toBeTruthy();
    expect(screen.getByTestId("cluster-spark-local-local").textContent).toBe("This Spark");
    expect(screen.queryByTestId("cluster-spark-peer-1-local")).toBeNull();
    expect(screen.getByTestId("cluster-spark-local-status").textContent).toBe("Online");
    expect(within(a).getByTestId("cluster-spark-local-cpu").textContent).toContain("23%");
    expect(within(a).getByTestId("cluster-spark-local-memory").textContent).toContain("96.0 GB / 120 GB");
    expect(within(a).getByTestId("cluster-spark-local-gpu").textContent).toContain("0%");
    expect(within(a).getByTestId("cluster-spark-local-temperature").textContent).toContain("52.3 °C");
    expect(within(a).getByTestId("cluster-spark-local-disk").textContent).toContain("300 GB / 900 GB");
  });

  it("labels a GB10's memory as unified, and draws no GPU memory row of its own", async () => {
    render(<ClusterPanel />);
    const memory = await screen.findByTestId("cluster-spark-local-memory");
    expect(memory.textContent).toContain("Memory (unified)");
    expect(memory.getAttribute("title")).toMatch(/share this Spark's memory/);
    expect(screen.queryByTestId("cluster-spark-local-gpu-memory")).toBeNull();
  });

  it("draws a discrete GPU's own memory as its own row, and plain 'Memory'", async () => {
    answer = snapshot({
      sparks: [
        spark("local", "spark-a", {
          figures: figures({
            unifiedMemory: false,
            gpu: { utilPercent: 40, memoryUsedBytes: 8 * GIB, memoryTotalBytes: 24 * GIB },
          }),
        }),
      ],
    });
    render(<ClusterPanel />);
    expect((await screen.findByTestId("cluster-spark-local-memory")).textContent).toContain("Memory");
    expect(screen.getByTestId("cluster-spark-local-memory").textContent).not.toContain("unified");
    expect(screen.getByTestId("cluster-spark-local-gpu-memory").textContent).toContain("8.0 GB / 24.0 GB");
  });

  it("says n/a, never 0, for a figure that could not be read", async () => {
    answer = snapshot({
      sparks: [
        spark("local", "spark-a", {
          figures: figures({
            cpuPercent: null,
            memory: null,
            gpu: { utilPercent: null, memoryUsedBytes: null, memoryTotalBytes: null },
            temperatureC: null,
            disk: null,
          }),
        }),
      ],
    });
    render(<ClusterPanel />);
    for (const part of ["cpu", "memory", "gpu", "temperature", "disk"]) {
      const row = await screen.findByTestId(`cluster-spark-local-${part}`);
      expect(row.textContent, part).toContain("n/a");
      expect(row.textContent, part).not.toMatch(/\b0\s*(%|GB|°C)/);
      expect(within(row).getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    }
  });

  it("shows no warning while every Spark answers", async () => {
    render(<ClusterPanel />);
    await screen.findByTestId("cluster-sparks");
    expect(screen.queryByTestId("cluster-unreachable-banner")).toBeNull();
  });
});

describe("ClusterPanel: a Spark is unreachable", () => {
  const down = (id: string, hostname: string, failure: SparkCard["failure"]): SparkCard => ({
    id,
    local: false,
    online: false,
    hostname,
    failure,
    checkedAt: 0,
  });

  it("raises a clear warning banner naming it, and says why on its card instead of drawing figures", async () => {
    answer = snapshot({
      sparks: [spark("local", "spark-a"), spark("peer-1", "spark-b"), down("peer-2", "spark-c", "unreachable"), spark("peer-3", "spark-d")],
    });
    render(<ClusterPanel />);
    const banner = await screen.findByTestId("cluster-unreachable-banner");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(within(banner).getByTestId("cluster-unreachable-text").textContent).toBe("1 Spark is unreachable: spark-c. Its figures are not shown.");

    const card = screen.getByTestId("cluster-spark-peer-2");
    expect(within(card).getByTestId("cluster-spark-peer-2-status").textContent).toBe("Offline");
    expect(within(card).getByTestId("cluster-spark-peer-2-status").getAttribute("data-online")).toBe("false");
    expect(within(card).getByTestId("cluster-spark-peer-2-failure").textContent).toBe("Cannot be reached on the cluster network.");
    expect(within(card).queryByTestId("cluster-spark-peer-2-cpu")).toBeNull();
    // The others are unaffected.
    expect(screen.getByTestId("cluster-spark-peer-1-cpu")).toBeTruthy();
  });

  it("names every Spark that is down, in the plural", async () => {
    answer = snapshot({
      sparks: [spark("local", "spark-a"), down("peer-1", "spark-b", "timeout"), down("peer-2", "spark-c", "auth"), down("peer-3", "spark-d", "host_key")],
    });
    render(<ClusterPanel />);
    const banner = await screen.findByTestId("cluster-unreachable-banner");
    expect(within(banner).getByTestId("cluster-unreachable-text").textContent).toBe("3 Sparks are unreachable: spark-b, spark-c, spark-d. Their figures are not shown.");
    expect(screen.getByTestId("cluster-spark-peer-1-failure").textContent).toBe("Did not answer in time.");
    expect(screen.getByTestId("cluster-spark-peer-2-failure").textContent).toBe("Refused this box's SSH key.");
    expect(screen.getByTestId("cluster-spark-peer-3-failure").textContent).toBe("Its SSH host key is not trusted by this box.");
  });

  it("gives a Spark that answered unreadably its own wording", async () => {
    answer = snapshot({ sparks: [spark("local", "spark-a"), down("peer-1", "spark-b", "failed")] });
    render(<ClusterPanel />);
    expect((await screen.findByTestId("cluster-spark-peer-1-failure")).textContent).toBe("Answered, but its figures could not be read.");
  });
});

describe("ClusterPanel: the engine", () => {
  it("shows the gate, the model and the engine's load and speed", async () => {
    render(<ClusterPanel />);
    const engine = await screen.findByTestId("cluster-engine");
    expect(within(engine).getByTestId("cluster-engine-gate").textContent).toBe("Online");
    expect(within(engine).getByTestId("cluster-engine-model").textContent).toContain("deepseek-test");
    expect(within(engine).getByTestId("cluster-engine-active").textContent).toContain("3");
    expect(within(engine).getByTestId("cluster-engine-queued").textContent).toContain("2");
    expect(within(engine).getByTestId("cluster-engine-tokens").textContent).toContain("24.6 tok/s");
    expect(within(engine).queryByTestId("cluster-engine-no-metrics")).toBeNull();
  });

  it("shows n/a cleanly, and says why, for an engine with no metrics", async () => {
    answer = snapshot({
      engine: {
        configured: true,
        gate: { online: true },
        metrics: { available: false, active: null, queued: null, tokensPerSecond: null },
      },
    });
    render(<ClusterPanel />);
    const engine = await screen.findByTestId("cluster-engine");
    expect(within(engine).getByTestId("cluster-engine-active").textContent).toContain("n/a");
    expect(within(engine).getByTestId("cluster-engine-queued").textContent).toContain("n/a");
    expect(within(engine).getByTestId("cluster-engine-tokens").textContent).toContain("n/a");
    expect(within(engine).getByTestId("cluster-engine-no-metrics")).toBeTruthy();
  });

  it("shows a first-read speed as n/a while the counts are real", async () => {
    answer = snapshot({
      engine: { configured: true, gate: { online: true }, metrics: { available: true, active: 0, queued: 0, tokensPerSecond: null } },
    });
    render(<ClusterPanel />);
    const engine = await screen.findByTestId("cluster-engine");
    // A real zero is a zero; a missing figure is n/a.
    expect(within(engine).getByTestId("cluster-engine-active").textContent).toContain("0");
    expect(within(engine).getByTestId("cluster-engine-tokens").textContent).toContain("n/a");
  });

  it("marks the gate offline with the reason", async () => {
    answer = snapshot({
      engine: {
        configured: true,
        gate: { online: false, reason: "unreachable" },
        metrics: { available: false, active: null, queued: null, tokensPerSecond: null },
      },
    });
    render(<ClusterPanel />);
    const gate = await screen.findByTestId("cluster-engine-gate");
    expect(gate.textContent).toBe("Offline");
    expect(gate.getAttribute("data-online")).toBe("false");
    expect(screen.getByTestId("cluster-engine-reason").textContent).toBe("The gate did not answer.");
    expect(screen.queryByTestId("cluster-engine-no-metrics")).toBeNull();
  });

  it("explains a gate it would not contact because it is not on the local network", async () => {
    answer = snapshot({
      engine: {
        configured: true,
        gate: { online: false, reason: "not_lan" },
        metrics: { available: false, active: null, queued: null, tokensPerSecond: null },
      },
    });
    render(<ClusterPanel />);
    expect((await screen.findByTestId("cluster-engine-reason")).textContent).toMatch(/outside the local network/);
  });

  it("says where to set one up when there is no engine", async () => {
    answer = snapshot({ engine: { configured: false } });
    render(<ClusterPanel />);
    expect((await screen.findByTestId("cluster-engine-none")).textContent).toMatch(/No AI engine is set up/);
    expect(screen.queryByTestId("cluster-engine-active")).toBeNull();
  });
});

describe("ClusterPanel: reading the route", () => {
  it("asks the cluster route, without a cache", async () => {
    render(<ClusterPanel />);
    await screen.findByTestId("cluster-sparks");
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/cluster", expect.objectContaining({ cache: "no-store" }));
  });

  it("shows a spinner first, and an alert when the page cannot be read", async () => {
    answer = new TypeError("network down");
    render(<ClusterPanel />);
    expect(await screen.findByTestId("cluster-load-failed")).toBeTruthy();
    expect(screen.queryByTestId("cluster-loading")).toBeNull();
    expect(screen.queryByTestId("cluster-sparks")).toBeNull();
  });

  it("keeps the last cards on screen, under an alert, when a later read fails — and recovers by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ClusterPanel />);
    await screen.findByTestId("cluster-sparks");

    answer = new TypeError("network down");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(screen.getByTestId("cluster-load-failed")).toBeTruthy();
    expect(screen.getByTestId("cluster-sparks")).toBeTruthy();

    answer = snapshot();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await waitFor(() => expect(screen.queryByTestId("cluster-load-failed")).toBeNull());
  });

  it("polls every five seconds, one read at a time, and stops when it is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = render(<ClusterPanel />);
    await screen.findByTestId("cluster-sparks");
    const first = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(fetchMock.mock.calls.length).toBe(first + 1);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchMock.mock.calls.length).toBe(first + 1);
  });

  it("gives up on a read that never settles, so the polling does not stop for good", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        // The first request hangs until it is aborted.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => snapshot() });
    }));
    render(<ClusterPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    // The hung read was abandoned (an alert), and the next poll got through.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await screen.findByTestId("cluster-sparks");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("draws nothing if the box says it has no cluster after all", async () => {
    answer = { enabled: false };
    const { container } = render(<ClusterPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("draws nothing but the alert for a refusal (a user who is not the owner)", async () => {
    status = 403;
    answer = { error: "Only the box owner can do this.", code: "owner_only" };
    render(<ClusterPanel />);
    expect(await screen.findByTestId("cluster-load-failed")).toBeTruthy();
    expect(screen.queryByTestId("cluster-sparks")).toBeNull();
  });
});

describe("useClusterAvailable", () => {
  it("asks nothing until it is told it may", async () => {
    const { result } = renderHook(() => useClusterAvailable(false));
    expect(result.current).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the availability question — and only that — once, and is true when the box has a cluster", async () => {
    answer = { enabled: true };
    const { result, rerender } = renderHook(({ on }) => useClusterAvailable(on), { initialProps: { on: true } });
    await waitFor(() => expect(result.current).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/cluster?availability=1", expect.objectContaining({ cache: "no-store" }));
    rerender({ on: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is false for a box with no cluster, a refusal, a failure and nonsense", async () => {
    for (const [stat, body] of [[200, { enabled: false }], [403, { code: "owner_only" }], [500, {}], [200, { enabled: "yes" }], [200, null]] as const) {
      status = stat;
      answer = body;
      serve();
      const { result, unmount } = renderHook(() => useClusterAvailable(true));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10));
      expect(result.current, `${stat} ${JSON.stringify(body)}`).toBe(false);
      unmount();
    }
    answer = new TypeError("down");
    serve();
    const { result } = renderHook(() => useClusterAvailable(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(false);
  });

  it("keeps what it knew when a later request merely fails — a hiccup does not take the tab from the owner", async () => {
    answer = { enabled: true };
    const { result, rerender } = renderHook(({ on }) => useClusterAvailable(on), { initialProps: { on: true } });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ on: false });
    answer = new TypeError("down");
    serve();
    rerender({ on: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(true);
    // A 500 is no answer either; a 403 is one.
    status = 500;
    answer = {};
    serve();
    rerender({ on: false });
    rerender({ on: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBe(true);
    status = 403;
    answer = { code: "owner_only" };
    serve();
    rerender({ on: false });
    rerender({ on: true });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("goes back to false when it is switched off", async () => {
    answer = { enabled: true };
    const { result, rerender } = renderHook(({ on }) => useClusterAvailable(on), { initialProps: { on: true } });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ on: false });
    expect(result.current).toBe(false);
  });
});
