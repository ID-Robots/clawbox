/**
 * TASK-899 — three reads the on-box agent had no tool for:
 * `memory_shard_status`, `local_ai_status` and `clawbox_ai_usage`.
 *
 * All three are registered on every box, both editions, and answer every state
 * the device can be in — off, unlinked, not installed, refused by the portal —
 * as an ANSWER rather than an error, because that is exactly the box the agent
 * needs them on and an error there only feeds Hermes' circuit breaker. None of
 * them can start the work it reports on: reindexing and installing are the
 * owner's, and each answer says where the owner's button is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiTry } = vi.hoisted(() => ({ apiGet: vi.fn(), apiTry: vi.fn() }));

vi.mock("../../../mcp/lib/api", async () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: vi.fn(),
  apiTry: (...a: unknown[]) => apiTry(...a),
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerMemoryTools } from "../../../mcp/tools/memory";
import { registerLocalAiTools } from "../../../mcp/tools/local-ai";
import { registerAiTools } from "../../../mcp/tools/ai";
import type { McpContext } from "../../../mcp/lib/context";
import { BANNED_DESCRIPTION_RE, MAX_DESCRIPTION_CHARS } from "../../../mcp/lib/register";

function harness(edition: "openclaw" | "hermes") {
  const h = captureRegistrar(edition);
  registerMemoryTools(h.reg);
  registerLocalAiTools(h.reg);
  registerAiTools(h.reg, { canGenerateImages: true, providers: [] } as unknown as McpContext);
  return h;
}

beforeEach(() => {
  apiGet.mockReset();
  apiTry.mockReset();
});

describe("registration", () => {
  it("offers all three on both editions, read-only, inside the contract", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const h = harness(edition);
      for (const name of ["memory_shard_status", "local_ai_status", "clawbox_ai_usage"]) {
        const tool = h.get(name);
        expect(tool.opts.readOnly).toBe(true);
        expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
        expect(tool.description).not.toMatch(BANNED_DESCRIPTION_RE);
      }
    }
  });

  it("points at memory_shard_search only where it is registered", () => {
    expect(harness("hermes").get("memory_shard_status").description).toMatch(/memory_shard_search/);
    expect(harness("openclaw").get("memory_shard_status").description).not.toMatch(/memory_shard_search/);
  });

  it("offers no tool that starts a reindex, installs an engine or changes the plan", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const names = harness(edition).names();
      expect(names.some((n) => /reindex|index_start|install|plan|credit/.test(n))).toBe(false);
    }
  });
});

const MEMORY = {
  available: true,
  provider: "local",
  model: "embeddinggemma",
  location: "local",
  health: "healthy",
  semanticAvailable: true,
  indexIdentity: "valid",
  enabled: true,
  setupComplete: true,
  planGate: { satisfied: true, plan: "pro", message: "" },
  sourceCount: 2,
  files: 120,
  chunks: 3400,
  pendingFiles: 0,
  failedItems: 1,
  dirty: false,
  error: "",
  errorCode: "",
  run: { status: "succeeded", mode: "incremental", trigger: "schedule", startedAtMs: 1, finishedAtMs: Date.UTC(2026, 8, 18, 3, 12), durationMs: 5, errorCode: "", progress: null },
  schedule: { enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 },
  nextRunAtMs: Date.UTC(2026, 8, 19, 3, 0),
};

describe("memory_shard_status", () => {
  it("reports the index, the last pass and the schedule, and that reindexing is the owner's", async () => {
    apiGet.mockResolvedValue(MEMORY);
    const out = await harness("openclaw").call("memory_shard_status", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(apiGet).toHaveBeenCalledWith("/setup-api/clawkeep/memory", expect.objectContaining({ timeoutMs: 30_000 }));
    const s = JSON.parse(out.text) as Record<string, unknown>;
    expect(s).toMatchObject({
      switched_on: true,
      health: "healthy",
      searchable: true,
      folders: 2,
      files_indexed: 120,
      chunks: 3400,
      files_failed: 1,
      indexing: { last_pass: "succeeded", finished: "2026-09-18 03:12 UTC" },
      schedule: "every day at 03:00 (box time)",
      next_scheduled_pass: "2026-09-19 03:00 UTC",
    });
    expect(String(s.guidance)).toMatch(/cannot start indexing/);
    expect(String(s.guidance)).toMatch(/ui_open_app\("memory-shard"\)/);
    expect(String(s.guidance)).not.toMatch(/memory_shard_search/);
  });

  it("gives a running pass's progress as files, chunks and a percentage", async () => {
    apiGet.mockResolvedValue({
      ...MEMORY,
      run: { status: "running", mode: "full", startedAtMs: Date.UTC(2026, 8, 18, 9, 0), progress: { filesDone: 30, filesTotal: 120, chunks: 800 } },
    });
    const out = await harness("hermes").call("memory_shard_status", {});
    if (out.isError) throw new Error("expected a status");
    const s = JSON.parse(out.text) as { indexing: Record<string, unknown>; guidance: string };
    expect(s.indexing).toMatchObject({ now: "running", mode: "full", progress: "30 of 120 files (25%); 800 chunks in the index so far" });
    expect(s.guidance).toMatch(/do not check again in a loop/);
    expect(s.guidance).toMatch(/memory_shard_search/);
  });

  it("says a pass is still scanning rather than claiming 0%", async () => {
    apiGet.mockResolvedValue({ ...MEMORY, run: { status: "running", progress: { filesDone: 0, filesTotal: 0, chunks: 0 } } });
    const out = await harness("openclaw").call("memory_shard_status", {});
    if (out.isError) throw new Error("expected a status");
    expect(out.text).toMatch(/still scanning the folders/);
    expect(out.text).not.toMatch(/0%/);
  });

  it("answers a switched-off box as an answer, with the owner's switch", async () => {
    apiGet.mockResolvedValue({ ...MEMORY, enabled: false, run: { status: "idle" } });
    const out = await harness("hermes").call("memory_shard_status", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/switched OFF/);
    expect(out.text).not.toMatch(/Search the indexed documents/);
  });
});

describe("local_ai_status", () => {
  const INVENTORY = {
    models: [
      { id: "llamacpp", name: "Gemma 4", kind: "llm", installed: true, enabled: true, running: "running", diskBytes: 3 * 1024 ** 3, memoryBytes: 2 * 1024 ** 3, control: "user-unit", detail: "Answering on this box" },
      { id: "kokoro", name: "Kokoro", kind: "tts", installed: false, enabled: null, running: "not-installed", diskBytes: null, memoryBytes: null, control: "none", detail: "Not installed" },
      { id: "whisper", name: "Whisper", kind: "stt", installed: true, enabled: true, running: "idle", diskBytes: 150 * 1024 ** 2, memoryBytes: null, control: "user-unit", detail: "Ready" },
      { id: "embeddings", name: "Memory search", kind: "embedding", installed: true, enabled: true, running: "on-demand", diskBytes: 300 * 1024 ** 2, memoryBytes: null, control: "user-unit", detail: "Local" },
    ],
    unavailable: [],
  };

  it("lists every engine and which voice and transcription the box uses", async () => {
    apiGet.mockResolvedValue(INVENTORY);
    apiTry.mockImplementation(async (path: string) => {
      if (path === "/setup-api/tts") return { choice: "auto", activeEngine: "cloud", language: "en" };
      if (path === "/setup-api/stt") return { primary: "local", chain: ["local", "cloud"] };
      return null;
    });
    const out = await harness("openclaw").call("local_ai_status", { engine: "all" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const s = JSON.parse(out.text) as { engines: Record<string, unknown>[]; voice: Record<string, unknown>; transcription: Record<string, unknown>; guidance: string };
    expect(s.engines.map((e) => e.id)).toEqual(["llamacpp", "kokoro", "whisper", "embeddings"]);
    expect(s.engines[0]).toMatchObject({ does: "answers chat on the box", installed: true, state: "running", disk_mb: 3072, memory_mb: 2048 });
    expect(s.voice).toMatchObject({ chosen: "auto", speaking_with: "the ClawBox cloud voice" });
    expect(s.transcription).toMatchObject({ first_choice: "on the box (Whisper)", tried_in_order: ["local", "cloud"] });
    expect(s.guidance).toMatch(/Not installed here: Kokoro/);
    expect(s.guidance).toMatch(/Settings → Local AI/);
  });

  it("narrows to one engine and adds what only that engine's route knows", async () => {
    apiGet.mockResolvedValue(INVENTORY);
    apiTry.mockImplementation(async (path: string) => {
      if (path === "/setup-api/whisper") return { installed: true, active: "base", sizes: [{ id: "tiny", cached: false }, { id: "base", cached: true }], freeBytes: 12.34 * 1024 ** 3 };
      if (path === "/setup-api/stt") return { primary: "cloud", chain: ["cloud"] };
      return null;
    });
    const out = await harness("hermes").call("local_ai_status", { engine: "whisper" });
    if (out.isError) throw new Error("expected a status");
    const s = JSON.parse(out.text) as Record<string, unknown>;
    expect((s.engines as { id: string }[]).map((e) => e.id)).toEqual(["whisper"]);
    expect(s.whisper_sizes).toEqual(["tiny", "base (downloaded) — in use"]);
    expect(s.free_disk_gb).toBe(12.3);
    expect(s).not.toHaveProperty("voice");
    expect(apiTry).not.toHaveBeenCalledWith("/setup-api/tts", expect.anything());
  });
});

describe("clawbox_ai_usage", () => {
  it("reads the weekly allowance, the burst limit, the meters and the credits", async () => {
    apiGet.mockResolvedValue({
      available: true,
      timeZone: "Europe/Sofia",
      usage: {
        shape: "weekly",
        plan: "pro",
        tierDisplayName: "Pro",
        weekly: { used: 40, limit: 100, percentUsed: 40, isOverLimit: false, resetAt: "2026-09-21T00:00:00.000Z", unavailable: false },
        burst: { used: 10, limit: 10, percentUsed: 100, isOverLimit: true, resetAt: "2026-09-18T15:00:00.000Z", unavailable: false },
        meters: {
          images: { used: 3, limit: 50, percentUsed: 6, isOverLimit: false, resetAt: null, unavailable: false },
          speechSeconds: { used: 600, limit: 3600, percentUsed: 17, isOverLimit: false, resetAt: null, unavailable: false },
          embeddingsTokens: { used: 0, limit: 0, percentUsed: 0, isOverLimit: false, resetAt: null, unavailable: false },
        },
        credits: { balanceCents: 1250, usedThisWeekCents: 100, canBuy: true, currency: "EUR", unavailable: false },
        billingInterval: "month",
        legacy: { percentUsed: 40, resetIn: null, isOverLimit: false, tier: "pro", tierDisplayName: "Pro", buckets: null },
      },
    });
    const out = await harness("openclaw").call("clawbox_ai_usage", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(apiGet).toHaveBeenCalledWith("/setup-api/ai-models/usage", expect.anything());
    const u = JSON.parse(out.text) as Record<string, unknown>;
    expect(u).toMatchObject({
      plan: "Pro",
      billed: "monthly",
      weekly_allowance: "40% used, 40 of 100, frees up at 2026-09-21 00:00 UTC",
      five_hour_limit: "USED UP, 100% used, 10 of 10, frees up at 2026-09-18 15:00 UTC",
      this_week: { pictures: "6% used, 3 of 50", "spoken replies": "17% used, 10 min of 60 min", "memory indexing": "not part of this plan" },
      credits: "12.50 EUR left, 1.00 spent this week",
      box_time_zone: "Europe/Sofia",
    });
  });

  it("answers the portal refusing the box as an answer, with where the owner can look", async () => {
    apiGet.mockResolvedValue({ available: false, reason: "refused" });
    const out = await harness("hermes").call("clawbox_ai_usage", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/does not share usage details with this box yet/);
    expect(out.text).toMatch(/clawbox\.com/);
  });

  it("says an unlinked box has no allowance, and points at the owner's setting", async () => {
    apiGet.mockResolvedValue({ available: false, reason: "not_connected" });
    const out = await harness("openclaw").call("clawbox_ai_usage", {});
    if (out.isError) throw new Error("expected an answer");
    expect(out.text).toMatch(/not linked to ClawBox AI/);
    expect(out.text).toMatch(/Settings → Providers/);
  });

  it("reads the older portal shape too", async () => {
    apiGet.mockResolvedValue({
      available: true,
      usage: { shape: "legacy", plan: "free", tierDisplayName: null, legacy: { percentUsed: 81.6, resetIn: "3h", isOverLimit: false } },
    });
    const out = await harness("openclaw").call("clawbox_ai_usage", {});
    if (out.isError) throw new Error("expected an answer");
    expect(JSON.parse(out.text)).toEqual({ plan: "free", used: "82%", used_up: false, resets_in: "3h" });
  });
});
