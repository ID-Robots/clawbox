import { describe, expect, it, vi } from "vitest";
import { speakThroughChain } from "@/lib/voice-speak";
import type { VoiceConfigView, VoiceEngine } from "@/lib/voice-output";

/**
 * The reply chain: the engine the Voice tab put first, then the other; the
 * one that spoke is named; when neither could, the primary's refusal is the
 * answer, because that is the engine the owner chose and its message names
 * their next step.
 */

const config = {} as VoiceConfigView;
const engine = (id: "local" | "cloud", configured = true): VoiceEngine => ({ id, providerId: id, label: id, configured, detail: "" });
const audio = () => new Response(new Uint8Array(2048), { status: 200, headers: { "Content-Type": "audio/wav" } });
const refusal = (code: string) => new Response(JSON.stringify({ error: code, code }), { status: 502, headers: { "Content-Type": "application/json" } });

describe("speakThroughChain", () => {
  it("speaks with the preferred engine and names it", async () => {
    const local = vi.fn(async () => audio());
    const cloud = vi.fn(async () => audio());
    const res = await speakThroughChain(config, [engine("local"), engine("cloud")], "local", "hi", { local, cloud });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-clawbox-voice-engine")).toBe("local");
    expect(cloud).not.toHaveBeenCalled();
  });

  it("falls through to the other engine when the first cannot speak", async () => {
    const local = vi.fn(async () => refusal("local_memory"));
    const cloud = vi.fn(async () => audio());
    const res = await speakThroughChain(config, [engine("local"), engine("cloud")], "local", "hi", { local, cloud });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-clawbox-voice-engine")).toBe("cloud");
    expect(local).toHaveBeenCalledTimes(1);
  });

  it("puts the cloud first under Auto, and skips an engine the box does not have", async () => {
    const local = vi.fn(async () => audio());
    const cloud = vi.fn(async () => audio());
    await speakThroughChain(config, [engine("local", false), engine("cloud")], "auto", "hi", { local, cloud });
    expect(cloud).toHaveBeenCalledTimes(1);
    expect(local).not.toHaveBeenCalled();
  });

  it("answers the primary's refusal when neither could speak", async () => {
    const local = vi.fn(async () => refusal("local_timeout"));
    const cloud = vi.fn(async () => refusal("cloud_refused"));
    const res = await speakThroughChain(config, [engine("local"), engine("cloud")], "local", "hi", { local, cloud });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("local_timeout");
  });

  it("says so when the box has no voice at all", async () => {
    const res = await speakThroughChain(config, [engine("local", false), engine("cloud", false)], "auto", "hi", {
      local: vi.fn(async () => audio()), cloud: vi.fn(async () => audio()),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("no_voice");
  });
});
