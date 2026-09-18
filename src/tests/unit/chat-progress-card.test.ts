import { describe, expect, it } from "vitest";
import {
  PROGRESS_CARD_COLLAPSED_KEY,
  PROGRESS_CARD_CHANGED_EVENT,
  PROGRESS_CARD_GET_METHOD,
  parseProgressCard,
  parseProgressCardChanged,
  parseProgressCardResponse,
  parseProgressSteps,
  progressCardAge,
  progressCardCounts,
  progressCardCurrentStep,
  progressCardEventMatches,
  progressCardScopeKey,
  readProgressCardCollapsed,
  writeProgressCardCollapsed,
} from "@/lib/chat-progress-card";

/**
 * The gateway's progress card as the chat reads it (TASK-896). The method and
 * event names and the card's shape are OpenClaw 2026.9.x's
 * (`packages/gateway-protocol/src/schema/progress-card.ts`); these tests pin
 * the parse the card is drawn from.
 */

const CARD = {
  sessionKey: "agent:main:main",
  revision: 4,
  updatedAt: 1_758_200_000_000,
  markdown: "Tests are running.",
  steps: [
    { step: "Inspect the failing route", status: "completed" },
    { step: "Repair the session owner", status: "in_progress" },
    { step: "Run focused verification", status: "pending" },
  ],
};

describe("the wire names", () => {
  it("are the gateway's own", () => {
    expect(PROGRESS_CARD_GET_METHOD).toBe("progressCard.get");
    expect(PROGRESS_CARD_CHANGED_EVENT).toBe("progressCard.changed");
  });
});

describe("parseProgressCard", () => {
  it("reads a full card", () => {
    expect(parseProgressCard(CARD)).toEqual({ ...CARD, steps: CARD.steps });
  });

  it("reads the card out of a progressCard.get answer", () => {
    expect(parseProgressCardResponse({ card: CARD })?.revision).toBe(4);
    expect(parseProgressCardResponse({ card: null })).toBeNull();
    expect(parseProgressCardResponse(null)).toBeNull();
    expect(parseProgressCardResponse("nope")).toBeNull();
  });

  it("is null for a card with both parts empty — the documented clear", () => {
    expect(parseProgressCard({ ...CARD, markdown: "", steps: [] })).toBeNull();
    expect(parseProgressCard({ ...CARD, markdown: "   \n ", steps: undefined })).toBeNull();
    expect(parseProgressCard({ sessionKey: "agent:main:main", revision: 2, updatedAt: 1 })).toBeNull();
  });

  it("keeps a card that has only a note or only a plan", () => {
    expect(parseProgressCard({ ...CARD, steps: undefined })?.steps).toEqual([]);
    expect(parseProgressCard({ ...CARD, markdown: undefined })?.markdown).toBe("");
  });

  it("does not trust the numbers it is sent", () => {
    const card = parseProgressCard({ ...CARD, revision: "4", updatedAt: Number.NaN });
    expect(card?.revision).toBe(0);
    expect(card?.updatedAt).toBeNull();
  });

  it("is null for anything that is not an object", () => {
    for (const value of [null, undefined, 3, "card", [CARD]]) expect(parseProgressCard(value)).toBeNull();
  });
});

describe("parseProgressSteps", () => {
  it("drops entries without text or with an unknown status", () => {
    expect(parseProgressSteps([
      { step: "ok", status: "pending" },
      { step: "", status: "pending" },
      { step: "   ", status: "completed" },
      { step: "bad", status: "failed" },
      { step: 7, status: "pending" },
      null,
      "text",
    ])).toEqual([{ step: "ok", status: "pending" }]);
  });

  it("keeps at most one step in progress — the first — and reads later ones as pending", () => {
    expect(parseProgressSteps([
      { step: "a", status: "in_progress" },
      { step: "b", status: "in_progress" },
      { step: "c", status: "completed" },
    ]).map((s) => s.status)).toEqual(["in_progress", "pending", "completed"]);
  });

  it("stops at the gateway's 50 steps and 512 characters a step", () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ step: `s${i}`, status: "pending" }));
    expect(parseProgressSteps(many)).toHaveLength(50);
    expect(parseProgressSteps([{ step: "x".repeat(900), status: "pending" }])[0].step).toHaveLength(512);
  });

  it("removes invisible and bidi characters and folds whitespace", () => {
    expect(parseProgressSteps([{ step: " Run\u202E the\u200B tests \n now ", status: "pending" }])[0].step).toBe("Run the tests now");
  });
});

describe("parseProgressCardChanged", () => {
  it("reads the event payload, revision or null", () => {
    expect(parseProgressCardChanged({ sessionKey: "agent:main:main", revision: 5 })).toEqual({ sessionKey: "agent:main:main", revision: 5 });
    expect(parseProgressCardChanged({ sessionKey: "agent:main:main", revision: null })).toEqual({ sessionKey: "agent:main:main", revision: null });
  });

  it("is null without a session key", () => {
    expect(parseProgressCardChanged({ revision: 3 })).toBeNull();
    expect(parseProgressCardChanged({ sessionKey: "  ", revision: 3 })).toBeNull();
    expect(parseProgressCardChanged(null)).toBeNull();
  });
});

describe("which session an event is about", () => {
  it("qualifies a bare key with its agent, as the gateway's display key does", () => {
    expect(progressCardScopeKey("main")).toBe("agent:main:main");
    expect(progressCardScopeKey("global", "research")).toBe("agent:research:global");
    expect(progressCardScopeKey("agent:main:abc")).toBe("agent:main:abc");
  });

  it("matches the chat's own agent-qualified key", () => {
    expect(progressCardEventMatches("agent:main:main", "agent:main:main")).toBe(true);
    expect(progressCardEventMatches("agent:main:tab-2", "agent:main:main")).toBe(false);
    expect(progressCardEventMatches("agent:ops:main", "agent:main:main")).toBe(false);
  });

  it("matches a bare key against the qualified key the event carries", () => {
    expect(progressCardEventMatches("agent:main:main", "main")).toBe(true);
    expect(progressCardEventMatches("agent:ops:main", "main")).toBe(true);
    expect(progressCardEventMatches("agent:main:other", "main")).toBe(false);
  });

  it("prefers the key the gateway returned with the card", () => {
    expect(progressCardEventMatches("agent:ops:main", "main", "agent:ops:main")).toBe(true);
    expect(progressCardEventMatches("AGENT:MAIN:MAIN", "agent:main:main")).toBe(true);
  });

  it("never matches an empty key", () => {
    expect(progressCardEventMatches("", "agent:main:main")).toBe(false);
    expect(progressCardEventMatches("agent:main:main", "")).toBe(false);
  });
});

describe("the header's facts", () => {
  it("names the step in progress, else the next one pending, else nothing", () => {
    const card = parseProgressCard(CARD)!;
    expect(progressCardCurrentStep(card)?.step).toBe("Repair the session owner");
    expect(progressCardCurrentStep({ steps: [{ step: "a", status: "completed" }, { step: "b", status: "pending" }] })?.step).toBe("b");
    expect(progressCardCurrentStep({ steps: [{ step: "a", status: "completed" }] })).toBeNull();
  });

  it("counts done over total", () => {
    expect(progressCardCounts(parseProgressCard(CARD)!)).toEqual({ done: 1, total: 3 });
    expect(progressCardCounts({ steps: [] })).toEqual({ done: 0, total: 0 });
  });

  it("says how long ago the card was written, in one unit", () => {
    const at = 1_000_000_000_000;
    expect(progressCardAge(at, at + 20_000)).toEqual({ unit: "now", n: 0 });
    expect(progressCardAge(at, at + 5 * 60_000)).toEqual({ unit: "minutes", n: 5 });
    expect(progressCardAge(at, at + 2 * 3_600_000 + 59_000)).toEqual({ unit: "hours", n: 2 });
    expect(progressCardAge(at, at + 3 * 86_400_000)).toEqual({ unit: "days", n: 3 });
    // The browser's clock behind the box's: not a negative age.
    expect(progressCardAge(at + 90_000, at)).toEqual({ unit: "now", n: 0 });
    expect(progressCardAge(null, at)).toBeNull();
  });
});

describe("the fold survives a reload", () => {
  function memoryStorage() {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      store,
    };
  }

  it("round-trips through storage under its own key", () => {
    const storage = memoryStorage();
    expect(readProgressCardCollapsed(storage)).toBe(false);
    writeProgressCardCollapsed(true, storage);
    expect(storage.store.get(PROGRESS_CARD_COLLAPSED_KEY)).toBe("1");
    expect(readProgressCardCollapsed(storage)).toBe(true);
    writeProgressCardCollapsed(false, storage);
    expect(readProgressCardCollapsed(storage)).toBe(false);
  });

  it("reads as open when storage is missing or throws", () => {
    expect(readProgressCardCollapsed(null)).toBe(false);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
    expect(readProgressCardCollapsed(throwing)).toBe(false);
    expect(() => writeProgressCardCollapsed(true, throwing)).not.toThrow();
  });
});
