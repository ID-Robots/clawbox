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
  resolveVisionModelId: vi.fn(async () => ({ id: "vision-x" })),
}));
vi.mock("@/lib/config-store", () => ({ get: mocks.configGet }));
vi.mock("@/lib/clawbox-ai-vision", () => ({
  clawboxAiProxyUrl: () => "http://proxy.test/v1",
  resolveVisionModelId: mocks.resolveVisionModelId,
}));

import { describeImage } from "@/lib/vision-describe";

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
    expect(await describeNow()).toEqual({ text: "a red square", error: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks once more, never twice more: the second failure is the answer", async () => {
    fetchMock.mockResolvedValueOnce(status(502)).mockResolvedValueOnce(status(502));
    expect(await describeNow()).toEqual({ text: null, error: "the vision model answered 502" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("what is not", () => {
  it("a deterministic refusal — the proxy does not serve the model", async () => {
    fetchMock.mockResolvedValueOnce(status(400, '{"error":"model_not_allowed"}'));
    expect(await describeNow()).toEqual({ text: null, error: "the vision model answered 400" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a timeout — the budget is already spent", async () => {
    fetchMock.mockRejectedValueOnce(timeoutError());
    expect(await describeNow()).toEqual({ text: null, error: "the vision request timed out" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an answer without a description", async () => {
    fetchMock.mockResolvedValueOnce(answer("   "));
    expect(await describeNow()).toEqual({ text: null, error: "the vision model answered without a description" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an unlinked account never reaches the proxy at all", async () => {
    mocks.configGet.mockResolvedValue(undefined);
    expect(await describeNow()).toEqual({ text: null, error: "ClawBox AI is not connected on this device" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
