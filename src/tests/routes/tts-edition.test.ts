import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /setup-api/tts is entirely openclaw-CLI work: `capability tts convert` for a
 * check, `config set messages.tts.provider` for a selection. On the Hermes
 * edition that binary does not exist, so the route must refuse up front rather
 * than spawn nothing for two minutes and report a blank reason.
 */

const mockOpenclawIsAbsent = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => mockOpenclawIsAbsent(),
  readConfig: async () => ({}),
  runOpenclawConfigSet: async () => {},
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
  });

  it("reports the feature as absent rather than a voice status", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    // A distinct fact, not an empty engine list: "no voice is installed" invites
    // the customer to install one, and on this SKU there is nothing to install.
    expect(body.supportedOnEdition).toBe(false);
    expect(body.engines).toBeUndefined();
  });

  it("refuses a check instead of spawning a binary that is not there", async () => {
    const res = await POST(post({ action: "check" }));
    expect(res.status).toBe(409);
    expect((await res.json()).supportedOnEdition).toBe(false);
  });

  it("refuses a selection with the same reason the panel already shows", async () => {
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not part of this edition/i);
  });
});

describe("/setup-api/tts where openclaw is present", () => {
  it("still validates the action rather than short-circuiting", async () => {
    mockOpenclawIsAbsent.mockReturnValue(false);
    const res = await POST(post({ action: "nonsense" }));
    // 400, not 409: the edition gate must not swallow the ordinary contract.
    expect(res.status).toBe(400);
  });
});
