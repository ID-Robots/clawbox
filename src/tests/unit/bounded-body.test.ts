import { describe, expect, it } from "vitest";
import { boundedBody } from "@/lib/bounded-body";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts);
}

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);

describe("boundedBody", () => {
  it("passes a body under the limit through unchanged and counts it", async () => {
    const bounded = boundedBody(streamOf([bytes(3), bytes(4, 0x62)]), { limit: 100 });
    const out = await drain(bounded.stream);
    expect(Buffer.from(out).toString()).toBe("aaabbbb");
    expect(bounded.overflowed()).toBe(false);
    expect(bounded.bytes()).toBe(7);
  });

  it("accepts a body that is exactly the limit, whole", async () => {
    const bounded = boundedBody(streamOf([bytes(6), bytes(4)]), { limit: 10 });
    const out = await drain(bounded.stream);
    expect(out.byteLength).toBe(10);
    expect(bounded.overflowed()).toBe(false);
  });

  it("errors the stream on the chunk that crosses the limit and flips overflowed()", async () => {
    const bounded = boundedBody(streamOf([bytes(6), bytes(5), bytes(1)]), { limit: 10, message: "too big" });
    await expect(drain(bounded.stream)).rejects.toThrow("too big");
    expect(bounded.overflowed()).toBe(true);
    // The chunk that crossed is not counted: only what went downstream is.
    expect(bounded.bytes()).toBe(6);
  });

  it("cancels the source once it has overflowed, so a caller pushing gigabytes stops being read", async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(bytes(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const bounded = boundedBody(endless, { limit: 4096 });
    await expect(drain(bounded.stream)).rejects.toThrow();
    expect(bounded.overflowed()).toBe(true);
    expect(cancelled).toBe(true);
    // A handful of chunks past the cap, never a runaway read.
    expect(pulls).toBeLessThan(20);
  });

  it("asks a limit function with the bytes already passed, on every chunk", async () => {
    const asked: number[] = [];
    const bounded = boundedBody(streamOf([bytes(2), bytes(3), bytes(4)]), {
      limit: (passed) => {
        asked.push(passed);
        return 100;
      },
    });
    await drain(bounded.stream);
    expect(asked).toEqual([0, 2, 5]);
  });

  it("honours a limit that moves while the body arrives — a disk that filled from elsewhere", async () => {
    let room = 1000;
    const bounded = boundedBody(streamOf([bytes(10), bytes(10), bytes(10)]), {
      limit: (passed) => passed + room,
    });
    const reader = bounded.stream.getReader();
    expect((await reader.read()).value?.byteLength).toBe(10);
    room = 5;
    await expect(reader.read()).rejects.toThrow();
    expect(bounded.overflowed()).toBe(true);
    expect(bounded.bytes()).toBe(10);
  });

  it("never cuts a body whose limit is Infinity — the 'could not measure' policy", async () => {
    const bounded = boundedBody(streamOf([bytes(50_000), bytes(50_000)]), { limit: () => Infinity });
    const out = await drain(bounded.stream);
    expect(out.byteLength).toBe(100_000);
    expect(bounded.overflowed()).toBe(false);
  });
});
