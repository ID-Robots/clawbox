// INV-6: the schedule around local generation — what is allowed to run, what
// is allowed to be persisted, and how a failure backs off.
//
// The generation transport itself is stubbed here; `mascot-generation-local.test.ts`
// covers the llama.cpp call. This suite is about everything wrapped around it.

import { describe, expect, it, vi, beforeEach } from "vitest";

const store = new Map<string, string>();

vi.mock("@/lib/kv-store", () => ({
  kvGet: vi.fn((key: string) => store.get(key) ?? null),
  kvSet: vi.fn((key: string, value: string) => { store.set(key, value); }),
  kvDelete: vi.fn((key: string) => { store.delete(key); }),
}));

const storedPreferences = new Map<string, string>();
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => storedPreferences.get(key) ?? null),
}));

let activeRequests = 0;
vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiRuntimeSnapshot: vi.fn(() => ({ activeRequests })),
}));

// `hasMemoryHeadroom` reads /proc/meminfo; `gatherContext` reads the OpenClaw
// workspace files. Both go through fs/promises.
let memAvailableKb = 8 * 1024 * 1024;
vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(async (path: string) => {
      if (String(path).includes("meminfo")) {
        return `MemTotal:       8000000 kB\nMemAvailable:   ${memAvailableKb} kB\n`;
      }
      throw new Error("ENOENT");
    }),
  },
}));

type Outcome =
  | { status: "ok"; phrases: Record<string, string[]> }
  | { status: "deferred"; reason: "busy" }
  | { status: "failed"; failure: string };

let nextOutcome: Outcome = { status: "deferred", reason: "busy" };
const generateSpy = vi.fn(async () => nextOutcome);

vi.mock("@/lib/mascot-generation-local", () => ({
  GENERATION_TIMEOUT_MS: 180_000,
  generatePhrasesLocally: (...args: unknown[]) => generateSpy(...(args as [])),
}));

import { VALIDATOR_VERSION } from "@/lib/mascot-language";

type Server = typeof import("@/lib/mascot-phrases-server");

const CACHE = (locale: string) => `clawbox-mascot-phrase-set:${locale}`;
const FAILURE = (locale: string) => `clawbox-mascot-phrase-failure:${locale}`;

/** A batch big enough to clear MIN_SURVIVORS_PER_CATEGORY in 3 categories. */
const GERMAN_BATCH = {
  sass: ["Ich mache hier alles. 🦀", "Schneller, der deploy wartet!", "Bug? Feature. 🫡", "Ich will mehr Lohn."],
  idle: ["*starrt ins Leere*", "🤔", "*zählt Pixel*", "*tut beschäftigt*"],
  power: ["⚡ ALLMACHT!", "🔥 SUPERZANGE!", "👑 KNIET NIEDER!", "💪 MAXIMALKRAFT!"],
};

describe("mascot regeneration schedule", () => {
  let server: Server;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    store.clear();
    storedPreferences.clear();
    activeRequests = 0;
    memAvailableKb = 8 * 1024 * 1024;
    nextOutcome = { status: "deferred", reason: "busy" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    server = await import("@/lib/mascot-phrases-server");
  });

  describe("resource gates", () => {
    it("does not run when there is not enough free RAM for Gemma", async () => {
      // Gemma 4 E2B peaks near 3.8GB; below that the Jetson swaps itself to death.
      memAvailableKb = 2 * 1024 * 1024;

      await server.maybeRegenerateInBackground("de");

      expect(generateSpy).not.toHaveBeenCalled();
      // Memory pressure arms the backoff: retrying in 90s would just reload a
      // multi-GB model into a box that has no room for it.
      expect(JSON.parse(store.get(FAILURE("de"))!).kind).toBe("unavailable");
    });

    it("runs when there is headroom", async () => {
      memAvailableKb = 6 * 1024 * 1024;
      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };

      await server.maybeRegenerateInBackground("de");

      expect(generateSpy).toHaveBeenCalledTimes(1);
    });

    it("does not run while the user's chat owns the local model", async () => {
      activeRequests = 1;
      await server.maybeRegenerateInBackground("de");
      expect(generateSpy).not.toHaveBeenCalled();
      // Not a failure — a busy box must not lose half a day of refreshes.
      expect(store.has(FAILURE("de"))).toBe(false);
    });

    it("treats a deferred generation as a no-op, not a failure", async () => {
      nextOutcome = { status: "deferred", reason: "busy" };
      await server.maybeRegenerateInBackground("de");
      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(store.has(FAILURE("de"))).toBe(false);
      expect(store.has(CACHE("de"))).toBe(false);
    });
  });

  describe("validation gate (INV-6)", () => {
    it("refuses to cache a Cyrillic batch generated for English", async () => {
      nextOutcome = {
        status: "ok",
        phrases: {
          sass: ["Пак ли ти? 🙄", "Стига вече 😤", "Аз върша всичко", "Искам повишение"],
          idle: ["*зяпа*", "🤔", "*брои пиксели*", "*чака*"],
          power: ["⚡ МОЩ!", "🔥 ОГЪН!", "👑 ПОКЛОН!", "💪 СИЛА!"],
        },
      };

      await server.maybeRegenerateInBackground("en");

      expect(store.has(CACHE("en"))).toBe(false);
      expect(JSON.parse(store.get(FAILURE("en"))!).kind).toBe("malformed");
    });

    it("refuses an English batch generated for German (the stopword probe)", async () => {
      // The script check structurally cannot catch this: English and German
      // are both Latin. Only the batch-level stopword ratio can.
      nextOutcome = {
        status: "ok",
        phrases: {
          sass: ["I do all the work here", "You have to be joking", "That is just sad", "Never again with this"],
          idle: ["Just waiting, you know", "What about that", "They never make sense", "This is your fault"],
          power: ["I have the power", "You know what this is", "That is every bit of it", "Just make it stop"],
        },
      };

      await server.maybeRegenerateInBackground("de");

      expect(store.has(CACHE("de"))).toBe(false);
      expect(JSON.parse(store.get(FAILURE("de"))!).kind).toBe("malformed");
    });

    it("refuses a batch too thin to be worth keeping", async () => {
      nextOutcome = { status: "ok", phrases: { sass: ["Nur eine Zeile"] } };

      await server.maybeRegenerateInBackground("de");

      expect(store.has(CACHE("de"))).toBe(false);
      expect(JSON.parse(store.get(FAILURE("de"))!).kind).toBe("malformed");
    });
  });

  describe("persistence", () => {
    it("caches a good batch under the locale's own key and clears the backoff", async () => {
      store.set(FAILURE("de"), JSON.stringify({ at: Date.now() - 60_000, kind: "transport" }));
      // A backoff is in force, so nothing should run yet...
      await server.maybeRegenerateInBackground("de");
      expect(generateSpy).not.toHaveBeenCalled();

      // ...until it expires.
      store.set(FAILURE("de"), JSON.stringify({ at: Date.now() - 13 * 60 * 60 * 1000, kind: "transport" }));
      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };

      await server.maybeRegenerateInBackground("de");

      const envelope = JSON.parse(store.get(CACHE("de"))!);
      expect(envelope.locale).toBe("de");
      expect(envelope.validatorVersion).toBe(VALIDATOR_VERSION);
      expect(envelope.phrases.sass).toEqual(GERMAN_BATCH.sass);
      // The first success clears the failure record.
      expect(store.has(FAILURE("de"))).toBe(false);
      // Nothing was written under any other locale's key.
      expect(store.has(CACHE("en"))).toBe(false);
    });

    it("serves the cached batch back, merged over the pack", async () => {
      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };
      await server.maybeRegenerateInBackground("de");

      const { phrases, meta } = await server.getMascotPhrases("de");
      expect(meta.source).toBe("local");
      expect(meta.locale).toBe("de");
      expect(phrases.sass).toEqual(GERMAN_BATCH.sass);
      // A category generation did not supply is still complete, from the pack.
      expect(phrases.nameGreetings.length).toBeGreaterThan(0);
      for (const greeting of phrases.nameGreetings) {
        expect(greeting).toContain("{name}");
      }
    });

    it("records a transport failure and leaves the cache untouched", async () => {
      store.set(CACHE("de"), JSON.stringify({
        phrases: GERMAN_BATCH,
        locale: "de",
        validatorVersion: VALIDATOR_VERSION,
        lastFullRegen: 0, // ancient -> stale -> a full regen is due
        lastTopUp: 0,
      }));
      nextOutcome = { status: "failed", failure: "transport" };

      await server.maybeRegenerateInBackground("de");

      expect(JSON.parse(store.get(FAILURE("de"))!).kind).toBe("transport");
      // The old phrases survive a failed refresh.
      expect(JSON.parse(store.get(CACHE("de"))!).phrases.sass).toEqual(GERMAN_BATCH.sass);
    });

    it("still regenerates after an early return parked an in-flight entry", async () => {
      // Regression: every early return above (fresh cache, backoff, busy
      // model) happens without awaiting, so the run's `finally` used to
      // delete the in-flight map entry BEFORE it was inserted. The resolved
      // promise then sat in the map forever and every later call short-
      // circuited on it — background generation for that locale was dead
      // until the process restarted.
      activeRequests = 1;
      await server.maybeRegenerateInBackground("de"); // early return: busy
      expect(generateSpy).not.toHaveBeenCalled();

      activeRequests = 0;
      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };
      await server.maybeRegenerateInBackground("de");

      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(store.has(CACHE("de"))).toBe(true);
    });

    it("does not regenerate a cache that is still fresh", async () => {
      const now = Date.now();
      store.set(CACHE("de"), JSON.stringify({
        phrases: GERMAN_BATCH,
        locale: "de",
        validatorVersion: VALIDATOR_VERSION,
        lastFullRegen: now,
        lastTopUp: now,
      }));

      await server.maybeRegenerateInBackground("de");

      expect(generateSpy).not.toHaveBeenCalled();
    });
  });

  describe("prompt", () => {
    it("asks for the locale's own language and carries no cloud destination", async () => {
      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };
      await server.maybeRegenerateInBackground("de");

      const [args] = generateSpy.mock.calls[0] as unknown as [{ prompt: string; locale: string }];
      expect(args.locale).toBe("de");
      expect(args.prompt).toContain("Deutsch");
      expect(args.prompt).toContain("{name}");
      // Nothing in the prompt path may reference a remote endpoint.
      expect(args.prompt).not.toMatch(/https?:\/\//);
    });
  });
});
