/**
 * describeImage's one retry (src/lib/vision-describe.ts).
 *
 * The vision proxy's round trip flaps, so a transient failure — a network
 * error, a 5xx, a 429, a known flap body — is asked once more after a short
 * pause, inside the SAME budget. What is pinned just as firmly is what is NOT
 * retried: a timeout (the budget is spent) and every deterministic answer
 * (no token, a 400, an empty description), which a second identical question
 * would only repeat and re-bill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configGet: vi.fn(async (): Promise<unknown> => "tok-1234567890"),
  probe: vi.fn(),
}));
vi.mock("@/lib/config-store", () => ({ get: mocks.configGet }));
vi.mock("@/lib/clawbox-ai-models", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-models")>()),
  clawboxAiProxyUrl: () => "http://proxy.test/v1",
}));
// Which model looks is the vision check's answer (src/lib/clawbox-ai-vision.ts),
// which has its own suite; here it is stated, so the proxy calls counted below
// are the description's alone.
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  probeClawboxAiVision: mocks.probe,
  readClawboxAiVision: vi.fn(async () => null),
}));

// Which engine answers is feature-engine.ts's question, with its own suite;
// here it is stated: ClawBox AI unless a case says the box's own engine.
const feature = vi.hoisted(() => ({ resolveFeatureEngine: vi.fn() }));
vi.mock("@/lib/feature-engine", () => feature);

import {
  DESCRIBE_TIMEOUT_MS,
  EXTERNAL_NO_VISION_ERROR,
  LOCAL_NO_VISION_ERROR,
  LOCKED_NO_ENGINE_ERROR,
  MIN_RETRY_MS,
  NO_VISION_MODEL_ERROR,
  RETRY_DELAY_MS,
  _resetVisionModelCacheForTests,
  describeImage,
} from "@/lib/vision-describe";

const SEES = { verdict: "flash", model: "deepseek-v4-flash", flash: "sees", fallback: null };

const fetchMock = vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>();

const answer = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
const status = (code: number, body = "") => new Response(body, { status: code });
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

/** Run the call while the retry pause is skipped over. */
async function describeNow(): Promise<{ text: string | null; error: string | null }> {
  const pending = describeImage("aGk=");
  await vi.runAllTimersAsync();
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  mocks.configGet.mockResolvedValue("tok-1234567890");
  mocks.probe.mockReset();
  mocks.probe.mockResolvedValue(SEES);
  feature.resolveFeatureEngine.mockReset().mockResolvedValue({ kind: "clawbox-ai" });
  _resetVisionModelCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("what is retried", () => {
  it.each([
    ["a 5xx", () => status(503)],
    ["a 429", () => status(429)],
    ["a network failure", () => { throw new TypeError("fetch failed"); }],
    ["the proxy's known flap body on a 4xx", () => status(401, '{"error":"failed to authenticate"}')],
  ])("asks once more after %s", async (_name, first) => {
    fetchMock.mockImplementationOnce(async () => first()).mockResolvedValueOnce(answer("a red square"));
    expect(await describeNow()).toMatchObject({ text: "a red square", error: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks once more, never twice more: the second failure is the answer", async () => {
    fetchMock.mockResolvedValueOnce(status(502)).mockResolvedValueOnce(status(502));
    expect(await describeNow()).toMatchObject({ text: null, error: "the vision model answered 502" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("the remaining budget", () => {
  /** A first attempt that took `elapsedMs` before answering: the clock moves, then the reply lands. */
  const slowFirst = (elapsedMs: number, reply: () => Response) => async () => {
    vi.setSystemTime(Date.now() + elapsedMs);
    return reply();
  };

  it("does not retry when less than MIN_RETRY_MS would be left after the pause", async () => {
    fetchMock
      .mockImplementationOnce(slowFirst(DESCRIBE_TIMEOUT_MS - RETRY_DELAY_MS - MIN_RETRY_MS + 1, () => status(503)))
      .mockResolvedValueOnce(answer("too late to be asked"));
    expect(await describeNow()).toMatchObject({ text: null, error: "the vision model answered 503" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries while exactly MIN_RETRY_MS would be left", async () => {
    fetchMock
      .mockImplementationOnce(slowFirst(DESCRIBE_TIMEOUT_MS - RETRY_DELAY_MS - MIN_RETRY_MS, () => status(503)))
      .mockResolvedValueOnce(answer("just in time"));
    expect(await describeNow()).toMatchObject({ text: "just in time", error: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("what is not", () => {
  it("a deterministic refusal — the proxy does not serve the model", async () => {
    fetchMock.mockResolvedValueOnce(status(400, '{"error":"model_not_allowed"}'));
    expect(await describeNow()).toMatchObject({ text: null, error: "the vision model answered 400" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a timeout — the budget is already spent", async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());
    expect(await describeNow()).toMatchObject({ text: null, error: "the vision request timed out" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an answer without a description", async () => {
    fetchMock.mockResolvedValueOnce(answer("   "));
    expect(await describeNow()).toMatchObject({ text: null, error: "the vision model answered without a description" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an unlinked account never reaches the proxy at all", async () => {
    mocks.configGet.mockResolvedValue(undefined);
    expect(await describeNow()).toMatchObject({ text: null, error: "ClawBox AI is not connected on this device" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


it("records requested and actual model plus usage separately for every attempt", async () => {
  fetchMock.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(new Response(JSON.stringify({
    model: "deepseek-flash", usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 },
    choices: [{ message: { content: "A dashboard" } }],
  })));
  const pending = describeImage("aGk=");
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.vision?.attempts).toHaveLength(2);
  expect(result.vision?.attempts[0]).toMatchObject({ status: 503, usage: null, responseModel: null });
  // The model the vision check names looks at the picture (TASK-2261).
  expect(result.vision?.attempts[1]).toMatchObject({ requestedModel: "deepseek-v4-flash", responseModel: "deepseek-flash", usage: { total_tokens: 130 } });
  expect(JSON.stringify(result)).not.toContain("tok-1234567890");
});

describe("which model looks", () => {
  it("asks the vision fallback while Flash cannot see", async () => {
    mocks.probe.mockResolvedValue({ verdict: "fallback", model: "gpt-5.6-luna", flash: "blind", fallback: "sees" });
    fetchMock.mockResolvedValueOnce(answer("a dashboard"));
    const result = await describeImage("aGk=");
    expect(result.text).toBe("a dashboard");
    expect(result.vision?.attempts[0].requestedModel).toBe("gpt-5.6-luna");
  });

  it("says plainly that nothing can look, without asking the proxy, when neither can see", async () => {
    mocks.probe.mockResolvedValue({ verdict: "none", model: null, flash: "blind", fallback: "blind" });
    expect(await describeImage("aGk=")).toEqual({ text: null, error: NO_VISION_MODEL_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the check once per ten minutes, not once per picture", async () => {
    fetchMock.mockImplementation(async () => answer("x"));
    await describeImage("aGk=");
    await describeImage("aGk=");
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });
});

describe("on the box's own engine (TASK-2501 PR-C)", () => {
  const EXTERNAL = {
    kind: "clawext",
    model: "qwen2.5-vl-7b",
    modelRef: "clawext/qwen2.5-vl-7b",
    chatUrl: "http://engine.example:8000/v1/chat/completions",
    authorization: "Bearer sk-owner",
    contextTokens: 32768,
    maxOutputTokens: 4096,
    parallel: 1,
    imageInput: true as boolean | null,
  };

  it("asks the engine that can see, with the picture, and never the cloud", async () => {
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "local", engine: EXTERNAL });
    fetchMock.mockResolvedValueOnce(answer("A login form with a blue button."));
    const out = await describeNow();
    expect(out).toMatchObject({ text: "A login form with a blue button.", error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXTERNAL.chatUrl);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-owner");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("qwen2.5-vl-7b");
    expect(body.max_tokens).toBe(2048);
    expect(body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.configGet).not.toHaveBeenCalled();
    expect((out as { vision?: { attempts: Array<{ requestedModel: string }> } }).vision?.attempts[0].requestedModel).toBe("clawext/qwen2.5-vl-7b");
  });

  it("retries a transient failure once there too", async () => {
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "local", engine: EXTERNAL });
    fetchMock.mockResolvedValueOnce(status(502)).mockResolvedValueOnce(answer("A chart."));
    expect(await describeNow()).toMatchObject({ text: "A chart.", error: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("says so in words, asking nothing, when the box's model cannot look at pictures", async () => {
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "local", engine: { ...EXTERNAL, kind: "llamacpp", imageInput: false } });
    expect(await describeNow()).toEqual({ text: null, error: LOCAL_NO_VISION_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a JSON null answer as no description, never a throw", async () => {
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "local", engine: EXTERNAL });
    fetchMock.mockResolvedValueOnce(new Response("null", { status: 200 }));
    expect(await describeNow()).toMatchObject({ text: null, error: "the vision model answered without a description" });
  });

  it("names the External engine's own setting when it was saved without image input", async () => {
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "local", engine: { ...EXTERNAL, imageInput: false } });
    expect(await describeNow()).toEqual({ text: null, error: EXTERNAL_NO_VISION_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never falls back to the cloud under the lock with no model on the box", async () => {
    feature.resolveFeatureEngine.mockResolvedValue({ kind: "none", reason: "cloud_ai_locked" });
    expect(await describeNow()).toEqual({ text: null, error: LOCKED_NO_ENGINE_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.configGet).not.toHaveBeenCalled();
  });
});
