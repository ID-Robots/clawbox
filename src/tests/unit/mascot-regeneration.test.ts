// INV-6: the schedule around local generation — what is allowed to run, what
// is allowed to be persisted, and how a failure backs off.
//
// The generation transport itself is stubbed here; `mascot-generation-local.test.ts`
// covers the llama.cpp call. This suite is about everything wrapped around it.
//
// Note the locale: generation only runs for the locales in GENERATION_LOCALES
// (English), so the schedule tests below use "en". The wrong-language gates
// they used to exercise from here are unit-tested directly against
// `validateBatch` in `mascot-phrases.test.ts`.

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

// `hasMemoryHeadroom` reads /proc/meminfo AND /proc/<pid>/cmdline;
// `gatherContext` reads the OpenClaw workspace files. All go through
// fs/promises.
let memAvailableKb = 8 * 1024 * 1024;
// What `/proc/<pid>/cmdline` reports for the pid in the pid file: NUL-separated
// argv with a trailing NUL, exactly as the kernel serves it. Built with
// `fromCharCode` because a literal backslash-zero followed by a digit is a
// legacy octal escape, which an ES module rejects outright.
const NUL = String.fromCharCode(0);
const LLAMA_SERVER_CMDLINE = `/usr/local/bin/llama-server${NUL}--port${NUL}8080${NUL}`;
const OTHER_PROCESS_CMDLINE = `/usr/bin/python3${NUL}/home/clawbox/some-other-thing.py${NUL}`;
let pidCmdline: string | null = LLAMA_SERVER_CMDLINE;
vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(async (path: string) => {
      const target = String(path);
      if (target.includes("meminfo")) {
        return `MemTotal:       8000000 kB\nMemAvailable:   ${memAvailableKb} kB\n`;
      }
      if (target.includes("cmdline")) {
        if (pidCmdline === null) throw new Error("ENOENT");
        return pidCmdline;
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
const defaultGeneration = async (): Promise<Outcome> => nextOutcome;
const generateSpy = vi.fn<(args: GenerationArgs) => Promise<Outcome>>(defaultGeneration);

vi.mock("@/lib/mascot-generation-local", () => ({
  GENERATION_TIMEOUT_MS: 180_000,
  generatePhrasesLocally: (...args: unknown[]) => generateSpy(...(args as [GenerationArgs])),
}));

import { VALIDATOR_VERSION } from "@/lib/mascot-language";
import { en } from "@/lib/mascot-packs/en";

type Server = typeof import("@/lib/mascot-phrases-server");

const CACHE = (locale: string) => `clawbox-mascot-phrase-set:${locale}`;
const FAILURE = (locale: string) => `clawbox-mascot-phrase-failure:${locale}`;

/**
 * A batch big enough to clear MIN_SURVIVORS_PER_CATEGORY in four categories —
 * one more than MIN_SURVIVING_CATEGORIES, so the echo tests below can strip a
 * whole category and still have a persistable batch.
 *
 * Every line is deliberately absent from the English pack: a batch made of
 * pack lines is stripped to nothing before it is counted (see the echo tests).
 */
const BATCH = {
  sass: [
    "The build broke itself again.",
    "I filed a bug against you.",
    "Nice commit message. Truly.",
    "My claws demand overtime.",
  ],
  idle: ["*audits the dust*", "*rewrites nothing*", "*hums the changelog*", "*guards the socket*"],
  jump: ["*yeets self sideways*", "Airborne, briefly.", "🦀 up we go", "Watch this, no claws!"],
  power: ["⚡ CLAW SURGE!", "🔥 PINCH PROTOCOL!", "👑 SHELL SUPREMACY!", "💪 TIDE INCOMING!"],
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
    pidCmdline = LLAMA_SERVER_CMDLINE;
    nextOutcome = { status: "deferred", reason: "busy" };
    // `clearAllMocks` wipes calls, not implementations — a test that installs
    // its own would otherwise leak into every test after it.
    generateSpy.mockImplementation(defaultGeneration);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    server = await import("@/lib/mascot-phrases-server");
  });

  describe("locale allowlist", () => {
    it("only lists locales the on-device model can actually write", () => {
      expect([...server.GENERATION_LOCALES]).toEqual(["en"]);
      expect(server.isGenerationLocale("en")).toBe(true);
      expect(server.isGenerationLocale("de")).toBe(false);
    });

    it("never runs the model for a locale outside the allowlist", async () => {
      // The whole point: a 2B model asked for sarcastic Bulgarian either
      // answered in English or produced phrasing no native speaker would use,
      // and either way the batch was thrown away after 180 seconds of Jetson.
      for (const locale of ["bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"]) {
        nextOutcome = { status: "ok", phrases: BATCH };
        await server.maybeRegenerateInBackground(locale);
        expect(generateSpy, locale).not.toHaveBeenCalled();
        expect(store.has(CACHE(locale)), locale).toBe(false);
        // Not a failure either — nothing was attempted, so nothing may arm a
        // backoff that would then be reported as a fault.
        expect(store.has(FAILURE(locale)), locale).toBe(false);
      }

      // ...and the allowlisted locale still generates.
      nextOutcome = { status: "ok", phrases: BATCH };
      await server.maybeRegenerateInBackground("en");
      expect(generateSpy).toHaveBeenCalledTimes(1);
    });

    it("serves a disabled locale its pack, and says so in meta.reason", async () => {
      const { phrases, meta } = await server.getMascotPhrases("bg");

      expect(meta.source).toBe("pack");
      expect(meta.reason).toBe("generation-disabled-for-locale");
      expect(meta.locale).toBe("bg");
      // Still a complete, locale-correct set — the pack is the answer, not a
      // degraded fallback.
      expect(phrases.sass.length).toBeGreaterThan(0);
      expect(phrases.nameGreetings.length).toBeGreaterThan(0);
      expect(generateSpy).not.toHaveBeenCalled();
    });

    it("does not serve a stale non-English cache an older build left behind", async () => {
      // Written by a build that generated for every locale. `meta` would be
      // claiming source "local" for lines produced by exactly the path this
      // allowlist exists to stop trusting.
      store.set(CACHE("bg"), JSON.stringify({
        phrases: { sass: ["Стара реплика 1", "Стара реплика 2", "Стара реплика 3", "Стара реплика 4"] },
        locale: "bg",
        validatorVersion: VALIDATOR_VERSION,
        lastFullRegen: Date.now(),
        lastTopUp: Date.now(),
      }));
      store.set(FAILURE("bg"), JSON.stringify({ at: Date.now(), kind: "malformed" }));

      const { phrases, meta } = await server.getMascotPhrases("bg");

      expect(meta.source).toBe("pack");
      expect(meta.reason).toBe("generation-disabled-for-locale");
      expect(phrases.sass).not.toContain("Стара реплика 1");
      // Deleted, not merely skipped. Left on disk it is unreachable data no
      // code path can ever fix: the validator-version re-filter lives after
      // this early return, so it would sit at an old validator version for
      // good, and the failure record beside it could never be cleared.
      expect(store.has(CACHE("bg"))).toBe(false);
      expect(store.has(FAILURE("bg"))).toBe(false);
    });

    it("refuses a forced regen for a disabled locale without touching the model", async () => {
      nextOutcome = { status: "ok", phrases: BATCH };

      const result = await server.forceRegenerate("bg");

      expect(result.reason).toBe("generation-disabled-for-locale");
      expect(result.phrases).toBeNull();
      expect(result.locale).toBe("bg");
      expect(generateSpy).not.toHaveBeenCalled();
    });
  });

  describe("resource gates", () => {
    it("does not cold-load Gemma when there is not enough free RAM", async () => {
      // Gemma 4 E2B peaks near 3.8GB; below that the Jetson swaps itself to death.
      memAvailableKb = 2 * 1024 * 1024;

      await server.maybeRegenerateInBackground("en");

      expect(generateSpy).not.toHaveBeenCalled();
    });

    it("does not arm a backoff for memory pressure", async () => {
      // Memory pressure is transient and self-clearing — the model unloads
      // itself after ten idle minutes. Recording it as a failure armed a
      // TWELVE HOUR backoff.
      memAvailableKb = 2 * 1024 * 1024;

      await server.maybeRegenerateInBackground("en");

      expect(store.has(FAILURE("en"))).toBe(false);

      // ...and the moment the memory is back, it just works. No wait.
      memAvailableKb = 6 * 1024 * 1024;
      nextOutcome = { status: "ok", phrases: BATCH };
      await server.maybeRegenerateInBackground("en");
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
      nextOutcome = { status: "ok", phrases: BATCH };

      await server.maybeRegenerateInBackground("en");

      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(store.has(FAILURE("en"))).toBe(false);
    });

    it("does not trust a recycled pid to mean llama-server is resident", async () => {
      // The pid file outlives an unclean shutdown and Linux recycles pids, so
      // `kill(pid, 0)` succeeding proves only that SOMETHING owns that number.
      // Believing it granted the "server up == headroom" exemption and
      // cold-loaded ~3.8GB into a box with 400MB free — the exact swap spiral
      // the memory gate exists to prevent.
      llamaCppPid = 4242;
      pidCmdline = OTHER_PROCESS_CMDLINE;
      memAvailableKb = Math.round(3.4 * 1024 * 1024);
      nextOutcome = { status: "ok", phrases: BATCH };

      await server.maybeRegenerateInBackground("en");

      expect(generateSpy).not.toHaveBeenCalled();

      // With headroom measured honestly, the same pid is simply irrelevant.
      memAvailableKb = 6 * 1024 * 1024;
      await server.maybeRegenerateInBackground("en");
      expect(generateSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to measuring memory when /proc/<pid>/cmdline cannot be read", async () => {
      // Fail CLOSED: an unreadable cmdline (no /proc, another user's process,
      // a race with exit) must lose the exemption, not grant it.
      llamaCppPid = 4242;
      pidCmdline = null;
      memAvailableKb = Math.round(3.4 * 1024 * 1024);
      nextOutcome = { status: "ok", phrases: BATCH };

      await server.maybeRegenerateInBackground("en");

      expect(generateSpy).not.toHaveBeenCalled();
    });

    it("runs when there is headroom", async () => {
      memAvailableKb = 6 * 1024 * 1024;
      nextOutcome = { status: "ok", phrases: BATCH };

      await server.maybeRegenerateInBackground("en");

      expect(generateSpy).toHaveBeenCalledTimes(1);
    });

    it("does not run while the user's chat owns the local model", async () => {
      activeRequests = 1;
      await server.maybeRegenerateInBackground("en");
      expect(generateSpy).not.toHaveBeenCalled();
      // Not a failure — a busy box must not lose half a day of refreshes.
      expect(store.has(FAILURE("en"))).toBe(false);
    });

    it("treats a deferred generation as a no-op, not a failure", async () => {
      nextOutcome = { status: "deferred", reason: "busy" };
      await server.maybeRegenerateInBackground("en");
      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(store.has(FAILURE("en"))).toBe(false);
      expect(store.has(CACHE("en"))).toBe(false);
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

    it("refuses a batch too thin to be worth keeping", async () => {
      nextOutcome = { status: "ok", phrases: { sass: ["Only the one line"] } };

      await server.maybeRegenerateInBackground("en");

      expect(store.has(CACHE("en"))).toBe(false);
      expect(JSON.parse(store.get(FAILURE("en"))!).kind).toBe("malformed");
    });
  });

  describe("pack echoes (the 76% waste)", () => {
    it("does not count lines the pack already has towards the survivor gate", async () => {
      // The prompt hands the model the pack as a TONE REFERENCE and the model
      // copies it back. Those echoes used to clear MIN_SURVIVORS_PER_CATEGORY,
      // so a batch that added nothing was cached as a success — and then
      // deduped away again on the way to the bubble. 180 seconds of Jetson to
      // store lines we already had.
      nextOutcome = {
        status: "ok",
        phrases: {
          sass: en.sass.slice(0, 4),
          idle: en.idle.slice(0, 4),
          power: en.power.slice(0, 4),
        },
      };

      await server.maybeRegenerateInBackground("en");

      expect(generateSpy).toHaveBeenCalledTimes(1);
      // Nothing survived the strip, so there was nothing to persist.
      expect(store.has(CACHE("en"))).toBe(false);
    });

    it("caches only the new lines when a batch is part echo", async () => {
      nextOutcome = {
        status: "ok",
        phrases: {
          // Four new lines plus two straight copies of the pack.
          sass: [...BATCH.sass, en.sass[0], en.sass[1]],
          idle: BATCH.idle,
          jump: BATCH.jump,
          power: BATCH.power,
        },
      };

      await server.maybeRegenerateInBackground("en");

      const envelope = JSON.parse(store.get(CACHE("en"))!);
      expect(envelope.phrases.sass).toEqual(BATCH.sass);
      expect(envelope.phrases.sass).not.toContain(en.sass[0]);
    });

    it("keeps the batch shape the on-device model actually produces", async () => {
      // Measured on the reference box: roughly three quarters of every run is
      // a copy of the tone reference, leaving a handful of new lines spread
      // thinly across the categories. Demanding four NEW lines in each of
      // three categories made that run — the only run the hardware produces —
      // fail, so the Settings button had no reachable success path at all.
      // One new line in a category is a real addition; the pack tops the
      // category back up on the way to the bubble.
      nextOutcome = {
        status: "ok",
        phrases: {
          sass: [...en.sass.slice(0, 8), BATCH.sass[0]],
          idle: [...en.idle.slice(0, 8), BATCH.idle[0]],
          jump: [...en.jump.slice(0, 8), BATCH.jump[0], BATCH.jump[1]],
          power: en.power.slice(0, 8),
        },
      };

      await server.maybeRegenerateInBackground("en");

      const envelope = JSON.parse(store.get(CACHE("en"))!);
      expect(envelope.phrases.sass).toEqual([BATCH.sass[0]]);
      expect(envelope.phrases.jump).toEqual([BATCH.jump[0], BATCH.jump[1]]);
      // All echo, so it contributed nothing and is not in the envelope.
      expect(envelope.phrases.power).toBeUndefined();
      expect(store.has(FAILURE("en"))).toBe(false);
    });

    it("calls an all-echo run 'nothing new' rather than 'malformed'", async () => {
      // The model ran and answered correctly. Reporting that as junk sends the
      // owner looking for a broken install that is not there.
      nextOutcome = {
        status: "ok",
        phrases: { sass: en.sass.slice(0, 6), idle: en.idle.slice(0, 6), jump: en.jump.slice(0, 6) },
      };

      const result = await server.forceRegenerate("en");

      expect(result.reason).toBe("no-new-phrases");
      expect(store.has(CACHE("en"))).toBe(false);
      expect(JSON.parse(store.get(FAILURE("en"))!).kind).toBe("no-new-phrases");
    });

    it("does not count a line an earlier run already cached as new", async () => {
      // Top-up mode. Stripping against the pack alone left the cached lines
      // looking new, so a run that re-produced yesterday's output cleared the
      // gate and was written back as a fresh success.
      const day = 24 * 60 * 60 * 1000;
      store.set(CACHE("en"), JSON.stringify({
        phrases: BATCH,
        locale: "en",
        validatorVersion: VALIDATOR_VERSION,
        lastFullRegen: Date.now() - day, // recent enough that only a top-up is due
        lastTopUp: Date.now() - 2 * day,
      }));
      nextOutcome = { status: "ok", phrases: { sass: BATCH.sass, idle: BATCH.idle, jump: BATCH.jump } };

      await server.maybeRegenerateInBackground("en");

      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(store.get(FAILURE("en"))!).kind).toBe("no-new-phrases");
      // The envelope is untouched — including its timestamps, so the next
      // top-up is still due rather than pushed a day out by a no-op run.
      const envelope = JSON.parse(store.get(CACHE("en"))!);
      expect(envelope.lastTopUp).toBeLessThanOrEqual(Date.now() - 2 * day);
    });

    it("still counts a re-produced line as new when the whole set is being replaced", async () => {
      // The other side of the rule above. A FULL regen replaces the envelope,
      // so a line the model produced again is the only reason it survives at
      // all — striking it out for being in the envelope it is about to
      // overwrite would delete lines for being good enough to reproduce, and
      // would make a second press of the refresh button harder to pass than
      // the first.
      store.set(CACHE("en"), JSON.stringify({
        phrases: BATCH,
        locale: "en",
        validatorVersion: VALIDATOR_VERSION,
        lastFullRegen: 0, // ancient -> a FULL regen is due
        lastTopUp: 0,
      }));
      nextOutcome = { status: "ok", phrases: { sass: BATCH.sass, idle: BATCH.idle, jump: BATCH.jump } };

      await server.maybeRegenerateInBackground("en");

      const envelope = JSON.parse(store.get(CACHE("en"))!);
      expect(envelope.phrases.sass).toEqual(BATCH.sass);
      expect(store.has(FAILURE("en"))).toBe(false);
    });

    it("treats a case- and whitespace-only variation as an echo", async () => {
      // "Bug? Feature. 🫡" and "bug?  feature. 🫡" are the same line as far as
      // the crab's repertoire goes, and keeping both is exactly the padding
      // this gate exists to refuse.
      const loudEcho = en.sass.slice(0, 4).map((line) => line.toUpperCase().replace(/ /g, "  "));
      nextOutcome = {
        status: "ok",
        phrases: { sass: loudEcho, idle: BATCH.idle, jump: BATCH.jump, power: BATCH.power },
      };

      await server.maybeRegenerateInBackground("en");

      const envelope = JSON.parse(store.get(CACHE("en"))!);
      // sass was stripped to nothing, so it never reached the cache; the two
      // genuinely new categories did.
      expect(envelope.phrases.sass).toBeUndefined();
      expect(envelope.phrases.idle).toEqual(BATCH.idle);
    });
  });

  describe("persistence", () => {
    it("caches a good batch under the locale's own key and clears the backoff", async () => {
      store.set(FAILURE("en"), JSON.stringify({ at: Date.now() - 60_000, kind: "transport" }));
      // A backoff is in force, so nothing should run yet...
      await server.maybeRegenerateInBackground("en");
      expect(generateSpy).not.toHaveBeenCalled();

      // ...until it expires.
      store.set(FAILURE("en"), JSON.stringify({ at: Date.now() - 13 * 60 * 60 * 1000, kind: "transport" }));
      nextOutcome = { status: "ok", phrases: BATCH };

      await server.maybeRegenerateInBackground("en");

      const envelope = JSON.parse(store.get(CACHE("en"))!);
      expect(envelope.locale).toBe("en");
      expect(envelope.validatorVersion).toBe(VALIDATOR_VERSION);
      expect(envelope.phrases.sass).toEqual(BATCH.sass);
      // The first success clears the failure record.
      expect(store.has(FAILURE("en"))).toBe(false);
      // Nothing was written under any other locale's key.
      expect(store.has(CACHE("bg"))).toBe(false);
    });

    it("serves the cached batch back, merged over the pack", async () => {
      nextOutcome = { status: "ok", phrases: BATCH };
      await server.maybeRegenerateInBackground("en");

      const { phrases, meta } = await server.getMascotPhrases("en");
      expect(meta.source).toBe("local");
      expect(meta.locale).toBe("en");
      // Generated lines first, then the pack's — a full regen ADDS to the
      // repertoire rather than trading the hand-written lines away for it.
      expect(phrases.sass.slice(0, BATCH.sass.length)).toEqual(BATCH.sass);
      expect(phrases.sass.length).toBeGreaterThan(BATCH.sass.length);
      // A category generation did not supply is still complete, from the pack.
      expect(phrases.nameGreetings.length).toBeGreaterThan(0);
      for (const greeting of phrases.nameGreetings) {
        expect(greeting).toContain("{name}");
      }
    });

    it("records a transport failure and leaves the cache untouched", async () => {
      store.set(CACHE("en"), JSON.stringify({
        phrases: BATCH,
        locale: "en",
        validatorVersion: VALIDATOR_VERSION,
        lastFullRegen: 0, // ancient -> stale -> a full regen is due
        lastTopUp: 0,
      }));
      nextOutcome = { status: "failed", failure: "transport" };

      await server.maybeRegenerateInBackground("en");

      expect(JSON.parse(store.get(FAILURE("en"))!).kind).toBe("transport");
      // The old phrases survive a failed refresh.
      expect(JSON.parse(store.get(CACHE("en"))!).phrases.sass).toEqual(BATCH.sass);
    });

    it("still regenerates after an early return parked an in-flight entry", async () => {
      // Regression: every early return above (fresh cache, backoff, busy
      // model) happens without awaiting, so the run's `finally` used to
      // delete the in-flight map entry BEFORE it was inserted. The resolved
      // promise then sat in the map forever and every later call short-
      // circuited on it — background generation for that locale was dead
      // until the process restarted.
      activeRequests = 1;
      await server.maybeRegenerateInBackground("en"); // early return: busy
      expect(generateSpy).not.toHaveBeenCalled();

      activeRequests = 0;
      nextOutcome = { status: "ok", phrases: BATCH };
      await server.maybeRegenerateInBackground("en");

      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(store.has(CACHE("en"))).toBe(true);
    });

    it("does not regenerate a cache that is still fresh", async () => {
      const now = Date.now();
      store.set(CACHE("en"), JSON.stringify({
        phrases: BATCH,
        locale: "en",
        validatorVersion: VALIDATOR_VERSION,
        lastFullRegen: now,
        lastTopUp: now,
      }));

      await server.maybeRegenerateInBackground("en");

      expect(generateSpy).not.toHaveBeenCalled();
    });
  });

  describe("single-flight (one model, one run)", () => {
    it("never starts a second generation while one is running", async () => {
      // The box has one model and one ~180s run, so two entry points asked at
      // once — a background refresh and the Settings button, two tabs, N
      // crafted GETs — all read `activeRequests === 0`, all await the same
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
        return { status: "ok", phrases: BATCH };
      });

      // The background refresh claims the lock and parks inside generateSpy.
      const first = server.maybeRegenerateInBackground("en");
      await entered;
      expect(started).toEqual(["en"]);

      // A forced regen arriving while it holds the lock must not start...
      const refused = await server.forceRegenerate("en");
      expect(started).toEqual(["en"]);
      // ...and must say WHICH refusal it was. "Busy with your chat" here is a
      // plain untruth: no chat is involved, the crab is refreshing itself.
      expect(refused.reason).toBe("refresh-in-progress");

      release!();
      await first;

      // The lock is released with the run, so the next caller is free to go.
      generateSpy.mockImplementation(defaultGeneration);
      nextOutcome = { status: "ok", phrases: BATCH };
      await server.maybeRegenerateInBackground("en");
      expect(store.has(CACHE("en"))).toBe(true);
    });
  });

  describe("forceRegenerate", () => {
    it("tells the refusals apart, including the two that were both 'busy'", async () => {
      activeRequests = 1;
      // The user's own chat holds the model — this one really IS their chat.
      expect((await server.forceRegenerate("en")).reason).toBe("chat-busy");

      activeRequests = 0;
      memAvailableKb = 2 * 1024 * 1024;
      expect((await server.forceRegenerate("en")).reason).toBe("low-memory");

      memAvailableKb = 8 * 1024 * 1024;
      nextOutcome = { status: "failed", failure: "timeout" };
      expect((await server.forceRegenerate("en")).reason).toBe("timeout");

      nextOutcome = { status: "ok", phrases: { sass: ["Only the one"] } };
      expect((await server.forceRegenerate("en")).reason).toBe("malformed");

      nextOutcome = { status: "ok", phrases: BATCH };
      const ok = await server.forceRegenerate("en");
      expect(ok.reason).toBe("generated");
      expect(ok.phrases?.sass.slice(0, 4)).toEqual(BATCH.sass);
    });

    it("reports the generator deferring as the chat winning, not as a crab refresh", async () => {
      nextOutcome = { status: "deferred", reason: "busy" };
      expect((await server.forceRegenerate("en")).reason).toBe("chat-busy");
    });

    it("does not run two generations for the same locale asked for two ways", async () => {
      // `POST /regenerate` and `POST /regenerate?locale=en` name the same
      // locale on an English box. Keyed on the raw argument, "" and "en" were
      // two different entries and both ran a full generation at once.
      storedPreferences.set("pref:ui_language", "en");
      nextOutcome = { status: "ok", phrases: BATCH };

      const [a, b] = await Promise.all([
        server.forceRegenerate(null),
        server.forceRegenerate("en"),
      ]);

      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(a.locale).toBe("en");
      expect(b.locale).toBe("en");
    });
  });

  describe("prompt", () => {
    it("asks for the locale's own language and carries no cloud destination", async () => {
      nextOutcome = { status: "ok", phrases: BATCH };
      await server.maybeRegenerateInBackground("en");

      const [args] = generateSpy.mock.calls[0] as unknown as [{ prompt: string; locale: string }];
      expect(args.locale).toBe("en");
      expect(args.prompt).toContain("English");
      expect(args.prompt).toContain("{name}");
      // Nothing in the prompt path may reference a remote endpoint.
      expect(args.prompt).not.toMatch(/https?:\/\//);
    });
  });
});
