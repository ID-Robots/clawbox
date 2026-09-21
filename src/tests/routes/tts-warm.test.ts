import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /setup-api/tts/warm — wake the box's own voice before it is needed.
 *
 * The Kokoro server stops itself after five idle minutes and nothing brings it
 * back, so the first spoken reply of a conversation pays a 13-19 s cold start.
 * The microphone button and the Voice tab's engine pick call this the moment
 * the person acts.
 *
 * Pinned here: it starts and never ENABLES (a warm-up must not undo an engine
 * the owner switched off for good), it names only the Kokoro unit, it says so
 * plainly when there is nothing on this box to warm, and it is closed to
 * anyone but the owner's own page — it spawns systemctl.
 */

const ownerMock = vi.fn();
const unitStateMock = vi.fn();
const startMock = vi.fn();

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: (...a: unknown[]) => ownerMock(...a) }));

vi.mock("@/lib/local-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-models")>();
  return {
    ...actual,
    readUnitState: (...a: unknown[]) => unitStateMock(...a),
    startUserEngine: (...a: unknown[]) => startMock(...a),
  };
});

async function route() {
  return await import("@/app/setup-api/tts/warm/route");
}

/** A POST as the desktop makes it: our own origin, addressed to this box. */
function post(headers: Record<string, string> = {}) {
  return new Request("http://box/setup-api/tts/warm", {
    method: "POST",
    headers: { host: "box", origin: "http://box", ...headers },
  });
}

beforeEach(() => {
  vi.resetModules();
  ownerMock.mockReset().mockResolvedValue(true);
  unitStateMock.mockReset().mockResolvedValue({ present: true, active: false, enabled: true, failed: false });
  startMock.mockReset().mockResolvedValue({ ok: true });
});

describe("POST /setup-api/tts/warm", () => {
  it("starts the Kokoro unit and answers before the model is loaded", async () => {
    const { POST } = await route();
    const res = await POST(post());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ warming: true });
    expect(startMock).toHaveBeenCalledWith("kokoro-server.service");
  });

  it("does not start a server that is already speaking", async () => {
    unitStateMock.mockResolvedValue({ present: true, active: true, enabled: true, failed: false });
    const { POST } = await route();
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ warm: true });
    expect(startMock).not.toHaveBeenCalled();
  });

  it("says there is nothing to warm on a box with no voice of its own", async () => {
    unitStateMock.mockResolvedValue({ present: false, active: false, enabled: false, failed: false });
    const { POST } = await route();
    const res = await POST(post());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_installed");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("reports a systemd that would not start it, rather than promising a warm engine", async () => {
    startMock.mockResolvedValue({ ok: false, error: "Could not start the service." });
    const { POST } = await route();
    const res = await POST(post());
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("start_failed");
  });

  it("refuses the MCP bearer: spawning systemctl is the person's doing", async () => {
    ownerMock.mockResolvedValue(false);
    const { POST } = await route();
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("refuses another site's page, which carries the owner's cookie all the same", async () => {
    const { POST } = await route();
    const res = await POST(post({ origin: "http://evil.example" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe("startUserEngine", () => {
  it("is the only unit name the route can reach, and never enables anything", async () => {
    // The route hands it a constant, but the allow-list is what makes that
    // safe if a caller ever hands it something else — and `enable` would turn
    // a warm-up into a permanent change to how the box boots.
    const actual = await vi.importActual<typeof import("@/lib/local-models")>("@/lib/local-models");
    const res = await actual.startUserEngine("clawbox-gateway.service");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Unknown service.");
  });
});
