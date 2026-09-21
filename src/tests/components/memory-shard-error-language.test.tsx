import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import MemoryShardApp from "@/components/MemoryShardApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * The sweep found the Memory Shard window showing the server's English inside
 * a German UI: "The index does not match the configured embedding model. Run a
 * full reindex." above the amber banner, and "Letzter Lauf: Indexing failed…"
 * on the run line. The route already sends a stable `errorCode` beside the
 * English; nothing was worded from it.
 *
 * The catch is that the codes are snake_case (`index_identity_mismatched`) and
 * a translation key may only carry alphanumeric segments, so the component
 * camel-cases the code before it builds the key. Pasting the code in raw
 * produces `clawkeep.memory.error.index_identity_mismatched`, which no locale
 * can hold — the English floor renders and the defect survives the fix.
 */

const STATUS = {
  available: true,
  provider: "openai-compatible",
  model: "qwen3-embedding",
  location: "local",
  health: "degraded",
  semanticAvailable: true,
  indexIdentity: "mismatched",
  fingerprint: "a1b2c3d4e5f6",
  sourceCount: 2,
  files: 41,
  chunks: 318,
  vectors: 318,
  pendingFiles: 0,
  failedItems: 0,
  dirty: false,
  indexBytes: 4_194_304,
  error: "The index does not match the configured embedding model. Run a full reindex.",
  errorCode: "index_identity_mismatched",
  run: {
    status: "failed",
    mode: "incremental",
    trigger: "manual",
    startedAtMs: 1,
    finishedAtMs: 2,
    durationMs: 1,
    error: "Indexing failed. Check that the embedding model is available, then try again.",
    errorCode: "index_failed",
  },
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 },
  nextRunAtMs: 0,
  enabled: true,
  setupComplete: true,
};

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (url.startsWith("/setup-api/preferences")) return ok({ ui_language: "de" });
    if (url.includes("/setup-api/clawkeep/memory")) return ok(STATUS);
    return ok({});
  }));
}

describe("Memory Shard errors speak the UI language", () => {
  beforeEach(installFetch);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("words the banner and the last-run line from the route's error codes", async () => {
    render(<I18nProvider><MemoryShardApp /></I18nProvider>);

    await waitFor(() => {
      expect(screen.getByTestId("memory-shard-status-error")).toHaveTextContent(
        "Der Index passt nicht zum eingestellten Einbettungsmodell. Indexiere alles neu.",
      );
    });
    expect(
      screen.getByText(/Die Indexierung ist fehlgeschlagen\. Prüf, ob das Einbettungsmodell verfügbar ist/),
    ).toBeInTheDocument();

    // The English the server sent, which is what used to be drawn.
    expect(screen.queryByText(/The index does not match the configured embedding model/)).toBeNull();
    expect(screen.queryByText(/Indexing failed\. Check that the embedding model/)).toBeNull();
    // And never the raw key a snake_case code would have produced.
    expect(screen.queryByText(/clawkeep\.memory\./)).toBeNull();
  });
});
