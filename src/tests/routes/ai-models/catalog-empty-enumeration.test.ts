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

// A per-PROCESS data root. A fixed `/tmp/<name>` is shared by every vitest
// worker on the machine and by every checkout of this repo on it: this suite
// lost a run to a second checkout running the same file (beta, 2026-09-12 —
// "expected 0 to be 2" over a record the other process had just reset). The
// same suffix `vitest.config.ts` already gives `CLAWBOX_ROOT`.
const DATA_DIR = `/tmp/clawbox-catalog-empty-enumeration-test-${process.pid}`;
vi.mock("@/lib/config-store", () => ({ DATA_DIR: `/tmp/clawbox-catalog-empty-enumeration-test-${process.pid}` }));

import { GET, notifyProviderSetChanged } from "@/app/setup-api/ai-models/catalog/route";

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

  // xAI (Grok) rides the same CLI enumeration as every other plugin-backed
  // provider, and both of its answers matter: the bundled plugin lists nothing
  // until a key is on the box, and its full catalogue afterwards. One test,
  // because it is one sequence — and the hinge between the two halves is the
  // call the configure route makes after it has pasted the key.
  it("serves the curated Grok rows until a key is saved, then the box's own xai enumeration", async () => {
    mockList({ count: 0, models: [] });
    await get("xai", "&refresh=1");

    // The clean zero is the box's answer and is recorded as one...
    expect(await recordedCount("xai")).toBe(0);
    // ...and what the picker gets is the cold-start list, never stamped as an
    // enumeration, with a custom id still allowed.
    const before = await get("xai");
    expect((before.models as { id: string }[]).map((m) => m.id)).toEqual(["grok-4.7", "grok-4.6", "grok-4.5"]);
    expect(before.defaultModelId).toBe("grok-4.7");
    expect(before.allowCustom).toBe(true);
    expect(before.source).not.toBe("live");

    // The key lands. `notifyProviderSetChanged` forgets the recorded zero and
    // re-enumerates, without waiting out any backoff.
    mockList({
      count: 4,
      models: [
        { key: "xai/grok-4.7", name: "Grok 4.7", contextWindow: 500_000, available: true, tags: ["default"] },
        { key: "xai/grok-4.6", name: "Grok 4.6", contextWindow: 500_000, available: true, tags: [] },
        { key: "xai/grok-4.5", name: "Grok 4.5", contextWindow: 500_000, available: true, tags: [] },
        { key: "xai/grok-4.3", name: "Grok 4.3", contextWindow: 1_000_000, available: true, tags: [] },
      ],
    });
    notifyProviderSetChanged("xai");

    let after: Record<string, unknown> = {};
    await vi.waitFor(async () => {
      after = await get("xai");
      expect(after.source).toBe("live");
    }, { timeout: 4000, interval: 25 });
    const ids = (after.models as { id: string }[]).map((m) => m.id);
    // A row the curated list never named is offered: the enumeration decides.
    expect(ids).toEqual(expect.arrayContaining(["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3"]));
    expect(after.defaultModelId).toBe("grok-4.7");
    await vi.waitFor(() => expect(readRecord().xai?.models).toBe(4), { timeout: 4000, interval: 25 });
    // The CLI was asked about the provider id the plugin registers — with
    // `--refresh`, so the core acquires xAI's live inventory before listing.
    expect(mockSpawn.mock.calls.some(([, args]) =>
      Array.isArray(args) && args.join(" ") === "models list --provider xai --all --json --refresh")).toBe(true);
  });

  // The default follows the newest model the provider publishes, by the version
  // in xAI's own ids — not the core's curated `default` tag, frozen at the
  // core's release, and never a dated variant whose "4.20" would read as newer
  // than 4.7. No ClawBox release sits between xAI shipping a model and the
  // picker defaulting to it.
  it("makes a Grok model xAI ships later the default, newest first", async () => {
    mockList({
      count: 5,
      models: [
        { key: "xai/grok-4.20-0309-reasoning", name: "Grok 4.20 Reasoning", contextWindow: 1_000_000, available: true, tags: [] },
        { key: "xai/grok-4.3", name: "Grok 4.3", contextWindow: 1_000_000, available: true, tags: [] },
        { key: "xai/grok-4.7", name: "Grok 4.7", contextWindow: 500_000, available: true, tags: ["default"] },
        { key: "xai/grok-4.8", name: "Grok 4.8", contextWindow: 500_000, available: true, tags: [] },
        { key: "xai/grok-4.6", name: "Grok 4.6", contextWindow: 500_000, available: true, tags: [] },
      ],
    });
    notifyProviderSetChanged("xai");

    let after: Record<string, unknown> = {};
    await vi.waitFor(async () => {
      after = await get("xai");
      expect(after.source).toBe("live");
      expect((after.models as unknown[]).length).toBe(5);
    }, { timeout: 4000, interval: 25 });
    const rows = after.models as { id: string; hint?: string }[];
    expect(after.defaultModelId).toBe("grok-4.8");
    expect(rows.map((m) => m.id)).toEqual(["grok-4.8", "grok-4.7", "grok-4.6", "grok-4.3", "grok-4.20-0309-reasoning"]);
    // The curated "Default. Newest flagship." moved with the default instead of
    // describing yesterday's model.
    expect(rows.find((m) => m.id === "grok-4.8")?.hint).toBe("Default. Newest flagship.");
    expect(rows.find((m) => m.id === "grok-4.7")?.hint).toBeUndefined();
  });

  it("records NOTHING when `models` is not a list at all", async () => {
    // The parser coerces a non-array `models` to `[]`, so a body like
    // `{count: 0, models: {}}` looks exactly like a clean zero once it is past
    // that line — and would hide the provider for the record's whole lifetime.
    // A shape we do not recognise is not an answer.
    mockList({ count: 0, models: {} });
    await get("anthropic", "&refresh=1");
    await settle();

    const recorded = fs.existsSync(RECORD) ? readRecord() : {};
    expect(recorded.anthropic).toBeUndefined();
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
