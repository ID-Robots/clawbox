// INV-5: the mascot route serves the locale the CLIENT asked for. On beta
// `GET()` took no arguments at all, so the `?locale=` the mascot has always
// sent was ignored and every box got whatever `pref:ui_language` said — which
// lags the UI by a fetch right after a language switch, and lags it forever
// on a box whose preference was never written.

import { describe, expect, it, vi, beforeEach } from "vitest";

const { getMascotPhrases, forceRegenerate } = vi.hoisted(() => ({
  getMascotPhrases: vi.fn(),
  forceRegenerate: vi.fn(),
}));
vi.mock("@/lib/mascot-phrases-server", () => ({ getMascotPhrases, forceRegenerate }));

import { GET } from "@/app/setup-api/mascot-lines/route";
import { POST } from "@/app/setup-api/mascot-lines/regenerate/route";

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
});

describe("POST /setup-api/mascot-lines/regenerate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives every refusal its own message instead of collapsing them", async () => {
    // These used to answer with the same "unavailable right now" text, so a
    // Settings button could not tell "your chat is using the model, try again
    // in a minute" apart from a real fault.
    const reasons = [
      "chat-busy",
      "refresh-in-progress",
      "generation-disabled-for-locale",
      "low-memory",
      "unavailable",
      "timeout",
      "transport",
      "malformed",
      "no-new-phrases",
    ] as const;
    const messages = new Set<string>();
    for (const reason of reasons) {
      forceRegenerate.mockResolvedValue({ phrases: null, reason, locale: "bg" });
      const body = await (await POST(request("?locale=bg"))).json();
      expect(body.ok, reason).toBe(false);
      expect(body.meta, reason).toEqual({ source: "pack", reason, locale: "bg" });
      expect(typeof body.reason, reason).toBe("string");
      messages.add(body.reason);
    }
    expect(messages.size).toBe(reasons.length);
  });

  it("does not blame the user's chat for a refresh the box started itself", async () => {
    // The misleading one: "the model is busy with your chat" was shown when
    // the page's OWN background refresh held the lock. No chat involved.
    forceRegenerate.mockResolvedValue({ phrases: null, reason: "refresh-in-progress", locale: "en" });
    const refresh = await (await POST(request("?locale=en"))).json();
    expect(refresh.reason).not.toMatch(/your chat/i);
    expect(refresh.reason).toMatch(/already running/i);

    forceRegenerate.mockResolvedValue({ phrases: null, reason: "chat-busy", locale: "en" });
    const chat = await (await POST(request("?locale=en"))).json();
    expect(chat.reason).toMatch(/your chat/i);
  });

  it("does not call a working model broken when it merely had nothing new", async () => {
    // The model ran and answered a well-formed batch; every line was one the
    // crab already had. Reporting that as junk sends the owner looking for a
    // broken install that is not there.
    forceRegenerate.mockResolvedValue({ phrases: null, reason: "no-new-phrases", locale: "en" });

    const body = await (await POST(request("?locale=en"))).json();

    expect(body.ok).toBe(false);
    expect(body.meta.reason).toBe("no-new-phrases");
    expect(body.reason).toMatch(/already knows/i);
    expect(body.reason).not.toMatch(/did not return usable/i);
  });

  it("explains that generation is English-only rather than reporting a fault", async () => {
    forceRegenerate.mockResolvedValue({
      phrases: null,
      reason: "generation-disabled-for-locale",
      locale: "bg",
    });

    const body = await (await POST(request("?locale=bg"))).json();

    expect(body.ok).toBe(false);
    expect(body.meta.reason).toBe("generation-disabled-for-locale");
    expect(body.reason).toMatch(/English/);
  });

  it("reports a successful regen as source 'local'", async () => {
    forceRegenerate.mockResolvedValue({ phrases: PHRASES, reason: "generated", locale: "bg" });

    const body = await (await POST(request("?locale=bg"))).json();

    expect(body.ok).toBe(true);
    expect(body.phrases).toEqual(PHRASES);
    expect(body.meta).toEqual({ source: "local", reason: "generated", locale: "bg" });
  });

  it("passes an unshipped locale through as null, like GET does", async () => {
    forceRegenerate.mockResolvedValue({ phrases: null, reason: "chat-busy", locale: "en" });
    await POST(request("?locale=pt"));
    expect(forceRegenerate).toHaveBeenCalledWith(null);
  });
});
