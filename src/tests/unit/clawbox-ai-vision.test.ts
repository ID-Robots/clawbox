import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAWBOX_AI_LEGACY_VISION_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL_ID,
} from "@/lib/clawbox-ai-models";
import { isClawboxAiVisionId, resolveVisionModelId } from "@/lib/clawbox-ai-vision";

// Which vision model may this box name? The DeepSeek id is PREFERRED, but the
// proxy allowlists bare ids and a config naming a refused model turns every
// attached picture into an HTTP 400 — so every writer resolves through this
// probe. These tests pin the three verdicts and the conservative default.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveVisionModelId", () => {
  it("prefers the DeepSeek model when the proxy serves it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { choices: [] }));
    const resolved = await resolveVisionModelId({ token: "claw_t", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(resolved).toEqual({ id: CLAWBOX_AI_VISION_MODEL_ID, verified: true, reason: "proxy-allows" });
    // The probe is the cheapest question the OpenAI surface can be asked.
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe(CLAWBOX_AI_VISION_MODEL_ID);
    expect(body.max_tokens).toBe(1);
  });

  it("falls back to the previous vision model on model_not_allowed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, {
      error: { code: "model_not_allowed", message: `Model not allowed: ${CLAWBOX_AI_VISION_MODEL_ID}`, type: "invalid_request_error" },
    }));
    const resolved = await resolveVisionModelId({ token: "claw_t", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(resolved).toEqual({ id: CLAWBOX_AI_LEGACY_VISION_MODEL_ID, verified: true, reason: "proxy-refuses" });
  });

  it("stays conservative when the question itself fails", async () => {
    // Auth failures, 5xx and dead networks mean the QUESTION failed — the
    // resolver must not flap a working config on a bad moment.
    for (const impl of [
      vi.fn(async () => jsonResponse(503, { error: "down" })),
      vi.fn(async () => { throw new Error("network down"); }),
    ]) {
      const resolved = await resolveVisionModelId({ token: "claw_t", fetchImpl: impl as unknown as typeof fetch });
      expect(resolved.id).toBe(CLAWBOX_AI_LEGACY_VISION_MODEL_ID);
      expect(resolved.verified).toBe(false);
      expect(resolved.reason).toBe("probe-failed");
    }
  });

  it("takes the operator's env override without asking anyone", async () => {
    vi.stubEnv("CLAWBOX_AI_VISION_MODEL_ID", "vision-staging-1");
    const fetchImpl = vi.fn();
    const resolved = await resolveVisionModelId({ token: "claw_t", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolved.reason).toBe("env-override");
    // The id itself is baked into the constant at module load; what this test
    // pins is that an override means NO probe and no legacy fallback.
    expect(resolved.verified).toBe(false);
  });
});

describe("isClawboxAiVisionId", () => {
  it("recognises OUR ids, bare or provider-prefixed, and nothing else", () => {
    expect(isClawboxAiVisionId(CLAWBOX_AI_VISION_MODEL_ID)).toBe(true);
    expect(isClawboxAiVisionId(`deepseek/${CLAWBOX_AI_VISION_MODEL_ID}`)).toBe(true);
    expect(isClawboxAiVisionId(CLAWBOX_AI_LEGACY_VISION_MODEL_ID)).toBe(true);
    expect(isClawboxAiVisionId(`deepseek/${CLAWBOX_AI_LEGACY_VISION_MODEL_ID}`)).toBe(true);
    expect(isClawboxAiVisionId("google/gemini-2.5-flash")).toBe(false);
    expect(isClawboxAiVisionId("")).toBe(false);
  });
});
