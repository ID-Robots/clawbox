import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

// TASK-786 — `data/catalog-cache/codex.json`, a file no code path can write.
//
// Measured on the OpenClaw box (2026-09-09, core 2026.8.1): every other cache
// file was stamped that morning; `codex.json` was seven days old, holding the
// six curated rows of a build that predates `hasNoEnumerationOnThisCore`.
// `refreshInBackground` now returns at that branch BEFORE `writeDiskCache`, so
// nothing can ever restamp it — but `GET` still preferred it, and
// `sanitizeCachedPayload` rebuilds the payload from the DISK rows rather than
// from the curated catalogue. The picker was therefore serving a 2026-09-02
// snapshot of a list this repo believes it owns.
//
// The customer-visible half: a model added to `CODEX_MODELS` never reaches a
// box that carries this file. The contents happened to match on the day it was
// found, which is exactly why it would have silently swallowed the fix.
//
// Its own file because it needs a module whose `memCache` is empty for `codex`
// — the disk cache is only consulted when nothing is in memory.
//
// THREE of these four are red on unmodified beta: the served list, the file
// left behind, and the missing gpt-5.3-codex-spark row. The `source` case is a
// forward guard — the seeded fixture carries no `source` and the sanitiser
// copies it through, so it holds before the fix too — and is here so a later
// change cannot start stamping the curated list as a device's answer.

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

const DATA_DIR = "/tmp/clawbox-catalog-codex-unwritable-test";
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-codex-unwritable-test" }));

import { GET } from "@/app/setup-api/ai-models/catalog/route";
import { CODEX_MODELS } from "@/lib/provider-models";

const mockSpawn = vi.mocked(childProcess.spawn);

function fakeChild(json: unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
    child.emit("close", 0);
  });
  return child;
}

const CACHE_DIR = path.join(DATA_DIR, "catalog-cache");
const CODEX_CACHE = path.join(CACHE_DIR, "codex.json");

/**
 * The file as it sat on the box: the curated list of an older build, minus one
 * row, under the real `fetchedAt` (2026-09-02T19:37:36Z). A row the current
 * curated list does not carry is what makes the difference visible — with an
 * identical copy the defect is invisible, which is how it survived.
 */
function seedStaleCodexCache(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    CODEX_CACHE,
    JSON.stringify({
      provider: "codex",
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", contextWindow: 0 },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", contextWindow: 0 },
        { id: "gpt-5.5", label: "GPT-5.5", contextWindow: 0 },
        { id: "gpt-5.4", label: "GPT-5.4", contextWindow: 0 },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", contextWindow: 0 },
      ],
      defaultModelId: "gpt-5.5",
      allowCustom: true,
      fetchedAt: 1_788_377_856_920,
    }),
    "utf8",
  );
}

beforeEach(() => {
  // The boot warmup would otherwise reach openrouter.ai for real.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no network in this suite");
  }));
  vi.clearAllMocks();
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  mockSpawn.mockImplementation(
    () => fakeChild({ count: 0, models: [] }) as unknown as ReturnType<typeof childProcess.spawn>,
  );
});

describe("catalog — codex is never served from a cache the code cannot write", () => {
  it("serves the curated ChatGPT catalogue, not the stale file", async () => {
    seedStaleCodexCache();

    const res = await GET(new NextRequest("http://clawbox.local/setup-api/ai-models/catalog?provider=codex"));
    const body = (await res.json()) as { models: Array<{ id: string }> };

    expect(body.models.map((m) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
  });

  it("removes the leftover file so nothing can serve it again", async () => {
    seedStaleCodexCache();

    await GET(new NextRequest("http://clawbox.local/setup-api/ai-models/catalog?provider=codex"));

    expect(fs.existsSync(CODEX_CACHE)).toBe(false);
  });

  it("offers gpt-5.3-codex-spark, which the core routes on this surface", async () => {
    // Measured on the box, 2026-09-09, core 2026.8.1:
    //   openclaw infer model run --local --model openai/gpt-5.3-codex-spark
    //   -> api=openclaw-openai-chatgpt-responses-transport
    //      url=https://chatgpt.com/backend-api/codex/responses  status=200
    // The core's own route contract files it under
    // OPENAI_SUBSCRIPTION_ONLY_ROUTE_MODEL_IDS — it runs on the ChatGPT
    // account and NOWHERE else — and the openai (platform) enumeration
    // reports it `available: false` for exactly that reason. The generation
    // regex this surface used as its allowlist could not spell it, so the one
    // surface that can run it was the one surface that hid it.
    const res = await GET(new NextRequest("http://clawbox.local/setup-api/ai-models/catalog?provider=codex"));
    const body = (await res.json()) as { models: Array<{ id: string }> };

    expect(body.models.map((m) => m.id)).toContain("gpt-5.3-codex-spark");
  });

  it("does not claim the curated list is the box's own answer", async () => {
    seedStaleCodexCache();

    const res = await GET(new NextRequest("http://clawbox.local/setup-api/ai-models/catalog?provider=codex"));
    const body = (await res.json()) as Record<string, unknown>;

    // `source` is the stamp that means "a device enumerated this". The curated
    // list is not that, on this path or any other.
    expect(body.source).toBeUndefined();
  });
});
