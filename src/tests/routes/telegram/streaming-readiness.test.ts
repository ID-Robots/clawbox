import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-608, the fourth instance of the class. `/setup-api/telegram/streaming`
 * answered 502 for every `restartGateway()` rejection. On beta that could only
 * mean `systemctl restart` had failed — a real "nothing is coming". The
 * readiness wait widened it to "the port did not open inside the budget",
 * which on a cold box is the ordinary case, so a slow-but-healthy restart
 * started being reported as a failed one.
 *
 * The three siblings already fixed (`ai-models/configure`, `stt`,
 * `providers/default`) all split on `GatewayNotReadyError`; this pins the same
 * split here, including the half that must NOT move: a refused restart.
 */

const restartGateway = vi.fn<() => Promise<void>>();
const setTelegramProgressStreaming = vi.fn<(enabled: boolean) => Promise<void>>();

vi.mock("@/lib/openclaw-config", () => ({
  // A REAL class: the route narrows on `instanceof GatewayNotReadyError`, and
  // `instanceof undefined` throws a TypeError the moment a test makes the
  // mocked restart reject.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
  gatewayIsAbsent: () => false,
  getTelegramProgressStreaming: vi.fn(async () => true),
  setTelegramProgressStreaming: (enabled: boolean) => setTelegramProgressStreaming(enabled),
  restartGateway: () => restartGateway(),
}));

function post(enabled: boolean): Request {
  return new Request("http://localhost/setup-api/telegram/streaming", {
    method: "POST",
    body: JSON.stringify({ enabled }),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  setTelegramProgressStreaming.mockResolvedValue();
  restartGateway.mockResolvedValue();
});

describe("POST /setup-api/telegram/streaming and a gateway still coming back", () => {
  it("reports a slow restart as saved, not as a failed one", async () => {
    const { GatewayNotReadyError } = await import("@/lib/openclaw-config");
    restartGateway.mockRejectedValue(new GatewayNotReadyError());

    const { POST } = await import("@/app/setup-api/telegram/streaming/route");
    const res = await POST(post(false));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The setting is on disk; only the gateway has not picked it up yet.
    expect(setTelegramProgressStreaming).toHaveBeenCalledWith(false);
    expect(body.restarted).toBe(false);
    expect(body.warning).toMatch(/has not finished restarting/);
  });

  it("still reports a refused restart as a failed restart", async () => {
    restartGateway.mockRejectedValue(new Error("Unit clawbox-gateway.service is masked."));

    const { POST } = await import("@/app/setup-api/telegram/streaming/route");
    const res = await POST(post(true));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.success).toBe(true);
    expect(body.warning).toMatch(/restart failed/);
  });

  it("says nothing about a restart that worked", async () => {
    const { POST } = await import("@/app/setup-api/telegram/streaming/route");
    const res = await POST(post(true));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.restarted).toBe(true);
    expect(body.warning).toBeUndefined();
  });
});
