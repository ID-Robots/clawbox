import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * `/setup-api/chat/capabilities` — that the Hermes facts are asked TOGETHER.
 *
 * Six of the facts this route reports are independent probes, and on a cold
 * cache each is a real cost: `hermes chat --help` is a Python interpreter
 * start (0.9-1.3 s on a Jetson), the `hermes config get` reads (the vision
 * route, the image backend, and the voice `tts.provider`) are more of the
 * same, the streaming probe mints a WebSocket ticket, and the image-route
 * probe leaves the device. `use-harness-adapter` asks for all of them on every
 * chat mount, and every `hermes config set` bumps config.yaml's mtime and
 * evicts the config memos behind two of them.
 *
 * Awaited one after another that added up to 2.5-4 s of the customer looking
 * at a chat with no attach button. Nothing in that chain feeds the next link,
 * so the wait should be the SLOWEST probe, not the SUM of them.
 *
 * Pinned with fake timers rather than a wall clock: each probe is a 300 ms
 * timer, and the route must have settled once the clock has moved 300 ms. A
 * serial route needs the clock to move 1500 ms.
 */

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/harness/clawai-images", () => ({ clawaiImageRouteReachable: vi.fn() }));
vi.mock("@/lib/hermes-dashboard-turn", () => ({ hermesCanStreamTurns: vi.fn() }));
vi.mock("@/lib/hermes-tts", () => ({
  hermesSpeaksReplies: vi.fn(),
  // Read by `factsPending`; the memo accessor never spawns, so a plain false.
  hermesVoiceProbePending: vi.fn(() => false),
}));
vi.mock("@/lib/harness/hermes-features", () => ({
  hermesSupportsImages: vi.fn(),
  hermesHasVisionRoute: vi.fn(),
  hermesAgentDrawsImages: vi.fn(),
  hermesFeatureProbePending: vi.fn(),
  hermesVisionRoutePending: vi.fn(),
  hermesImageBackendPending: vi.fn(),
  HERMES_FACT_RETRY_MS: 60_000,
}));

const PROBE_MS = 300;

/** A probe that answers `value` after one fake-clock tick of `PROBE_MS`. */
function slowProbe(value: boolean): () => Promise<boolean> {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), PROBE_MS));
}

interface Body {
  harness: string;
  facts: Record<string, boolean>;
  factsPending: boolean;
}

let GET: () => Promise<Response>;
let getActiveHarness: Mock;
let hasClawaiToken: Mock;
let probes: Record<string, Mock>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as {
    getActiveHarness: Mock;
  });
  ({ hasClawaiToken } = (await import("@/lib/harness/credentials")) as unknown as {
    hasClawaiToken: Mock;
  });
  const images = (await import("@/lib/harness/clawai-images")) as unknown as {
    clawaiImageRouteReachable: Mock;
  };
  const dashboard = (await import("@/lib/hermes-dashboard-turn")) as unknown as {
    hermesCanStreamTurns: Mock;
  };
  const voice = (await import("@/lib/hermes-tts")) as unknown as {
    hermesSpeaksReplies: Mock;
  };
  const features = (await import("@/lib/harness/hermes-features")) as unknown as {
    hermesSupportsImages: Mock;
    hermesHasVisionRoute: Mock;
    hermesAgentDrawsImages: Mock;
    hermesFeatureProbePending: Mock;
    hermesVisionRoutePending: Mock;
    hermesImageBackendPending: Mock;
  };
  probes = {
    hermesSupportsImages: features.hermesSupportsImages,
    hermesHasVisionRoute: features.hermesHasVisionRoute,
    hermesStreamsTurns: dashboard.hermesCanStreamTurns,
    hasClawaiImageRoute: images.clawaiImageRouteReachable,
    hermesAgentDrawsImages: features.hermesAgentDrawsImages,
    hermesSpeaksReplies: voice.hermesSpeaksReplies,
  };

  getActiveHarness.mockResolvedValue("hermes");
  hasClawaiToken.mockResolvedValue(true);
  for (const probe of Object.values(probes)) probe.mockImplementation(slowProbe(true));
  features.hermesFeatureProbePending.mockReturnValue(false);
  features.hermesVisionRoutePending.mockReturnValue(false);
  features.hermesImageBackendPending.mockReturnValue(false);

  ({ GET } = await import("@/app/setup-api/chat/capabilities/route"));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts the request and reports whether it has settled, without awaiting it. */
function startRequest(): { settled: () => boolean; body: () => Promise<Body> } {
  let done = false;
  const response = GET().then((res) => {
    done = true;
    return res;
  });
  return {
    settled: () => done,
    body: async () => (await (await response).json()) as Body,
  };
}

describe("GET /setup-api/chat/capabilities asks the Hermes probes together", () => {
  it("settles after ONE probe's worth of waiting on a linked Hermes box", async () => {
    const request = startRequest();
    await vi.advanceTimersByTimeAsync(PROBE_MS);
    expect(request.settled()).toBe(true);

    const payload = await request.body();
    expect(payload.harness).toBe("hermes");
    expect(payload.facts).toMatchObject({
      hasClawaiToken: true,
      hermesSupportsImages: true,
      hermesHasVisionRoute: true,
      hermesStreamsTurns: true,
      hasClawaiImageRoute: true,
      hermesAgentDrawsImages: true,
      hermesSpeaksReplies: true,
    });
  });

  it("has every probe in flight before any of them has answered", async () => {
    startRequest();
    // Let the two sequential pre-checks (harness, credential) resolve, but do
    // not move the clock: no probe can have answered yet.
    await vi.advanceTimersByTimeAsync(0);
    for (const [name, probe] of Object.entries(probes)) {
      expect(probe, name).toHaveBeenCalledTimes(1);
    }
  });

  it("still leaves the proxy alone on an unlinked box", async () => {
    // Parallel is not the same as unconditional: the one probe that leaves the
    // device is asked only where there is a credential to spend on a picture.
    hasClawaiToken.mockResolvedValue(false);
    const request = startRequest();
    await vi.advanceTimersByTimeAsync(PROBE_MS);
    expect(request.settled()).toBe(true);
    expect(probes.hasClawaiImageRoute).not.toHaveBeenCalled();
    expect((await request.body()).facts.hasClawaiImageRoute).toBe(false);
  });

  it("still asks nothing of hermes on an OpenClaw box", async () => {
    getActiveHarness.mockResolvedValue("openclaw");
    const request = startRequest();
    await vi.advanceTimersByTimeAsync(0);
    expect(request.settled()).toBe(true);
    for (const [name, probe] of Object.entries(probes)) {
      expect(probe, name).not.toHaveBeenCalled();
    }
  });
});
