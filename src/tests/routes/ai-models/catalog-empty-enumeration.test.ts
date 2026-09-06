import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

// TASK-668 — "the box can run no model from this provider" is a FACT the
// harness already tells us, and beta throws it away.
//
// `openclaw models list --provider google --all --json` answers `{count: 0}`
// on a box whose `models.mode` is `replace` (measured: anthropic 15->9,
// openai 30->2, google 10->0). Beta logs that, records a failed refresh and
// keeps the previous catalogue — so the picker and the Providers page keep
// offering rows the gateway will refuse, and the backoff re-forks a
// three-minute enumeration for ever.
//
// A CLEAN zero is an answer: it is recorded, so the surfaces can drop the row
// (the owner's ruling), and the generation counts as answered so nothing
// re-forks. A zero that came with a refusal, with stderr, or after every listed
// row was filtered out is NOT an answer and is recorded as nothing at all.

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

const DATA_DIR = "/tmp/clawbox-catalog-empty-enumeration-test";
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-empty-enumeration-test" }));

import { GET } from "@/app/setup-api/ai-models/catalog/route";

const mockSpawn = vi.mocked(childProcess.spawn);

function fakeChild(json: unknown, stderr = "") {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf8"));
    child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
    child.emit("close", 0);
  });
  return child;
}

function mockList(json: unknown, stderr = ""): void {
  mockSpawn.mockImplementation(
    () => fakeChild(json, stderr) as unknown as ReturnType<typeof childProcess.spawn>,
  );
}

const RECORD = path.join(DATA_DIR, "catalog-cache", "_enumerations.json");

function readRecord(): Record<string, { models: number }> {
  const parsed = JSON.parse(fs.readFileSync(RECORD, "utf8")) as {
    providers?: Record<string, { models: number }>;
  };
  return parsed.providers ?? {};
}

async function get(provider: string, params = ""): Promise<Record<string, unknown>> {
  const url = `http://clawbox.local/setup-api/ai-models/catalog?provider=${provider}${params}`;
  return (await (await GET(new NextRequest(url))).json()) as Record<string, unknown>;
}

/** Wait for the detached refresh to have written the record for `provider`. */
async function recordedCount(provider: string): Promise<number | undefined> {
  let count: number | undefined;
  await vi.waitFor(() => {
    expect(fs.existsSync(RECORD)).toBe(true);
    count = readRecord()[provider]?.models;
    expect(count).toBeTypeOf("number");
  }, { timeout: 4000, interval: 25 });
  return count;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no network in this suite");
  }));
  vi.clearAllMocks();
  fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
});

describe("catalog — a clean empty enumeration is an answer, not a failure", () => {
  it("records zero when the CLI answers with no rows at all", async () => {
    // With an unrelated warning on stderr, deliberately. Every `openclaw models
    // list` on the shipped boxes prints `[agents/model-registry] model catalog
    // load issue: … gpt-image-1-mini: no "api" specified` — on every provider's
    // enumeration, exit code 0 — so requiring an empty stderr made this whole
    // rule dead code there. What says the answer is untrustworthy is the CLI
    // refusing, not the CLI grumbling.
    mockList({ count: 0, models: [] }, "[agents/model-registry] model catalog load issue: …");
    await get("google", "&refresh=1");

    expect(await recordedCount("google")).toBe(0);
  });

  it("records the count when the enumeration answers with rows", async () => {
    mockList({
      count: 2,
      models: [
        { key: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_000_000, available: true, tags: [] },
        { key: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_000_000, available: true, tags: ["default"] },
      ],
    });
    await get("google", "&refresh=1");

    expect(await recordedCount("google")).toBe(2);
  });

  it("records NOTHING when the payload never stated a count", async () => {
    // Read positively, not inferred from absence: a truncated or shape-shifted
    // payload parses into the same emptiness as a real answer, and this verdict
    // hides a row.
    mockList({ models: [] });
    await get("google", "&refresh=1");
    await settle();

    const recorded = fs.existsSync(RECORD) ? readRecord() : {};
    expect(recorded.google).toBeUndefined();
  });

  it("records zero when the CLI listed rows and marked every one unroutable", async () => {
    // The second shape of the same answer, and the one that fires while the CLI
    // still has a catalogue to print. Our own transform drops an `available:
    // false` row, so the published count is zero either way — what makes this an
    // ANSWER rather than a failure is that the command ran and refused nothing.
    mockList({
      count: 2,
      models: [
        { key: "anthropic/claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000, available: false, tags: [] },
        { key: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 1_000_000, available: false, tags: [] },
      ],
    });
    await get("anthropic", "&refresh=1");

    expect(await recordedCount("anthropic")).toBe(0);
  });

  it("records the rows the harness did not JUDGE, never against them", async () => {
    // Measured on the OpenClaw box: with no Google credential all ten google
    // rows come back `available: null`, while every row of the LINKED deepseek
    // provider on the same box comes back `true`. `null` is "not determined",
    // and writing a provider off for it would hide every one a box has not
    // finished setting up — so these two rows are published and counted.
    mockList({
      count: 2,
      models: [
        { key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 400_000, available: null, tags: [] },
        { key: "openai/gpt-5.4", name: "GPT-5.4", contextWindow: 400_000, tags: [] },
      ],
    });
    await get("openai", "&refresh=1");

    expect(await recordedCount("openai")).toBe(2);
  });

  it("records NOTHING when the CLI refused — an error is not an empty catalogue", async () => {
    // The false-failure guard. `ok: false` and a message on stderr mean the
    // question was not answered; recording zero there would hide a provider
    // the box can run perfectly well.
    mockList({ ok: false, error: { message: "provider plugin is not installed" }, models: [] }, "boom");
    await get("google", "&refresh=1");
    await settle();

    const recorded = fs.existsSync(RECORD) ? readRecord() : {};
    expect(recorded.google).toBeUndefined();
  });

  it("records NOTHING when rows were listed but every one was filtered out", async () => {
    // "17 rows, none of them chat models this picker can offer" is a fact
    // about OUR filter, not about what the box can run.
    mockList({
      count: 1,
      models: [
        { key: "google/imagen-4", name: "Imagen 4", contextWindow: 0, available: true, tags: [] },
      ],
    });
    await get("google", "&refresh=1");
    await settle();

    const recorded = fs.existsSync(RECORD) ? readRecord() : {};
    expect(recorded.google).toBeUndefined();
  });
});
