import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /setup-api/tts/install — the Local AI tab's Install on an absent Kokoro,
 * and its Uninstall on a present one.
 *
 * Pinned: the install is install.sh's own openclaw_tts step, started as root
 * through the launcher and followed line by line in the same stream shape
 * the Gemma install answers with; the MCP bearer is refused on both verbs,
 * because installing software as root — and taking the owner's voice away —
 * is the person's decision; and an uninstall that leaves a "this box" pick
 * standing settles it on Auto through the tts route's own selection.
 */

const ownerMock = vi.fn();
const followMock = vi.fn();
const uninstallMock = vi.fn();
const selectMock = vi.fn();
const writeStateMock = vi.fn();
const clearChoiceMock = vi.fn();
const voiceState = { choice: "auto" as string };

vi.mock("@/lib/openclaw-config", () => ({ openclawIsAbsent: () => false }));
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: (...a: unknown[]) => ownerMock(...a) }));
vi.mock("@/lib/root-step-follow", () => ({ followRootStep: (...a: unknown[]) => followMock(...a) }));
vi.mock("@/lib/kokoro-uninstall", () => ({ uninstallKokoro: () => uninstallMock() }));
vi.mock("@/app/setup-api/tts/route", () => ({ POST: (...a: unknown[]) => selectMock(...a) }));
vi.mock("@/lib/voice-output-store", () => ({
  readVoiceState: async () => ({ choice: voiceState.choice }),
  writeVoiceState: (...a: unknown[]) => writeStateMock(...a),
}));
vi.mock("@/lib/clawai-cloud-choice", () => ({ clearOwnerChoice: (...a: unknown[]) => clearChoiceMock(...a) }));

async function route() {
  return await import("@/app/setup-api/tts/install/route");
}

function post() {
  return new Request("http://box/setup-api/tts/install", { method: "POST", body: "{}" });
}

function del(headers: Record<string, string> = {}) {
  return new Request("http://box/setup-api/tts/install", { method: "DELETE", headers });
}

async function lines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  vi.resetModules();
  ownerMock.mockReset().mockResolvedValue(true);
  followMock.mockReset();
  uninstallMock.mockReset().mockResolvedValue({ ok: true, freedBytes: 330 * 1024 * 1024 });
  selectMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ choice: "auto" }), { status: 200 }));
  writeStateMock.mockReset().mockResolvedValue(undefined);
  clearChoiceMock.mockReset().mockResolvedValue(undefined);
  voiceState.choice = "auto";
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

describe("DELETE /setup-api/tts/install", () => {
  it("refuses the MCP bearer with a stable code, before anything is touched", async () => {
    ownerMock.mockResolvedValue(false);
    const { DELETE } = await route();
    const res = await DELETE(del());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it("refuses another site's page", async () => {
    const { DELETE } = await route();
    const res = await DELETE(del({ Origin: "http://evil.example" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it("takes the voice off and answers what came back, with no fallback when the pick was not the box", async () => {
    const { DELETE } = await route();
    const res = await DELETE(del());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, freedBytes: 330 * 1024 * 1024, installed: false });
    expect(selectMock).not.toHaveBeenCalled();
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("settles a standing 'this box' pick on Auto through the tts route, and says so the way that route does", async () => {
    voiceState.choice = "local";
    const { DELETE } = await route();
    const body = await (await DELETE(del())).json();

    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(selectMock).toHaveBeenCalledTimes(1);
    const asked = selectMock.mock.calls[0][0] as Request;
    expect(asked.method).toBe("POST");
    expect(await asked.json()).toEqual({ action: "select", choice: "auto" });
    expect(body.fallback).toEqual({ requested: "local", reason: "not_installed" });
    // The route did the state write; nothing here wrote over it.
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("still writes the pick to Auto when the tts route refuses (a box with no cloud voice either)", async () => {
    voiceState.choice = "local";
    selectMock.mockResolvedValue(new Response(JSON.stringify({ error: "no voice", code: "no_voice" }), { status: 409 }));
    const { DELETE } = await route();
    const body = await (await DELETE(del())).json();

    expect(body.fallback).toEqual({ requested: "local", reason: "not_installed" });
    expect(writeStateMock).toHaveBeenCalledWith({ choice: "auto" });
    expect(clearChoiceMock).toHaveBeenCalledWith("tts");
  });

  it("passes the device's refusal through and leaves the pick alone", async () => {
    voiceState.choice = "local";
    uninstallMock.mockResolvedValue({ ok: false, freedBytes: null, error: "Could not remove the service file.", code: "remove_failed" });
    const { DELETE } = await route();
    const res = await DELETE(del());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not remove the service file.", code: "remove_failed" });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("refuses while the voice is being installed", async () => {
    let finish!: () => void;
    followMock.mockImplementation(() => new Promise<{ ok: boolean }>((resolve) => { finish = () => resolve({ ok: true }); }));
    const { POST, DELETE } = await route();
    const installing = await POST(post());
    const res = await DELETE(del());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("busy");
    expect(uninstallMock).not.toHaveBeenCalled();
    finish();
    await lines(installing);
  });
});
