import { describe, expect, it, vi } from "vitest";
import { speakInCloud, speakThroughChain, withSpeechLock, withSpeechQueue } from "@/lib/voice-speak";
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

/**
 * The box speaks one thing at a time. A reply waits its turn — one speaking,
 * up to three behind it, the fifth simultaneous ask refused — while an
 * audition is refused the moment anything is admitted.
 */
describe("the speech queue", () => {
  const gate = () => {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { open, work: async () => { await opened; return new Response("ok"); } };
  };

  it("admits one speaking and three waiting, refuses the fifth, and lets the next in once one finished", async () => {
    const gates = [gate(), gate(), gate(), gate()];
    const running = gates.map((g) => withSpeechQueue(g.work));
    // All four are admitted before any of them has started speaking.
    const fifth = await withSpeechQueue(async () => new Response("late"));
    expect(fifth.status).toBe(429);
    expect((await fifth.json()).code).toBe("busy");
    gates[0].open();
    expect((await running[0]).status).toBe(200);
    // A slot came free: the next ask is admitted.
    const sixthGate = gate();
    const sixth = withSpeechQueue(sixthGate.work);
    for (const g of gates.slice(1)) g.open();
    sixthGate.open();
    for (const r of running.slice(1)) expect((await r).status).toBe(200);
    expect((await sixth).status).toBe(200);
  });

  it("refuses an audition while anything is admitted", async () => {
    const g = gate();
    const reply = withSpeechQueue(g.work);
    const audition = await withSpeechLock(async () => new Response("sample"));
    expect(audition.status).toBe(429);
    g.open();
    await reply;
    const later = await withSpeechLock(async () => new Response("sample"));
    expect(later.status).toBe(200);
  });
});

/**
 * A credential goes only to an endpoint the box would trust with one: https,
 * or plain http on the loopback. A provider entry pointing elsewhere is the
 * box's own configuration, but it is refused rather than obeyed.
 */
describe("the cloud speech endpoint", () => {
  const configWith = (baseUrl: string) => ({
    tts: { provider: "openai", providers: { openai: { baseUrl, model: "gpt-4o-mini-tts", apiKey: "claw_x" } } },
    models: { providers: { openai: { apiKey: "claw_x" } } },
  } as unknown as VoiceConfigView);

  it("refuses plain http off the box, and never sends the credential there", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(new Uint8Array(4096), { status: 200, headers: { "Content-Type": "audio/wav" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await speakInCloud(configWith("http://evil.example/api/ai"), null, "hi");
      expect(res.status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
      const ok = await speakInCloud(configWith("https://clawbox.com/api/ai"), null, "hi");
      expect(ok.status).toBe(200);
      expect(String(fetchMock.mock.calls[0][0])).toBe("https://clawbox.com/api/ai/audio/speech");
      const loop = await speakInCloud(configWith("http://127.0.0.1:8080/api/ai"), null, "hi");
      expect(loop.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
