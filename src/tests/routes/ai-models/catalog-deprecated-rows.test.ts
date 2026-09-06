import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

/**
 * TASK-615 — the picker offers a model the harness has retired.
 *
 * The card was filed against a hand-maintained Claude list that no longer
 * exists (`augmentWithStaticCatalog`, `STATIC_MODEL_CONTEXT_WINDOWS` and the
 * `claude-sonnet-4-6` default were all removed on 2 Sep, and beta's Anthropic
 * default is `claude-opus-5`). The defect it describes survives the rewrite in
 * a different place: the route's own guard against a retired model is
 *
 *     if (entry.tags?.includes("deprecated")) continue;
 *
 * and on the pinned core (2026.8.1) that can never fire. Measured with an
 * isolated OPENCLAW_HOME:
 *
 *     $ openclaw models list --provider anthropic --all --json
 *     … {"key":"anthropic/claude-opus-4-8","name":"Claude Opus 4.8",
 *        "contextWindow":1000000,"available":null,"tags":[]} …
 *
 * while the core's own manifest for that provider says
 * `{"id":"claude-opus-4-8","status":"deprecated","replacedBy":"claude-opus-5"}`.
 * `toModelRow` simply does not project `status`. So a customer picking from a
 * live enumeration is offered last generation's flagship beside this one, with
 * nothing on screen to tell them apart — the card's symptom exactly.
 */

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

const DATA_DIR = "/tmp/clawbox-catalog-deprecated-test";
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-deprecated-test" }));

const mockSpawn = vi.mocked(childProcess.spawn);

/** A child that answers one `models list --json` payload and exits clean. */
function okChild(payload: unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(payload), "utf8"));
    child.emit("close", 0);
  });
  return child;
}

/**
 * What the pinned core really answers for anthropic on a bare config: six rows,
 * every one of them `tags: []`, the retired one indistinguishable from the rest.
 */
const ANTHROPIC_LIVE = {
  count: 3,
  models: [
    { key: "anthropic/claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000, available: null, tags: [] },
    { key: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1_000_000, available: null, tags: [] },
    { key: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, available: null, tags: [] },
  ],
};

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

describe("catalog: a model the core's own catalogue has retired", () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true });
    vi.resetModules();
    vi.clearAllMocks();
    mockSpawn.mockImplementation(
      () => okChild(ANTHROPIC_LIVE) as unknown as ReturnType<typeof childProcess.spawn>,
    );
    const lifecycle = await import("@/lib/core-model-lifecycle");
    vi.spyOn(lifecycle, "coreRetiredModels").mockImplementation(
      (provider: string) => (provider === "anthropic" ? new Set(["claude-opus-4-8"]) : new Set()),
    );
    ({ GET } = await import("@/app/setup-api/ai-models/catalog/route"));
  });

  async function models(): Promise<string[]> {
    const res = await GET(new NextRequest(
      "http://clawbox.local/setup-api/ai-models/catalog?provider=anthropic",
    ));
    const body = (await res.json()) as { models?: { id: string }[] };
    return (body.models ?? []).map((m) => m.id);
  }

  it("does not offer it, and keeps what replaced it", async () => {
    await models();
    await settle();
    const ids = await models();
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).not.toContain("claude-opus-4-8");
  });

  it("leaves it in the cache the box will still ACCEPT it from", async () => {
    // The distinction the whole change turns on. `subscription-surface.ts`
    // reads this file back as the set of ids the box accepts, so filtering it
    // would not merely stop recommending a retired model — it would start
    // REFUSING one the customer is already on, with "…is not in the Anthropic
    // model catalogue this box enumerated", which the box plainly did.
    await models();
    await settle();
    const cache = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "catalog-cache", "anthropic.json"), "utf8"),
    ) as { models: { id: string }[] };
    expect(cache.models.map((m) => m.id)).toContain("claude-opus-4-8");
  });

  it("re-resolves the default when the retired row was it", async () => {
    // Dropping rows can drop the one the payload named, and a defaultModelId
    // outside `models` is a picker with nothing selected.
    mockSpawn.mockImplementation(() => okChild({
      count: 2,
      models: [
        { key: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1_000_000, available: null, tags: ["default"] },
        { key: "anthropic/claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000, available: null, tags: [] },
      ],
    }) as unknown as ReturnType<typeof childProcess.spawn>);
    await models();
    await settle();
    const res = await GET(new NextRequest(
      "http://clawbox.local/setup-api/ai-models/catalog?provider=anthropic",
    ));
    const body = (await res.json()) as { models: { id: string }[]; defaultModelId: string };
    expect(body.models.map((m) => m.id)).toEqual(["claude-opus-5"]);
    expect(body.defaultModelId).toBe("claude-opus-5");
  });

  it("never filters the picker empty", async () => {
    // The one failure this whole module must not have. If the core has retired
    // everything this box enumerated, the honest picker is the one the box
    // actually has — an empty one offers the customer nothing to do, and the
    // lifecycle reader's own header names an emptied model list as the outcome
    // it fails open to avoid.
    const lifecycle = await import("@/lib/core-model-lifecycle");
    vi.mocked(lifecycle.coreRetiredModels).mockImplementation(
      () => new Set(["claude-opus-5", "claude-opus-4-8", "claude-haiku-4-5"]),
    );
    await models();
    await settle();
    expect(await models()).toEqual(
      expect.arrayContaining(["claude-opus-5", "claude-opus-4-8", "claude-haiku-4-5"]),
    );
  });
});
