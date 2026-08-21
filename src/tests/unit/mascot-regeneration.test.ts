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

// Is llama-server already up? The memory gate depends on it: a resident model
// IS the headroom, because the run about to start reuses that same process.
let llamaCppPid: number | null = null;
vi.mock("@/lib/llamacpp-server", () => ({
  readLlamaCppPid: vi.fn(async () => llamaCppPid),
  isLlamaCppPidRunning: vi.fn((pid: number) => pid === llamaCppPid),
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

interface GenerationArgs { prompt: string; locale: string }

let nextOutcome: Outcome = { status: "deferred", reason: "busy" };
const defaultGeneration = async (_args: GenerationArgs): Promise<Outcome> => nextOutcome;
const generateSpy = vi.fn(defaultGeneration);

vi.mock("@/lib/mascot-generation-local", () => ({
  GENERATION_TIMEOUT_MS: 180_000,
  generatePhrasesLocally: (...args: unknown[]) => generateSpy(...(args as [GenerationArgs])),
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
    llamaCppPid = null;
    memAvailableKb = 8 * 1024 * 1024;
    nextOutcome = { status: "deferred", reason: "busy" };
    // `clearAllMocks` wipes calls, not implementations — a test that installs
    // its own would otherwise leak into every test after it.
    generateSpy.mockImplementation(defaultGeneration);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    server = await import("@/lib/mascot-phrases-server");
  });

  describe("resource gates", () => {
    it("does not cold-load Gemma when there is not enough free RAM", async () => {
      // Gemma 4 E2B peaks near 3.8GB; below that the Jetson swaps itself to death.
      memAvailableKb = 2 * 1024 * 1024;

      await server.maybeRegenerateInBackground("de");

      expect(generateSpy).not.toHaveBeenCalled();
    });

    it("does not arm a backoff for memory pressure", async () => {
      // Memory pressure is transient and self-clearing — the model unloads
      // itself after ten idle minutes. Recording it as a failure armed a
      // TWELVE HOUR backoff, and on a multi-locale box it fired for every
      // locale after the first: merely opening the UI in a second language
      // poisoned that language's generation for half a day.
      memAvailableKb = 2 * 1024 * 1024;

      await server.maybeRegenerateInBackground("de");

      expect(store.has(FAILURE("de"))).toBe(false);

      // ...and the moment the memory is back, it just works. No wait.
      memAvailableKb = 6 * 1024 * 1024;
      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };
      await server.maybeRegenerateInBackground("de");
      expect(generateSpy).toHaveBeenCalledTimes(1);
    });

    it("generates while llama-server is already resident, whatever MemAvailable says", async () => {
      // The measured bench state: Gemma loaded, MemAvailable ~3.4GB against a
      // 3.8GB gate. That gate exists to stop a COLD load; here the model is
      // already in RAM and this run reuses it, so there is nothing to protect
      // against. It was also the one window in which generating is nearly
      // free — and the only one the mascot used to refuse.
      llamaCppPid = 4242;
      memAvailableKb = Math.round(3.4 * 1024 * 1024);
      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };

      await server.maybeRegenerateInBackground("de");

      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(store.has(FAILURE("de"))).toBe(false);
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
      // Generated lines first, then the pack's — a full regen ADDS to the
      // repertoire rather than trading the hand-written lines away for it.
      expect(phrases.sass.slice(0, GERMAN_BATCH.sass.length)).toEqual(GERMAN_BATCH.sass);
      expect(phrases.sass.length).toBeGreaterThan(GERMAN_BATCH.sass.length);
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

  describe("single-flight (one model, one run)", () => {
    it("never starts a second generation while one is running, whatever the locale", async () => {
      // Per-locale in-flight maps only stop a locale racing ITSELF. The box
      // has one model and one ~180s run, so N locales asked for at once — a
      // user auditioning languages in Settings, two tabs, N crafted GETs —
      // all read `activeRequests === 0`, all await the same
      // `ensureLocalAiReady`, and all POST. llama-server serialises them and
      // the user's next chat turn queues behind N x 180s.
      let release: (() => void) | null = null;
      let signalEntered: (() => void) | null = null;
      const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
      const started: string[] = [];
      generateSpy.mockImplementation(async (args: GenerationArgs): Promise<Outcome> => {
        started.push(args.locale);
        signalEntered?.();
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: "ok", phrases: GERMAN_BATCH };
      });

      // "de" claims the lock and parks inside generateSpy.
      const first = server.maybeRegenerateInBackground("de");
      await entered;
      expect(started).toEqual(["de"]);

      // Two more locales, asked for while "de" holds the lock, must not start.
      await server.maybeRegenerateInBackground("es");
      await server.maybeRegenerateInBackground("fr");
      expect(started).toEqual(["de"]);

      release!();
      await first;

      // The lock is released with the run, so the next locale is free to go.
      generateSpy.mockImplementation(defaultGeneration);
      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };
      await server.maybeRegenerateInBackground("es");
      expect(store.has(CACHE("es"))).toBe(true);
    });
  });

  describe("forceRegenerate", () => {
    it("says WHY it could not run, so the three refusals are distinguishable", async () => {
      activeRequests = 1;
      expect((await server.forceRegenerate("de")).reason).toBe("busy");

      activeRequests = 0;
      memAvailableKb = 2 * 1024 * 1024;
      expect((await server.forceRegenerate("de")).reason).toBe("low-memory");

      memAvailableKb = 8 * 1024 * 1024;
      nextOutcome = { status: "failed", failure: "timeout" };
      expect((await server.forceRegenerate("de")).reason).toBe("timeout");

      nextOutcome = { status: "ok", phrases: { sass: ["Nur eine"] } };
      expect((await server.forceRegenerate("de")).reason).toBe("malformed");

      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };
      const ok = await server.forceRegenerate("de");
      expect(ok.reason).toBe("generated");
      expect(ok.phrases?.sass.slice(0, 4)).toEqual(GERMAN_BATCH.sass);
    });

    it("does not run two generations for the same locale asked for two ways", async () => {
      // `POST /regenerate` and `POST /regenerate?locale=en` name the same
      // locale on an English box. Keyed on the raw argument, "" and "en" were
      // two different entries and both ran a full generation at once.
      storedPreferences.set("pref:ui_language", "de");
      nextOutcome = { status: "ok", phrases: GERMAN_BATCH };

      const [a, b] = await Promise.all([
        server.forceRegenerate(null),
        server.forceRegenerate("de"),
      ]);

      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(a.locale).toBe("de");
      expect(b.locale).toBe("de");
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
