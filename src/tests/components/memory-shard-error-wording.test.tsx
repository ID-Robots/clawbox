import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import MemoryShardApp from "@/components/MemoryShardApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * The Memory Shard banner in the owner's language.
 *
 * `/setup-api/clawkeep/memory` answers English sentences — "The index does not
 * match the configured embedding model. Run a full reindex." — and carried no
 * code beside them, so a German desktop printed them as they came. Every other
 * ClawBox route sends a stable `code` for exactly this; the panel now words the
 * code and keeps the server's English as the floor.
 *
 * The locale pack is stubbed here rather than in the main app suite, whose
 * assertions are written against the real English copy: this file needs a pack
 * where the key EXISTS in order to prove the panel looks it up at all.
 *
 * The keys are the CAMEL forms of the route's snake_case codes. A translation
 * key may only carry alphanumeric segments (`translations.test.ts` enforces
 * it), so `clawkeep.memory.error.index_identity_mismatched` is a key no locale
 * file could ever hold; the panel camel-cases the code before it builds the
 * key, and a stub spelled the other way would only prove a lookup that always
 * misses.
 */
vi.mock("@/lib/translations", () => ({
  translations: {
    en: {
      "clawkeep.memory.title": "Memory index",
      "clawkeep.memory.error.indexIdentityMismatched": "Der Index passt nicht zum Einbettungsmodell.",
      "clawkeep.memory.runError.migrationBusy": "Das Einbettungsmodell wird noch eingerichtet.",
    },
  },
}));

const STATUS = {
  available: true,
  provider: "openai-compatible",
  model: "qwen3-embedding-0.6b",
  location: "local",
  health: "degraded",
  semanticAvailable: true,
  indexIdentity: "mismatched",
  fingerprint: "c53cd968febb",
  sourceCount: 2,
  files: 18,
  chunks: 165,
  vectors: 165,
  pendingFiles: 4,
  failedItems: 0,
  dirty: true,
  indexBytes: 34_193_408,
  error: "The index does not match the configured embedding model. Run a full reindex.",
  errorCode: "index_identity_mismatched",
  run: {
    status: "failed",
    mode: "full",
    trigger: "manual",
    startedAtMs: Date.now() - 61_263,
    finishedAtMs: Date.now() - 60_000,
    durationMs: 1_263,
    error: "The embedding model is still being set up. Try again in a few minutes.",
    errorCode: "migration_busy",
  },
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 },
  nextRunAtMs: 0,
  enabled: true,
  setupComplete: true,
};

let memory: Record<string, unknown> = { ...STATUS };

beforeEach(() => {
  memory = { ...STATUS };
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => ({
    ok: true,
    status: 200,
    json: async () => (String(input).includes("/setup-api/clawkeep/memory") ? memory : {}),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const mount = () => render(<I18nProvider><MemoryShardApp /></I18nProvider>);

describe("the Memory Shard banner and run line in the owner's language", () => {
  it("words the status code from the locale pack instead of printing the server's English", async () => {
    mount();
    expect(await screen.findByText("Der Index passt nicht zum Einbettungsmodell.", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/does not match the configured embedding model/)).toBeNull();
  });

  it("words a failed run's code too", async () => {
    mount();
    const line = await screen.findByText(/Das Einbettungsmodell wird noch eingerichtet\./, {}, { timeout: 5000 });
    expect(line.textContent).not.toContain("Try again in a few minutes");
  });

  it("falls back to the server's English rather than leaking the key, for a code the pack has no words for", async () => {
    // The floor. A pack that has not caught up must never put
    // "clawkeep.memory.error.provider_degraded" on a customer's screen.
    memory = {
      ...STATUS,
      indexIdentity: "valid",
      error: "The embedding model is not ready. Check the model, then try indexing again.",
      errorCode: "provider_degraded",
      run: { ...STATUS.run, status: "idle", error: "", errorCode: "" },
    };
    mount();
    const banner = await screen.findByTestId("memory-shard-status-error", {}, { timeout: 5000 });
    expect(banner.textContent).toBe("The embedding model is not ready. Check the model, then try indexing again.");
    expect(banner.textContent).not.toContain("clawkeep.memory.error");
  });

  it("still shows the English sentence a server that predates the codes sends", async () => {
    memory = {
      ...STATUS,
      errorCode: undefined,
      run: { ...STATUS.run, errorCode: undefined },
    };
    mount();
    const banner = await screen.findByTestId("memory-shard-status-error", {}, { timeout: 5000 });
    expect(banner.textContent).toContain("does not match the configured embedding model");
  });
});
