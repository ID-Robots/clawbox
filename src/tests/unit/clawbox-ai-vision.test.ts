import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The vision check (TASK-2261): ClawBox AI's model is SHOWN a picture before
 * anything declares it can see, and the fallback is asked when it cannot.
 */

const store = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store.values[key]),
  set: vi.fn(async (key: string, value: unknown) => { store.values[key] = value; }),
}));

import {
  CLAWBOX_AI_VISION_PROBE_URL_KEY,
  CLAWBOX_AI_VISION_STORE_KEY,
  clawboxAiVisionModelFor,
  isClawboxAiVisionSlotOurs,
  probeClawboxAiVision,
  readClawboxAiVision,
  recordClawboxAiVision,
  type ClawboxAiVisionProbe,
} from "@/lib/clawbox-ai-vision";
import { CLAWBOX_AI_FLASH_MODEL_ID, CLAWBOX_AI_VISION_FALLBACK_MODEL_ID } from "@/lib/clawbox-ai-models";
import { RETIRED_CLAWBOX_AI_VISION_MODEL_IDS } from "@/lib/clawbox-ai-retired-models";

const FLASH = CLAWBOX_AI_FLASH_MODEL_ID;
const FALLBACK = CLAWBOX_AI_VISION_FALLBACK_MODEL_ID;

type Reply = string | number | "throw" | "";

/** A proxy that answers each model as told: text, a status, a network error, or an empty answer. */
function proxy(replies: Record<string, Reply | Reply[]>) {
  const seen: { url: string; model: string; image: boolean }[] = [];
  const counters: Record<string, number> = {};
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({
      url: String(input),
      model: body.model,
      image: body.messages[0].content.some((part: { type: string }) => part.type === "image_url"),
    });
    const list = replies[body.model];
    const index = counters[body.model] = (counters[body.model] ?? -1) + 1;
    const reply = Array.isArray(list) ? list[Math.min(index, list.length - 1)] : list;
    if (reply === "throw" || reply === undefined) throw new TypeError("fetch failed");
    if (typeof reply === "number") return new Response("{}", { status: reply });
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

beforeEach(() => {
  store.values = {};
});

describe("probeClawboxAiVision", () => {
  it("shows Flash a picture, and stops there when Flash names its colour", async () => {
    const { fetchImpl, seen } = proxy({ [FLASH]: "Red." });
    expect(await probeClawboxAiVision({ token: "claw_t", baseUrl: "https://proxy.test/api/ai/", fetchImpl }))
      .toEqual({ verdict: "flash", model: FLASH, flash: "sees", fallback: null });
    expect(seen).toEqual([{ url: "https://proxy.test/api/ai/chat/completions", model: FLASH, image: true }]);
  });

  it("asks the fallback when the proxy refuses Flash a picture", async () => {
    const { fetchImpl } = proxy({ [FLASH]: 400, [FALLBACK]: "red" });
    expect(await probeClawboxAiVision({ token: "t", fetchImpl }))
      .toEqual({ verdict: "fallback", model: FALLBACK, flash: "blind", fallback: "sees" });
  });

  it("counts an answer that never saw the picture as blind", async () => {
    const { fetchImpl } = proxy({ [FLASH]: "I can't see images.", [FALLBACK]: 422 });
    expect((await probeClawboxAiVision({ token: "t", fetchImpl })).verdict).toBe("none");
  });

  it("asks once more past an EMPTY answer, which is a spent budget, not blindness", async () => {
    const { fetchImpl, seen } = proxy({ [FLASH]: ["", "Red"] });
    expect((await probeClawboxAiVision({ token: "t", fetchImpl })).verdict).toBe("flash");
    expect(seen).toHaveLength(2);
  });

  it("does not move pictures off a Flash it could not ask, even when the fallback answers", async () => {
    const { fetchImpl, seen } = proxy({ [FLASH]: 503, [FALLBACK]: "red" });
    expect((await probeClawboxAiVision({ token: "t", fetchImpl })).verdict).toBe("unknown");
    expect(seen.map((s) => s.model)).toEqual([FLASH]);
  });

  it("is unknown — never none — when the question itself fails", async () => {
    for (const failure of ["throw", 500, 429, 401] as const) {
      const { fetchImpl } = proxy({ [FLASH]: failure, [FALLBACK]: failure });
      expect((await probeClawboxAiVision({ token: "t", fetchImpl })).verdict, String(failure)).toBe("unknown");
    }
  });

  it("asks the lab override instead of the box's endpoint when one is stored", async () => {
    store.values[CLAWBOX_AI_VISION_PROBE_URL_KEY] = "http://127.0.0.1:18899/api/ai";
    const { fetchImpl, seen } = proxy({ [FLASH]: "red" });
    await probeClawboxAiVision({ token: "t", baseUrl: "https://clawbox.com/api/ai", fetchImpl });
    expect(seen[0].url).toBe("http://127.0.0.1:18899/api/ai/chat/completions");

    store.values[CLAWBOX_AI_VISION_PROBE_URL_KEY] = "file:///etc/passwd";
    const second = proxy({ [FLASH]: "red" });
    await probeClawboxAiVision({ token: "t", baseUrl: "https://clawbox.com/api/ai", fetchImpl: second.fetchImpl });
    expect(second.seen[0].url).toBe("https://clawbox.com/api/ai/chat/completions");
  });
});

describe("clawboxAiVisionModelFor", () => {
  const probe = (verdict: ClawboxAiVisionProbe["verdict"], flash: ClawboxAiVisionProbe["flash"] = "unknown"): ClawboxAiVisionProbe =>
    ({ verdict, model: verdict === "flash" ? FLASH : verdict === "fallback" ? FALLBACK : null, flash, fallback: null });

  it("follows a definite answer", () => {
    expect(clawboxAiVisionModelFor(probe("flash", "sees"), `deepseek/${FALLBACK}`)).toBe(FLASH);
    expect(clawboxAiVisionModelFor(probe("fallback", "blind"), `deepseek/${FLASH}`)).toBe(FALLBACK);
    expect(clawboxAiVisionModelFor(probe("none", "blind"), `deepseek/${FLASH}`)).toBeNull();
  });

  it("keeps what the box has when there is no answer", () => {
    expect(clawboxAiVisionModelFor(probe("unknown"), `deepseek/${FALLBACK}`)).toBe(FALLBACK);
    expect(clawboxAiVisionModelFor(probe("unknown"), FLASH)).toBe(FLASH);
    expect(clawboxAiVisionModelFor(probe("unknown"), null)).toBe(FLASH);
    expect(clawboxAiVisionModelFor(probe("unknown"), `deepseek/${RETIRED_CLAWBOX_AI_VISION_MODEL_IDS[0]}`)).toBe(FLASH);
  });

  it("prefers the fallback when Flash itself refused the picture", () => {
    expect(clawboxAiVisionModelFor(probe("unknown", "blind"), `deepseek/${FLASH}`)).toBe(FALLBACK);
  });
});

describe("isClawboxAiVisionSlotOurs", () => {
  it("claims Flash, the fallback and the ids ClawBox used to write, under our provider", () => {
    for (const id of [FLASH, FALLBACK, ...RETIRED_CLAWBOX_AI_VISION_MODEL_IDS]) {
      expect(isClawboxAiVisionSlotOurs(`deepseek/${id}`), id).toBe(true);
      expect(isClawboxAiVisionSlotOurs(`clawai/${id}`), id).toBe(true);
      expect(isClawboxAiVisionSlotOurs(id, { bare: true }), id).toBe(true);
    }
  });

  it("never claims the owner's model", () => {
    expect(isClawboxAiVisionSlotOurs(`openai/${FALLBACK}`)).toBe(false);
    expect(isClawboxAiVisionSlotOurs("google/gemini-2.5-flash")).toBe(false);
    expect(isClawboxAiVisionSlotOurs(FLASH)).toBe(false);
    expect(isClawboxAiVisionSlotOurs(`deepseek/${FLASH}`, { deepseekIsClawboxAi: false })).toBe(false);
    expect(isClawboxAiVisionSlotOurs("")).toBe(false);
    expect(isClawboxAiVisionSlotOurs(undefined)).toBe(false);
  });
});

describe("the recorded verdict", () => {
  it("round-trips, and ignores a store value it did not write", async () => {
    await recordClawboxAiVision({ verdict: "fallback", model: FALLBACK, flash: "blind", fallback: "sees" }, FALLBACK);
    expect(await readClawboxAiVision()).toMatchObject({ verdict: "fallback", model: FALLBACK });
    store.values[CLAWBOX_AI_VISION_STORE_KEY] = { verdict: "maybe" };
    expect(await readClawboxAiVision()).toBeNull();
  });
});
