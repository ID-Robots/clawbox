import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What "this edition" means for /setup-api/tts.
 *
 * This file used to assert that the whole route refused on Hermes, on the
 * premise that "/setup-api/tts is entirely openclaw-CLI work". Two of the
 * three things that premise named are gone: the `capability tts convert`
 * Check button was deleted with the panel rewrite, and the config writes now
 * go to whichever harness actually speaks (`hermes config set tts.*` on a box
 * running Hermes). What is left that genuinely needs the gateway is a spoken
 * reply on a CHANNEL — WhatsApp, Telegram, Discord — because a Hermes box has
 * no gateway and no channels.
 *
 * So the edition fact is now reported about that half only, exactly the shape
 * /setup-api/stt has always used, and the panel keeps working. The Hermes
 * behaviour itself is pinned in tts-hermes-parity.test.ts; this file pins the
 * BOUNDARY: what each edition says about channels, and that the gate never
 * swallows the ordinary contract.
 */

const mockOpenclawIsAbsent = vi.fn();
const mockActiveHarness = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => mockOpenclawIsAbsent(),
  readConfig: async () => ({}),
  runOpenclawConfigSet: async () => {},
}));

vi.mock("@/lib/harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/harness")>();
  return { ...actual, getActiveHarness: async () => mockActiveHarness() };
});

vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGetMany: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, ""])),
  // Every key in this fixture ANSWERED: `readHermesVoice` reports which of its
  // own reads did not, and an unread key is not an unset one.
  hermesConfigReadPending: () => false,
}));

vi.mock("@/lib/hermes-cli", () => ({
  runHermesCli: async () => ({ code: 0, stdout: "", stderr: "" }),
}));

vi.mock("@/lib/harness/credentials", () => ({
  resolveClawaiToken: async () => null,
  CLAWBOX_AI_PROXY_URL: "https://clawbox.test/api/ai",
}));

import { GET, POST } from "@/app/setup-api/tts/route";

function post(body: unknown) {
  return new Request("http://localhost/setup-api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/setup-api/tts on the hermes edition", () => {
  beforeEach(() => {
    mockOpenclawIsAbsent.mockReturnValue(true);
    mockActiveHarness.mockReturnValue("hermes");
  });

  it("answers a voice status, and says only the channel half is absent", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    // The whole feature is NOT absent: this box has engines, a language and a
    // voice like any other, and it speaks in its own chat.
    expect(body.supportedOnEdition).toBeUndefined();
    expect(Array.isArray(body.engines)).toBe(true);
    // The one thing that really does need a gateway.
    expect(body.channels.supportedOnEdition).toBe(false);
    expect(body.channels.error).toMatch(/channels/i);
  });

  it("accepts a language pick — it never touched a CLI in the first place", async () => {
    // This asserted a 409 before. The language is the sample sentence's
    // language, stored in ClawBox's own state file; refusing it was the
    // blanket POST guard, not a fact about the box.
    const res = await POST(post({ action: "language", language: "de" }));
    expect(res.status).toBe(200);
  });

  it("still refuses an unknown action rather than being swallowed by the edition", async () => {
    expect((await POST(post({ action: "nonsense" }))).status).toBe(400);
  });
});

describe("/setup-api/tts where openclaw is present", () => {
  beforeEach(() => {
    mockOpenclawIsAbsent.mockReturnValue(false);
    mockActiveHarness.mockReturnValue("openclaw");
  });

  it("reports channels as supported", async () => {
    const body = await (await GET()).json();
    expect(body.channels.supportedOnEdition).toBe(true);
  });

  it("still validates the action rather than short-circuiting", async () => {
    const res = await POST(post({ action: "nonsense" }));
    // 400, not 409: the edition gate must not swallow the ordinary contract.
    expect(res.status).toBe(400);
  });
});
