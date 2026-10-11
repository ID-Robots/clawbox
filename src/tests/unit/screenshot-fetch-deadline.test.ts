/**
 * The capture's fetches (TASK-1475): the time limit has to cover the BODY. A
 * server that sends its headers and then stalls must not leave a capture —
 * and every capture queued behind it — waiting for ever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchLike, fetchWithin, withDeadline } from "@/lib/screenshot/fetch-deadline";

/** A fetch that answers at once with headers, then never sends the rest of the body. */
function stallingFetch(onAbort: () => void = () => {}): FetchLike {
  return async (_url: string, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        init?.signal?.addEventListener("abort", () => {
          onAbort();
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });
      },
    });
    return new Response(body, { status: 200 });
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchWithin", () => {
  it("returns what was read from a response that arrives whole", async () => {
    const fetchImpl: FetchLike = async () => new Response("hello", { status: 200 });
    await expect(fetchWithin("/x", 1000, (r) => r.text(), {}, fetchImpl)).resolves.toBe("hello");
  });

  it("passes the request options through, with its own abort signal", async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      calls.push(init);
      return new Response("ok");
    };
    await fetchWithin("/x", 1000, (r) => r.text(), { cache: "force-cache" }, fetchImpl);
    const init = calls[0] as RequestInit;
    expect(init.cache).toBe("force-cache");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up on a body that stalls after the headers, and aborts the request", async () => {
    const aborted = vi.fn();
    const result = fetchWithin("/slow", 8000, (r) => r.blob(), {}, stallingFetch(aborted));
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    expect(aborted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await expect(result).resolves.toBeNull();
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it("gives up even on a body reader that ignores the abort", async () => {
    const fetchImpl: FetchLike = async () => new Response("x");
    const never = () => new Promise<string>(() => {});
    const result = fetchWithin("/deaf", 500, never, {}, fetchImpl);
    await vi.advanceTimersByTimeAsync(501);
    await expect(result).resolves.toBeNull();
  });

  it("gives up on a request whose headers never come", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const result = fetchWithin("/hung", 300, (r) => r.text(), {}, fetchImpl);
    await vi.advanceTimersByTimeAsync(301);
    await expect(result).resolves.toBeNull();
  });

  it("answers null for a response that is not ok, a network error, or a read that throws", async () => {
    const notFound: FetchLike = async () => new Response("no", { status: 404 });
    await expect(fetchWithin("/x", 1000, (r) => r.text(), {}, notFound)).resolves.toBeNull();
    const down: FetchLike = async () => {
      throw new TypeError("network");
    };
    await expect(fetchWithin("/x", 1000, (r) => r.text(), {}, down)).resolves.toBeNull();
    const ok: FetchLike = async () => new Response("x");
    const broken = async () => {
      throw new Error("bad body");
    };
    await expect(fetchWithin("/x", 1000, broken, {}, ok)).resolves.toBeNull();
  });

  it("leaves no timer behind once it has answered", async () => {
    const fetchImpl: FetchLike = async () => new Response("hello");
    await fetchWithin("/x", 60_000, (r) => r.text(), {}, fetchImpl);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withDeadline", () => {
  it("passes a result or a failure through when the work finishes in time", async () => {
    await expect(withDeadline(Promise.resolve(7), 1000, () => new Error("late"))).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error("boom")), 1000, () => new Error("late"))).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the caller's error when the work never finishes", async () => {
    const result = withDeadline(new Promise<number>(() => {}), 30_000, () => new Error("The capture took too long to draw."));
    const caught = result.catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(caught).resolves.toBe("The capture took too long to draw.");
  });
});
