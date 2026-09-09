import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * `/setup-api/chat/capabilities` — and specifically whether it admits that a
 * fact is still a PLACEHOLDER.
 *
 * Every Hermes fact here fails closed, so "the probe could not answer" and "the
 * answer is no" leave the route by the same door: `false`. That is correct for
 * the composer — a wrong `true` stages the customer's file into a turn that
 * ignores it — but it is not the whole truth, and the browser was told only the
 * `false`. `use-harness-adapter` fetches this once on mount and re-asks solely
 * on an explicit provider change, on no timer, so one 30 s probe timeout during
 * chat open hid the attach button for the whole page session while the server
 * quietly recovered a minute later.
 *
 * So the unknown-ness has to travel: `factsPending` says at least one Hermes
 * fact came from a backoff entry rather than an answer, and `factsRetryAfterMs`
 * says how long the server intends to hold it — published rather than
 * duplicated on the client, so the two numbers cannot drift.
 */

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/harness/clawai-images", () => ({ clawaiImageRouteReachable: vi.fn() }));
vi.mock("@/lib/hermes-dashboard-turn", () => ({ hermesCanStreamTurns: vi.fn() }));
vi.mock("@/lib/hermes-tts", () => ({
  hermesSpeaksReplies: vi.fn(),
  hermesVoiceProbePending: vi.fn(),
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

interface Body {
  harness: string;
  facts: Record<string, boolean>;
  factsPending: boolean;
  factsRetryAfterMs: number;
}

let GET: () => Promise<Response>;
let getActiveHarness: Mock;
let flagProbePending: Mock;
let visionPending: Mock;
let imageBackendPending: Mock;
let voicePending: Mock;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as {
    getActiveHarness: Mock;
  });
  const credentials = (await import("@/lib/harness/credentials")) as unknown as {
    hasClawaiToken: Mock;
  };
  const images = (await import("@/lib/harness/clawai-images")) as unknown as {
    clawaiImageRouteReachable: Mock;
  };
  const dashboard = (await import("@/lib/hermes-dashboard-turn")) as unknown as {
    hermesCanStreamTurns: Mock;
  };
  const features = (await import("@/lib/harness/hermes-features")) as unknown as {
    hermesSupportsImages: Mock;
    hermesHasVisionRoute: Mock;
    hermesAgentDrawsImages: Mock;
    hermesFeatureProbePending: Mock;
    hermesVisionRoutePending: Mock;
    hermesImageBackendPending: Mock;
  };
  const voice = (await import("@/lib/hermes-tts")) as unknown as {
    hermesSpeaksReplies: Mock;
    hermesVoiceProbePending: Mock;
  };
  voice.hermesSpeaksReplies.mockResolvedValue(false);
  voicePending = voice.hermesVoiceProbePending;

  getActiveHarness.mockResolvedValue("hermes");
  credentials.hasClawaiToken.mockResolvedValue(false);
  images.clawaiImageRouteReachable.mockResolvedValue(false);
  dashboard.hermesCanStreamTurns.mockResolvedValue(false);
  features.hermesSupportsImages.mockResolvedValue(false);
  features.hermesHasVisionRoute.mockResolvedValue(false);
  features.hermesAgentDrawsImages.mockResolvedValue(false);
  flagProbePending = features.hermesFeatureProbePending;
  visionPending = features.hermesVisionRoutePending;
  imageBackendPending = features.hermesImageBackendPending;
  flagProbePending.mockReturnValue(false);
  visionPending.mockReturnValue(false);
  imageBackendPending.mockReturnValue(false);
  voicePending.mockReturnValue(false);

  ({ GET } = await import("@/app/setup-api/chat/capabilities/route"));
});

async function body(): Promise<Body> {
  return (await (await GET()).json()) as Body;
}

describe("GET /setup-api/chat/capabilities", () => {
  it("reports nothing pending when every probe answered", async () => {
    const payload = await body();
    expect(payload.facts.hermesSupportsImages).toBe(false);
    expect(payload.factsPending).toBe(false);
  });

  it("reports pending when the --image flag probe is in backoff", async () => {
    flagProbePending.mockReturnValue(true);
    expect((await body()).factsPending).toBe(true);
  });

  it("reports pending when the vision-route read is in backoff", async () => {
    visionPending.mockReturnValue(true);
    expect((await body()).factsPending).toBe(true);
  });

  it("reports pending when the voice read is in backoff", async () => {
    // `hermesSpeaksReplies` fails closed, so "this box has no voice" and "the
    // box could not be asked" leave by the same door. Without this the page —
    // which fetches these facts once on mount and on no timer — hid a working
    // voice until reload over one timed-out `hermes config get`.
    voicePending.mockReturnValue(true);
    expect((await body()).factsPending).toBe(true);
  });

  it("reports pending when the image-backend read is in backoff", async () => {
    imageBackendPending.mockReturnValue(true);
    expect((await body()).factsPending).toBe(true);
  });

  it("publishes how long the browser should wait before re-asking", async () => {
    flagProbePending.mockReturnValue(true);
    expect((await body()).factsRetryAfterMs).toBeGreaterThan(0);
  });

  it("never reports a Hermes fact as pending on an OpenClaw box", async () => {
    // The probes are not run there at all, so a stale entry left behind by an
    // earlier harness must not make an OpenClaw page re-ask on a timer for a
    // fact no OpenClaw capability reads.
    getActiveHarness.mockResolvedValue("openclaw");
    flagProbePending.mockReturnValue(true);
    visionPending.mockReturnValue(true);
    imageBackendPending.mockReturnValue(true);
    expect((await body()).factsPending).toBe(false);
  });
});
