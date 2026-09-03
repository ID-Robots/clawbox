import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /setup-api/tts/install — the Local AI tab's Install on an absent Kokoro.
 *
 * Pinned: the work is install.sh's own openclaw_tts step, started as root
 * through the launcher and followed line by line in the same stream shape
 * the Gemma install answers with; the MCP bearer is refused, because
 * installing software as root is the person's decision.
 */

const ownerMock = vi.fn();
const followMock = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({ openclawIsAbsent: () => false }));
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: (...a: unknown[]) => ownerMock(...a) }));
vi.mock("@/lib/root-step-follow", () => ({ followRootStep: (...a: unknown[]) => followMock(...a) }));

async function route() {
  return await import("@/app/setup-api/tts/install/route");
}

function post() {
  return new Request("http://box/setup-api/tts/install", { method: "POST", body: "{}" });
}

async function lines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  vi.resetModules();
  ownerMock.mockReset().mockResolvedValue(true);
  followMock.mockReset();
});

describe("POST /setup-api/tts/install", () => {
  it("refuses the MCP bearer", async () => {
    ownerMock.mockResolvedValue(false);
    const { POST } = await route();
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(followMock).not.toHaveBeenCalled();
  });

  it("runs the openclaw_tts root step and streams its lines, then a closing success", async () => {
    followMock.mockImplementation(async (step: string, opts: { onStatus: (line: string) => void }) => {
      opts.onStatus("=== On-device TTS (Kokoro GPU) ===");
      opts.onStatus("Kokoro GPU TTS installed");
      return { ok: true };
    });
    const { POST } = await route();
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(followMock.mock.calls[0][0]).toBe("openclaw_tts");
    const out = await lines(res);
    expect(out.map((l) => l.status)).toContain("Kokoro GPU TTS installed");
    expect(out[out.length - 1]).toMatchObject({ success: true });
  });

  it("closes with the step's error when it failed", async () => {
    followMock.mockResolvedValue({ ok: false, error: "Kokoro GPU TTS NOT installed: no CUDA" });
    const { POST } = await route();
    const out = await lines(await POST(post()));
    expect(out[out.length - 1]).toEqual({ error: "Kokoro GPU TTS NOT installed: no CUDA" });
  });
});
