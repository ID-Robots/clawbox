import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /setup-api/tts/speak — the desktop chat's spoken reply.
 *
 * Pinned: the chain is walked in the order the Voice tab set (the preferred
 * engine first, the other behind it), the Markdown is lifted off the text
 * before it is spoken, the owner's switch gates it, and the engine that spoke
 * is named on the answer.
 */

const readConfigMock = vi.fn();
const inventoryMock = vi.fn();
const stateMock = vi.fn();
const autoReplyMock = vi.fn();
const chainMock = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: () => false,
  readConfig: (...a: unknown[]) => readConfigMock(...a),
}));
vi.mock("@/lib/local-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-models")>();
  return { ...actual, buildTtsInventory: (...a: unknown[]) => inventoryMock(...a) };
});
vi.mock("@/lib/voice-output-store", () => ({
  readVoiceState: (...a: unknown[]) => stateMock(...a),
  readLocalVoice: async () => null,
}));
vi.mock("@/lib/voice-reply", () => ({ getVoiceAutoReply: (...a: unknown[]) => autoReplyMock(...a) }));
vi.mock("@/lib/voice-speak", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice-speak")>();
  return { ...actual, speakThroughChain: (...a: unknown[]) => chainMock(...a) };
});
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, promises: { ...actual.promises, access: async () => undefined } };
});

const LOCAL = "tts-local-cli";
const kokoro = [{ id: "kokoro", name: "Kokoro", kind: "tts", installed: true }];

function config() {
  return {
    tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" }, openai: { model: "gpt-4o-mini-tts" } } },
    models: { providers: { openai: { apiKey: "sk-live-abc" } } },
  };
}

const audio = () => new Response(new Uint8Array(4096), { status: 200, headers: { "Content-Type": "audio/wav", "X-ClawBox-Voice-Engine": "cloud" } });

async function route() {
  return await import("@/app/setup-api/tts/speak/route");
}

function post(body: unknown) {
  return new Request("http://box/setup-api/tts/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetModules();
  readConfigMock.mockReset().mockResolvedValue(config());
  inventoryMock.mockReset().mockResolvedValue(kokoro);
  stateMock.mockReset().mockResolvedValue({ choice: "auto" });
  autoReplyMock.mockReset().mockResolvedValue(true);
  chainMock.mockReset().mockImplementation(async () => audio());
});

describe("POST /setup-api/tts/speak", () => {
  it("hands the chain the words of the reply, not its Markdown, and the owner's order", async () => {
    stateMock.mockResolvedValue({ choice: "local" });
    const { POST } = await route();
    const res = await POST(post({ text: "**Done.** See [docs](https://x.y)." }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-clawbox-voice-engine")).toBe("cloud");
    expect(chainMock).toHaveBeenCalledTimes(1);
    const [, engines, choice, text] = chainMock.mock.calls[0] as [unknown, { id: string; configured: boolean }[], string, string];
    expect(choice).toBe("local");
    expect(text).toBe("Done. See docs.");
    // The engines as the status card judges them: both usable on this box.
    expect(engines.map((e) => [e.id, e.configured])).toEqual([["local", true], ["cloud", true]]);
  });

  it("is refused while the owner's switch is off", async () => {
    autoReplyMock.mockResolvedValue(false);
    const { POST } = await route();
    const res = await POST(post({ text: "hello" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("switched_off");
    expect(chainMock).not.toHaveBeenCalled();
  });

  it("has nothing to say for a reply that is only markup", async () => {
    const { POST } = await route();
    const res = await POST(post({ text: "MEDIA: /a.png" }));
    expect(res.status).toBe(400);
    expect(chainMock).not.toHaveBeenCalled();
  });
});
