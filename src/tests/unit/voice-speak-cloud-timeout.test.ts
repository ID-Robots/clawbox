import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceConfigView } from "@/lib/voice-output";

/**
 * A cloud voice that does not answer (src/lib/voice-speak.ts, speakInCloud).
 *
 * A speech server that took the connection and sent nothing held the chat's
 * "Speaking the reply…" for a silent minute, then nothing. Pinned here: the
 * headers must come within CLOUD_FIRST_BYTE_TIMEOUT_MS; a request that never
 * answered is asked again exactly ONCE for the whole call, so the retry cannot
 * multiply with the Opus → MP3 fallback; a body that stalls ends at
 * CLOUD_RESPONSE_TIMEOUT_MS and is not asked again; and every one of those
 * ends in the stable `cloud_no_answer` refusal the callers already relay.
 *
 * Fake timers throughout: nothing here waits a real second.
 */

vi.mock("@/lib/tts-compress", () => ({ compressSpeech: vi.fn() }));

import { CLOUD_FIRST_BYTE_TIMEOUT_MS, CLOUD_RESPONSE_TIMEOUT_MS, speakInCloud } from "@/lib/voice-speak";

const MP3 = new Uint8Array(Buffer.concat([Buffer.from("ID3\x04\0"), Buffer.alloc(3000, 2)]));
const OGG = new Uint8Array(Buffer.concat([Buffer.from("OggS\0\x02"), Buffer.alloc(2000, 2)]));

const cloudConfig = {
  tts: { provider: "openai", providers: { openai: { baseUrl: "https://speech.example/v1", model: "gpt-4o-mini-tts", apiKey: "sk-test" } } },
  models: { providers: { openai: { apiKey: "sk-test" } } },
} as unknown as VoiceConfigView;

let fetchMock: ReturnType<typeof vi.fn>;
/** The `response_format` of every speech request, in order. */
const askedFormats = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).response_format);
/** The signal every speech request was given, in order. */
const signals = () => fetchMock.mock.calls.map((c) => (c[1] as RequestInit).signal as AbortSignal);

function answer(bytes: Uint8Array, type: string, status = 200) {
  return new Response(new Uint8Array(bytes), { status, headers: { "Content-Type": type } });
}

/** A server that took the connection and says nothing — until the request is called off. */
function hangs(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}

/** Worse: a request that does not even hear it is called off. */
function hangsDeaf(): Promise<Response> {
  return new Promise(() => {});
}

/** Headers at once, then a body that never ends. */
function stallsMidway(): Promise<Response> {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(MP3.slice(0, 100)); } });
  return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "audio/mpeg" } }));
}

/** Settles `promise` as the fake clock moves, and says when it did. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; at: number | null; value: T | null } = { done: false, at: null, value: null };
  const started = Date.now();
  void promise.then((value) => { state.done = true; state.at = Date.now() - started; state.value = value; });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("speakInCloud when the cloud does not answer", () => {
  it("keeps its budgets short: a first byte in seconds, the whole answer well inside the old minute", () => {
    expect(CLOUD_FIRST_BYTE_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
    expect(CLOUD_FIRST_BYTE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(CLOUD_RESPONSE_TIMEOUT_MS).toBeGreaterThan(CLOUD_FIRST_BYTE_TIMEOUT_MS);
    // The documented worst case — two requests that end at their headers, one
    // that runs to the end — is far under the 2 × 60 s it could be before.
    expect(2 * CLOUD_FIRST_BYTE_TIMEOUT_MS + CLOUD_RESPONSE_TIMEOUT_MS).toBeLessThanOrEqual(70_000);
  });

  it("gives up on a server that never answers after the first-byte budget × 2, asking exactly once more", async () => {
    fetchMock.mockImplementation(hangs);
    const call = track(speakInCloud(cloudConfig, null, "hi", "mp3"));

    await vi.advanceTimersByTimeAsync(CLOUD_FIRST_BYTE_TIMEOUT_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call.done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    // The first request is called off, not left open, and the one retry goes.
    expect(signals()[0].aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call.done).toBe(false);

    await vi.advanceTimersByTimeAsync(CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect(call.done).toBe(true);
    expect(call.at).toBe(2 * CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals()[1].aborted).toBe(true);
    const res = call.value as Response;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "The cloud voice did not answer.", code: "cloud_no_answer" });

    // And nothing is left ticking that could ask a third time.
    await vi.advanceTimersByTimeAsync(5 * CLOUD_RESPONSE_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up just the same on a request that does not listen to being called off", async () => {
    fetchMock.mockImplementation(hangsDeaf);
    const call = track(speakInCloud(cloudConfig, null, "hi", "mp3"));
    await vi.advanceTimersByTimeAsync(2 * CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect(call.done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(((await (call.value as Response).json()) as { code: string }).code).toBe("cloud_no_answer");
  });

  it("speaks on the retry when the server hangs once and then answers", async () => {
    fetchMock.mockImplementationOnce(hangs).mockResolvedValueOnce(answer(MP3, "audio/mpeg"));
    const call = track(speakInCloud(cloudConfig, null, "hi", "mp3"));
    await vi.advanceTimersByTimeAsync(CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect(call.done).toBe(true);
    const res = call.value as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
    // The same ask, twice: the retry is not a different request.
    expect(askedFormats()).toEqual(["mp3", "mp3"]);
  });

  it("retries a connection that failed outright, at once", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(answer(MP3, "audio/mpeg"));
    const res = await speakInCloud(cloudConfig, null, "hi", "mp3");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers the moment the cloud does — the first-byte budget is a ceiling, not a wait", async () => {
    fetchMock.mockResolvedValueOnce(answer(MP3, "audio/mpeg"));
    const res = await speakInCloud(cloudConfig, null, "hi", "mp3");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No timer outlives the request.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not ask again after a body that started and stalled, and gives up on it at the response budget", async () => {
    fetchMock.mockImplementation(stallsMidway);
    const call = track(speakInCloud(cloudConfig, null, "hi", "mp3"));
    await vi.advanceTimersByTimeAsync(CLOUD_RESPONSE_TIMEOUT_MS - 1);
    expect(call.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals()[0].aborted).toBe(true);
    expect(((await (call.value as Response).json()) as { code: string }).code).toBe("cloud_no_answer");
  });

  it("does not retry a refusal that is about the credential or the rate", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));
    const res = await speakInCloud(cloudConfig, null, "hi", "mp3");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "The cloud voice refused (HTTP 429).", code: "cloud_refused", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("speakInCloud's one retry beside the Opus → MP3 fallback", () => {
  it("still asks once more for MP3 when the proxy will not do Opus", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unsupported response_format" }), { status: 400 }))
      .mockResolvedValueOnce(answer(MP3, "audio/mpeg"));
    const res = await speakInCloud(cloudConfig, null, "hi", "opus");
    expect(res.status).toBe(200);
    expect(askedFormats()).toEqual(["opus", "mp3"]);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("speaks Opus on the retry of a hung Opus request, without falling back", async () => {
    fetchMock.mockImplementationOnce(hangs).mockResolvedValueOnce(answer(OGG, "audio/ogg"));
    const call = track(speakInCloud(cloudConfig, null, "hi", "opus"));
    await vi.advanceTimersByTimeAsync(CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect((call.value as Response).status).toBe(200);
    expect(askedFormats()).toEqual(["opus", "opus"]);
  });

  it("falls back to MP3 after a retried Opus is refused, and retries the MP3 no more: three requests at most", async () => {
    // Hung Opus → its retry refuses the format → the MP3 ask hangs. The retry
    // is spent, so that is the end: 3 requests, 3 × the first-byte budget.
    fetchMock
      .mockImplementationOnce(hangs)
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockImplementation(hangs);
    const call = track(speakInCloud(cloudConfig, null, "hi", "opus"));
    await vi.advanceTimersByTimeAsync(2 * CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect(call.done).toBe(true);
    expect(call.at).toBe(2 * CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect(askedFormats()).toEqual(["opus", "opus", "mp3"]);
    expect(((await (call.value as Response).json()) as { code: string }).code).toBe("cloud_no_answer");
    await vi.advanceTimersByTimeAsync(5 * CLOUD_RESPONSE_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("spends the one retry on the MP3 ask when it was the MP3 ask that hung", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 415 }))
      .mockImplementationOnce(hangs)
      .mockResolvedValueOnce(answer(MP3, "audio/mpeg"));
    const call = track(speakInCloud(cloudConfig, null, "hi", "opus"));
    await vi.advanceTimersByTimeAsync(CLOUD_FIRST_BYTE_TIMEOUT_MS);
    expect((call.value as Response).status).toBe(200);
    expect(askedFormats()).toEqual(["opus", "mp3", "mp3"]);
  });

  it("never runs past the documented worst case, whatever the server does", async () => {
    // The slowest possible path: a hang, a refusal that arrives just inside
    // the first-byte budget, and an MP3 answer whose body never finishes.
    fetchMock
      .mockImplementationOnce(hangs)
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response("{}", { status: 400 })), CLOUD_FIRST_BYTE_TIMEOUT_MS - 1);
      }))
      .mockImplementation(stallsMidway);
    const call = track(speakInCloud(cloudConfig, null, "hi", "opus"));
    await vi.advanceTimersByTimeAsync(2 * CLOUD_FIRST_BYTE_TIMEOUT_MS + CLOUD_RESPONSE_TIMEOUT_MS);
    expect(call.done).toBe(true);
    expect(call.at).toBeLessThanOrEqual(2 * CLOUD_FIRST_BYTE_TIMEOUT_MS + CLOUD_RESPONSE_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(((await (call.value as Response).json()) as { code: string }).code).toBe("cloud_no_answer");
  });
});
