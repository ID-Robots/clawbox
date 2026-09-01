// INV-5: the mascot route serves the locale the CLIENT asked for. On beta
// `GET()` took no arguments at all, so the `?locale=` the mascot has always
// sent was ignored and every box got whatever `pref:ui_language` said — which
// lags the UI by a fetch right after a language switch, and lags it forever
// on a box whose preference was never written.

import { describe, expect, it, vi, beforeEach } from "vitest";

const { getMascotPhrases, forceRegenerate, hasHermesHarness, isPetActive } = vi.hoisted(() => ({
  getMascotPhrases: vi.fn(),
  forceRegenerate: vi.fn(),
  hasHermesHarness: vi.fn(),
  isPetActive: vi.fn(),
}));
vi.mock("@/lib/mascot-phrases-server", () => ({ getMascotPhrases, forceRegenerate }));
vi.mock("@/lib/edition-source", () => ({ hasHermesHarness }));
vi.mock("@/lib/hermes-pets", () => ({ isPetActive }));

import { GET } from "@/app/setup-api/mascot-lines/route";

const PHRASES = { sass: ["a"], idle: ["b"], sleep: ["c"], jump: ["d"], dance: ["e"], facepalm: ["f"], nameGreetings: ["{name}"], nameFallbacks: ["boss"], power: ["g"] };

function request(query = ""): Request {
  return new Request(`http://127.0.0.1/setup-api/mascot-lines${query}`);
}

describe("GET /setup-api/mascot-lines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMascotPhrases.mockResolvedValue({
      phrases: PHRASES,
      meta: { source: "pack", reason: "no-cache", locale: "en", validatorVersion: 1, lastFullRegen: null, lastTopUp: null },
    });
    hasHermesHarness.mockReturnValue(false);
    isPetActive.mockResolvedValue(false);
  });

  it("honours ?locale when it names a locale the device ships", async () => {
    await GET(request("?locale=bg"));
    expect(getMascotPhrases).toHaveBeenCalledWith("bg");
  });

  it("ignores a locale the device does not ship", async () => {
    for (const query of ["?locale=pt", "?locale=", "?locale=de%0A%23%23%20Override", "?locale=EN"]) {
      getMascotPhrases.mockClear();
      await GET(request(query));
      expect(getMascotPhrases, query).toHaveBeenCalledWith(null);
    }
  });

  it("falls back to the server-side resolution when no locale is given", async () => {
    await GET(request());
    expect(getMascotPhrases).toHaveBeenCalledWith(null);
  });

  it("returns the phrase set and the cache metadata", async () => {
    const res = await GET(request("?locale=en"));
    const body = await res.json();
    expect(body.phrases).toEqual(PHRASES);
    expect(body.meta).toMatchObject({ source: "pack", locale: "en" });
  });

  it("no longer returns the chat snippets the crab used to quote back", async () => {
    const body = await (await GET(request())).json();
    expect(body).not.toHaveProperty("lines");
    expect(body).not.toHaveProperty("date");
  });

  // ── Whose voice is this? ──
  //
  // The response IS the mascot's vocabulary for the whole session — a bubble
  // is picked from it minutes after the fetch — so the crab/pet decision has
  // to be made here and not left to the render.
  describe("the pet's voice", () => {
    const CRABBY = {
      ...PHRASES,
      sass: ["My claws are unionised.", "Ship faster, humans."],
      dance: ["🦀 shuffle time", "♪ dun dun dun ♪"],
      jump: ["Hops undefeated 🦀"],
    };

    it("serves the crab every crab-literal line it has", async () => {
      getMascotPhrases.mockResolvedValue({
        phrases: CRABBY,
        meta: { source: "pack", reason: "no-cache", locale: "en", validatorVersion: 1, lastFullRegen: null, lastTopUp: null },
      });
      const body = await (await GET(request("?locale=en"))).json();
      expect(body.phrases).toEqual(CRABBY);
      expect(body.meta.voice).toBe("crab");
    });

    it("serves a pet none of them, in any category", async () => {
      hasHermesHarness.mockReturnValue(true);
      isPetActive.mockResolvedValue(true);
      getMascotPhrases.mockResolvedValue({
        phrases: CRABBY,
        meta: { source: "pack", reason: "no-cache", locale: "en", validatorVersion: 1, lastFullRegen: null, lastTopUp: null },
      });
      const body = await (await GET(request("?locale=en"))).json();
      expect(body.meta.voice).toBe("pet");
      const all = Object.values(body.phrases as Record<string, string[]>).flat();
      expect(all.filter((line) => /🦀/u.test(line) || /claw|crab/i.test(line))).toEqual([]);
      // and it did not go mute doing it
      expect(body.phrases.sass).toContain("Ship faster, humans.");
      for (const category of Object.keys(CRABBY)) {
        expect(body.phrases[category].length, category).toBeGreaterThan(0);
      }
    });

    it("does not touch the Hermes config on an OpenClaw box", async () => {
      hasHermesHarness.mockReturnValue(false);
      await GET(request("?locale=en"));
      expect(isPetActive).not.toHaveBeenCalled();
    });
  });
});
