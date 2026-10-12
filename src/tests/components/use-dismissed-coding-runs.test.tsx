import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@/tests/helpers/test-utils";
import {
  DISMISSED_CODING_RUNS_KEY,
  MAX_DISMISSED_CODING_RUNS,
  mergeDismissedCodingRuns,
  parseDismissedCodingRuns,
  useDismissedCodingRuns,
  withDismissedCodingRun,
} from "@/lib/use-dismissed-coding-runs";

/**
 * The chat's put-away run cards, kept for good in the owner's kv store.
 *
 * client-kv is the page's copy (filled at page load) and is faked with a plain
 * map; `/setup-api/kv?key=…` is the device's copy and is faked in fetch. Plain
 * functions over hoisted state, not vi.fn implementations: this suite runs
 * with `mockReset`, which would empty those before every test.
 */
const kv = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  writes: [] as Array<[string, string]>,
  throwOnGet: false,
}));

vi.mock("@/lib/client-kv", () => ({
  get: (key: string) => {
    if (kv.throwOnGet) throw new Error("cache unreadable");
    return kv.cache.get(key) ?? null;
  },
  set: (key: string, value: string) => {
    kv.cache.set(key, value);
    kv.writes.push([key, value]);
  },
}));

type DeviceAnswer = { kind: "value"; value: string | null } | { kind: "status"; status: number } | { kind: "throw" } | { kind: "body"; body: unknown };
let device: DeviceAnswer = { kind: "value", value: null };
let deviceReads = 0;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (!url.startsWith(`/setup-api/kv?key=${DISMISSED_CODING_RUNS_KEY}`)) throw new Error(`unexpected fetch ${url}`);
      deviceReads += 1;
      if (device.kind === "throw") throw new TypeError("Failed to fetch");
      if (device.kind === "status") return { ok: false, status: device.status, json: async () => ({ error: "owner_only" }) };
      const body = device.kind === "body" ? device.body : { key: DISMISSED_CODING_RUNS_KEY, value: device.value };
      return { ok: true, json: async () => body };
    }),
  );
}

beforeEach(() => {
  kv.cache.clear();
  kv.writes = [];
  kv.throwOnGet = false;
  device = { kind: "value", value: null };
  deviceReads = 0;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stored = () => JSON.parse(kv.cache.get(DISMISSED_CODING_RUNS_KEY) ?? "null");
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `run-${String(from + i).padStart(4, "0")}`);

describe("parseDismissedCodingRuns", () => {
  it("reads the stored JSON array, and the array itself", () => {
    expect(parseDismissedCodingRuns('["run-a","run-b"]')).toEqual(["run-a", "run-b"]);
    expect(parseDismissedCodingRuns(["run-a"])).toEqual(["run-a"]);
  });

  it("reads anything that is not a list of ids as nothing put away — never as everything", () => {
    for (const raw of [null, undefined, "", "not json", "{\"run-a\":true}", '"run-a"', "42", { length: 3 }, 7, true]) {
      expect(parseDismissedCodingRuns(raw)).toEqual([]);
    }
  });

  it("drops what is not an id and keeps each id once", () => {
    const long = "x".repeat(201);
    expect(parseDismissedCodingRuns(JSON.stringify(["run-a", 3, null, "", long, { id: "run-b" }, "run-a", "run-c"]))).toEqual(["run-a", "run-c"]);
  });

  it(`keeps the newest ${MAX_DISMISSED_CODING_RUNS} of an over-long stored list`, () => {
    const all = ids(MAX_DISMISSED_CODING_RUNS + 100);
    const kept = parseDismissedCodingRuns(JSON.stringify(all));
    expect(kept).toHaveLength(MAX_DISMISSED_CODING_RUNS);
    expect(kept[0]).toBe(all[100]);
    expect(kept.at(-1)).toBe(all.at(-1));
  });
});

describe("withDismissedCodingRun and mergeDismissedCodingRuns", () => {
  it("adds an id as the newest, and hands back the same list when it is there already", () => {
    const list = ["run-a"];
    expect(withDismissedCodingRun(list, "run-b")).toEqual(["run-a", "run-b"]);
    expect(withDismissedCodingRun(list, "run-a")).toBe(list);
  });

  it(`never holds more than ${MAX_DISMISSED_CODING_RUNS}: the oldest goes first`, () => {
    let list: readonly string[] = [];
    for (const id of ids(MAX_DISMISSED_CODING_RUNS + 1)) list = withDismissedCodingRun(list, id);
    expect(list).toHaveLength(MAX_DISMISSED_CODING_RUNS);
    expect(list).not.toContain("run-0000");
    expect(list[0]).toBe("run-0001");
    expect(list.at(-1)).toBe(`run-${String(MAX_DISMISSED_CODING_RUNS).padStart(4, "0")}`);
  });

  it("merges two windows' lists as a union, bounded the same way", () => {
    const base = ["run-a", "run-b"];
    expect(mergeDismissedCodingRuns(base, ["run-b"])).toBe(base);
    expect(mergeDismissedCodingRuns(base, ["run-c", "run-a"])).toEqual(["run-a", "run-b", "run-c"]);
    const merged = mergeDismissedCodingRuns(ids(MAX_DISMISSED_CODING_RUNS), ["run-new"]);
    expect(merged).toHaveLength(MAX_DISMISSED_CODING_RUNS);
    expect(merged.at(-1)).toBe("run-new");
    expect(merged).not.toContain("run-0000");
  });
});

describe("useDismissedCodingRuns", () => {
  it("starts from the page's copy of the store, before the device has answered", () => {
    kv.cache.set(DISMISSED_CODING_RUNS_KEY, '["run-a"]');
    const { result } = renderHook(() => useDismissedCodingRuns(false));
    expect([...result.current.dismissed]).toEqual(["run-a"]);
    // Closed: the device is not asked.
    expect(deviceReads).toBe(0);
  });

  it("puts a run away for good: in the set, written to the store, and there on a fresh mount", async () => {
    const first = renderHook(() => useDismissedCodingRuns(true));
    await waitFor(() => expect(deviceReads).toBe(1));
    act(() => first.result.current.dismiss("run-a"));
    expect(first.result.current.dismissed.has("run-a")).toBe(true);
    expect(stored()).toEqual(["run-a"]);
    first.unmount();

    const second = renderHook(() => useDismissedCodingRuns(false));
    expect(second.result.current.dismissed.has("run-a")).toBe(true);
  });

  it("keeps the set across the chat closing and opening again", async () => {
    const { result, rerender } = renderHook(({ open }) => useDismissedCodingRuns(open), { initialProps: { open: true } });
    act(() => result.current.dismiss("run-a"));
    rerender({ open: false });
    expect(result.current.dismissed.has("run-a")).toBe(true);
    rerender({ open: true });
    await waitFor(() => expect(deviceReads).toBeGreaterThanOrEqual(2));
    expect(result.current.dismissed.has("run-a")).toBe(true);
  });

  it("dismissing the same run twice writes once", async () => {
    const { result } = renderHook(() => useDismissedCodingRuns(true));
    await waitFor(() => expect(deviceReads).toBe(1));
    act(() => result.current.dismiss("run-a"));
    const writes = kv.writes.length;
    const before = result.current.dismissed;
    act(() => result.current.dismiss("run-a"));
    expect(result.current.dismissed).toBe(before);
    expect(kv.writes.length).toBe(writes);
  });

  it("folds in what another window put away when the chat opens, and writes back what the device lacked", async () => {
    kv.cache.set(DISMISSED_CODING_RUNS_KEY, '["run-mine"]');
    device = { kind: "value", value: '["run-theirs"]' };
    const { result } = renderHook(() => useDismissedCodingRuns(true));
    await waitFor(() => expect(result.current.dismissed.has("run-theirs")).toBe(true));
    expect(result.current.dismissed.has("run-mine")).toBe(true);
    expect(stored()).toEqual(["run-theirs", "run-mine"]);
  });

  it("does not write when the device already holds the same list", async () => {
    kv.cache.set(DISMISSED_CODING_RUNS_KEY, '["run-a"]');
    device = { kind: "value", value: '["run-a"]' };
    renderHook(() => useDismissedCodingRuns(true));
    await waitFor(() => expect(deviceReads).toBe(1));
    await act(async () => {});
    expect(kv.writes).toEqual([]);
  });

  it("reads the device again when its window comes back to the front while the chat is open", async () => {
    const { result } = renderHook(() => useDismissedCodingRuns(true));
    await waitFor(() => expect(deviceReads).toBe(1));
    device = { kind: "value", value: '["run-elsewhere"]' };
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(result.current.dismissed.has("run-elsewhere")).toBe(true));
  });

  it("does not read the device on focus while the chat is closed", async () => {
    renderHook(() => useDismissedCodingRuns(false));
    act(() => { window.dispatchEvent(new Event("focus")); });
    await act(async () => {});
    expect(deviceReads).toBe(0);
  });

  it("a dismissal reads the device straight after, so one made in another window meanwhile is not overwritten", async () => {
    const { result } = renderHook(() => useDismissedCodingRuns(true));
    await waitFor(() => expect(deviceReads).toBe(1));
    device = { kind: "value", value: '["run-theirs"]' };
    act(() => result.current.dismiss("run-mine"));
    await waitFor(() => expect(stored()).toEqual(["run-theirs", "run-mine"]));
    expect(result.current.dismissed.has("run-theirs")).toBe(true);
  });

  describe("a store that cannot be read hides nothing and throws nothing", () => {
    it("the page's copy throwing", () => {
      kv.throwOnGet = true;
      const { result } = renderHook(() => useDismissedCodingRuns(false));
      expect(result.current.dismissed.size).toBe(0);
    });

    it("the page's copy holding something that is not a list", () => {
      kv.cache.set(DISMISSED_CODING_RUNS_KEY, "{oops");
      const { result } = renderHook(() => useDismissedCodingRuns(false));
      expect(result.current.dismissed.size).toBe(0);
    });

    for (const [name, answer] of [
      ["the device refusing", { kind: "status", status: 500 }],
      ["the device unreachable", { kind: "throw" }],
      ["the device answering something that is not the route's shape", { kind: "body", body: ["run-a"] }],
    ] as Array<[string, DeviceAnswer]>) {
      it(`${name}: keeps this page's list and writes nothing`, async () => {
        kv.cache.set(DISMISSED_CODING_RUNS_KEY, '["run-a"]');
        device = answer;
        const { result } = renderHook(() => useDismissedCodingRuns(true));
        await waitFor(() => expect(deviceReads).toBe(1));
        await act(async () => {});
        expect([...result.current.dismissed]).toEqual(["run-a"]);
        expect(kv.writes).toEqual([]);
      });
    }

    it("the device holding a damaged value: read as nothing, and this page's list written over it", async () => {
      kv.cache.set(DISMISSED_CODING_RUNS_KEY, '["run-a"]');
      device = { kind: "value", value: "[not json" };
      const { result } = renderHook(() => useDismissedCodingRuns(true));
      await waitFor(() => expect(kv.writes.length).toBe(1));
      expect([...result.current.dismissed]).toEqual(["run-a"]);
      expect(stored()).toEqual(["run-a"]);
    });
  });
});
