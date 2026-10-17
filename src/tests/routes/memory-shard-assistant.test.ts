/**
 * The Memory Shard routes as the ASSISTANT reaches them: the box's MCP bearer,
 * no browser cookie (src/lib/memory-shard-writer.ts).
 *
 * Three properties. The bearer is admitted on every write the Memory Shard app
 * makes, and anything else — no credential, a wrong bearer — is still refused
 * 403 `owner_only`. The work that costs hours or clears the owner's setup does
 * not happen on the assistant's word: a full pass (asked for, or the one an
 * incremental ask would really run), a provider move and the reset answer 409
 * `confirm_required` — with the estimate, or the list of what is cleared —
 * until the body says `confirm: true`, and start nothing before. And a folder
 * is held to the picker's rules: inside the Files root, never hidden, and the
 * assistant is told how many files a pass would read from it.
 *
 * The person's own click is unchanged, and is still covered by the suites
 * beside this one. Every folder here is a synthetic one under a temp root.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const BEARER = "Bearer test-assistant-bearer";

const h = vi.hoisted(() => ({
  person: false,
  enabled: true,
  extraPaths: [] as string[],
  placement: "local" as "local" | "cloud",
  cloudAvailable: true,
  localInstalled: true,
  resolvedMode: "incremental" as "incremental" | "full",
  stopped: true,
}));

vi.mock("@/lib/owner-session", () => ({ hasPersonSession: vi.fn(async () => h.person) }));
vi.mock("@/lib/mcp-token", () => ({ verifyMcpBearer: vi.fn((header: string | null) => header === "Bearer test-assistant-bearer") }));

const lib = vi.hoisted(() => ({
  startMemoryIndex: vi.fn(async (mode: string) => ({ accepted: true, run: { status: "running", mode } })),
  stopMemoryIndex: vi.fn(async () => ({ stopped: h.stopped, run: { status: h.stopped ? "running" : "idle" } })),
  resolveIndexMode: vi.fn(async () => h.resolvedMode),
  getMemoryStatus: vi.fn(async () => ({
    available: true,
    location: h.placement,
    model: h.placement === "cloud" ? "text-embedding-3-large" : "qwen3-embedding-0.6b",
    files: 120,
    pendingFiles: 20,
    chunks: 3_000,
    run: { status: "succeeded", mode: "incremental", durationMs: 4_000 },
    reindex: { needed: true, mode: "full", reasons: [{ code: "embedder_changed", mode: "full", detail: "synthetic" }] },
  })),
  writeMemorySchedule: vi.fn(async (value: unknown) => value),
  readMemorySchedule: vi.fn(async () => ({ enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 })),
  computeNextMemoryRunMs: vi.fn(() => 0),
  invalidateMemoryStatusCache: vi.fn(),
}));
vi.mock("@/lib/clawkeep-memory", () => ({
  ...lib,
  DEFAULT_MEMORY_SCHEDULE: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 },
}));
const refreshScheduler = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/clawkeep-memory-scheduler", () => ({ refresh: refreshScheduler }));

const shard = vi.hoisted(() => ({
  setMemoryShardEnabled: vi.fn(async (on: boolean) => { h.enabled = on; return on; }),
  setMemoryShardSetupComplete: vi.fn(async (done: boolean) => done),
  switchToLocalEmbeddings: vi.fn(async () => {}),
  switchToCloudEmbeddings: vi.fn(async () => {}),
}));
vi.mock("@/lib/memory-shard", () => ({
  ...shard,
  getMemoryShardEnabled: async () => h.enabled,
  getMemoryShardSetupComplete: async () => true,
  readExtraPaths: async () => [...h.extraPaths],
  mutateExtraPaths: async (fn: (current: string[]) => string[]) => (h.extraPaths = await fn([...h.extraPaths])),
  readEmbeddingPlacement: async () => ({ source: h.placement, recorded: true }),
  ExtraPathsUnreadableError: class extends Error {},
}));
vi.mock("@/lib/paid-plan-gate-server", () => ({
  readPlanGate: async () => ({ satisfied: true, plan: "pro" }),
  refusePaidPlan: () => Response.json({ error: "paid_plan_required" }, { status: 402 }),
}));
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/openclaw-config")>(),
  openclawIsAbsent: () => true,
}));
vi.mock("@/lib/prime-radiant/shard-index", () => ({ reindexPrimeRadiantVault: async () => {} }));
vi.mock("@/lib/clawai-cloud-choice", () => ({ noteOwnerChoice: vi.fn(async () => {}) }));
vi.mock("@/lib/embed-server", () => ({ getEmbedProvisioningStatus: async () => ({ installed: h.localInstalled }) }));
vi.mock("@/lib/clawai-cloud-defaults", () => ({ readCloudDefaultsFacts: async () => ({ embeddingsRouteReady: h.cloudAvailable }) }));
vi.mock("@/lib/clawai-cloud-defaults-state", () => ({
  resolveClawaiCloudDefaults: () => ({ embeddings: { source: h.cloudAvailable ? "cloud" : "local", reason: h.cloudAvailable ? null : "plan" } }),
}));
vi.mock("@/lib/harness/credentials", () => ({ resolveClawaiToken: async () => "synthetic-token" }));
vi.mock("@/lib/clawai-cloud-embeddings", () => ({
  CLOUD_EMBEDDING_PROVIDER: "openai",
  CLOUD_EMBEDDING_MODEL: "text-embedding-3-large",
  CLOUD_EMBEDDING_ENGINE: "clawbox-ai",
  cloudEmbeddingsUrl: () => "https://embeddings.invalid/v1",
}));

const url = (p: string) => `http://localhost/setup-api/clawkeep/memory${p}`;
function req(method: string, p: string, body?: unknown, authorization: string | null = BEARER): Request {
  return new Request(url(p), {
    method,
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let root = "";
const savedRoot = process.env.FILES_ROOT;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-shard-assistant-"));
  process.env.FILES_ROOT = root;
  const notes = path.join(root, "Acme notes");
  fs.mkdirSync(path.join(notes, "2026"), { recursive: true });
  for (const name of ["plan.md", "minutes.md", "2026/q1.md"]) fs.writeFileSync(path.join(notes, name), "# synthetic\n");
  fs.writeFileSync(path.join(notes, "contract.pdf"), "%PDF-synthetic");
  fs.writeFileSync(path.join(notes, "photo.jpg"), "not indexed");
  fs.mkdirSync(path.join(notes, ".trash"));
  fs.writeFileSync(path.join(notes, ".trash", "old.md"), "# skipped: hidden");
  fs.mkdirSync(path.join(root, ".cache", "app"), { recursive: true });
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.FILES_ROOT;
  else process.env.FILES_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  Object.assign(h, { person: false, enabled: true, extraPaths: [], placement: "local", cloudAvailable: true, localInstalled: true, resolvedMode: "incremental", stopped: true });
  for (const fn of [...Object.values(lib), ...Object.values(shard), refreshScheduler]) fn.mockClear();
});

afterEach(() => vi.clearAllMocks());

async function routes() {
  return {
    index: await import("@/app/setup-api/clawkeep/memory/index/route"),
    enable: await import("@/app/setup-api/clawkeep/memory/enable/route"),
    reset: await import("@/app/setup-api/clawkeep/memory/reset/route"),
    schedule: await import("@/app/setup-api/clawkeep/memory/schedule/route"),
    sources: await import("@/app/setup-api/clawkeep/memory/sources/route"),
    provider: await import("@/app/setup-api/clawkeep/memory/provider/route"),
  };
}

describe("who may write", () => {
  it("refuses every write without a token, or with a wrong one, before anything happens", async () => {
    const r = await routes();
    for (const authorization of [null, "Bearer not-the-bearer"]) {
      const answers = [
        await r.index.POST(req("POST", "/index", { mode: "incremental" }, authorization) as never),
        await r.index.DELETE(req("DELETE", "/index", undefined, authorization) as never),
        await r.enable.POST(req("POST", "/enable", { enabled: true }, authorization)),
        await r.reset.POST(req("POST", "/reset", { confirm: true }, authorization)),
        await r.schedule.PUT(req("PUT", "/schedule", { enabled: true }, authorization) as never),
        await r.sources.GET(req("GET", "/sources", undefined, authorization) as never),
        await r.sources.POST(req("POST", "/sources", { path: "Acme notes" }, authorization) as never),
        await r.sources.DELETE(req("DELETE", "/sources", { path: "/x" }, authorization) as never),
        await r.provider.POST(req("POST", "/provider", { source: "cloud", confirm: true }, authorization)),
      ];
      for (const res of answers) {
        expect(res.status).toBe(403);
        expect((await res.json()).kind).toBe("owner_only");
      }
    }
    expect(lib.startMemoryIndex).not.toHaveBeenCalled();
    expect(lib.stopMemoryIndex).not.toHaveBeenCalled();
    expect(lib.writeMemorySchedule).not.toHaveBeenCalled();
    expect(shard.setMemoryShardEnabled).not.toHaveBeenCalled();
    expect(shard.switchToCloudEmbeddings).not.toHaveBeenCalled();
    expect(h.extraPaths).toEqual([]);
  });

  it("admits the assistant's bearer on the switch and the schedule", async () => {
    const r = await routes();
    const on = await r.enable.POST(req("POST", "/enable", { enabled: false }));
    expect(on.status).toBe(200);
    expect(shard.setMemoryShardEnabled).toHaveBeenCalledWith(false);
    expect(refreshScheduler).toHaveBeenCalled();

    const saved = await r.schedule.PUT(req("PUT", "/schedule", { enabled: true, frequency: "weekly", timeOfDay: "02:30", weekday: 3 }) as never);
    expect(saved.status).toBe(200);
    expect(lib.writeMemorySchedule).toHaveBeenCalledWith({ enabled: true, frequency: "weekly", timeOfDay: "02:30", weekday: 3 });
  });
});

describe("arming the schedule over an index with nothing in it yet", () => {
  // A scheduled pass holds back a full rebuild of a disowned index but builds
  // an empty one from scratch, so arming the timer is a full pass, later.
  const SCHEDULE = { enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 };

  it("answers the assistant's schedule with the first build's estimate, and saves nothing", async () => {
    h.resolvedMode = "full";
    const { schedule } = await routes();
    const res = await schedule.PUT(req("PUT", "/schedule", SCHEDULE) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "confirm_required", mode: "full", requested: "schedule" });
    expect(body.estimate).toMatchObject({ files: 140, chunks: 3_000 });
    expect(lib.resolveIndexMode).toHaveBeenCalledWith("incremental", "schedule");
    expect(lib.writeMemorySchedule).not.toHaveBeenCalled();
    expect(refreshScheduler).not.toHaveBeenCalled();
  });

  it("saves it with confirm: true, and never gates a schedule that is off or a pass that is incremental", async () => {
    h.resolvedMode = "full";
    const { schedule } = await routes();
    expect((await schedule.PUT(req("PUT", "/schedule", { ...SCHEDULE, confirm: true }) as never)).status).toBe(200);
    expect((await schedule.PUT(req("PUT", "/schedule", { ...SCHEDULE, enabled: false }) as never)).status).toBe(200);
    h.resolvedMode = "incremental";
    expect((await schedule.PUT(req("PUT", "/schedule", SCHEDULE) as never)).status).toBe(200);
    expect(lib.writeMemorySchedule).toHaveBeenCalledTimes(3);
  });

  it("does not ask the person: their click is the decision", async () => {
    Object.assign(h, { person: true, resolvedMode: "full" });
    const { schedule } = await routes();
    expect((await schedule.PUT(req("PUT", "/schedule", SCHEDULE, null) as never)).status).toBe(200);
    expect(lib.resolveIndexMode).not.toHaveBeenCalled();
  });

  it("gates switching Memory Shard on over a saved schedule the same way", async () => {
    h.resolvedMode = "full";
    lib.readMemorySchedule.mockResolvedValue(SCHEDULE);
    try {
      const { enable } = await routes();
      const held = await enable.POST(req("POST", "/enable", { enabled: true }));
      expect(held.status).toBe(409);
      expect((await held.json()).kind).toBe("confirm_required");
      expect(shard.setMemoryShardEnabled).not.toHaveBeenCalled();

      expect((await enable.POST(req("POST", "/enable", { enabled: true, confirm: true }))).status).toBe(200);
      expect(shard.setMemoryShardEnabled).toHaveBeenCalledWith(true);
      // Switching OFF disarms; it never needs a confirm.
      expect((await enable.POST(req("POST", "/enable", { enabled: false }))).status).toBe(200);
    } finally {
      lib.readMemorySchedule.mockResolvedValue({ enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    }
  });
});

describe("the index route", () => {
  it("starts an incremental pass for the assistant without confirm", async () => {
    const { index } = await routes();
    const res = await index.POST(req("POST", "/index", { mode: "incremental" }) as never);
    expect(res.status).toBe(200);
    expect(lib.startMemoryIndex).toHaveBeenCalledWith("incremental", "manual");
  });

  it("answers a full pass without confirm with an estimate, and starts nothing", async () => {
    const { index } = await routes();
    const res = await index.POST(req("POST", "/index", { mode: "full" }) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.kind).toBe("confirm_required");
    expect(body.requested).toBe("full");
    expect(body.estimate).toMatchObject({ files: 140, chunks: 3_000, embedder: "local", tokens: 900_000 });
    expect(body.estimate.minutes.low).toBeGreaterThan(0);
    expect(body.reasons).toEqual([{ code: "embedder_changed", mode: "full", detail: "synthetic" }]);
    expect(lib.startMemoryIndex).not.toHaveBeenCalled();
  });

  it("gates the incremental ask the box would really run in full", async () => {
    h.resolvedMode = "full";
    const { index } = await routes();
    const res = await index.POST(req("POST", "/index", { mode: "incremental" }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).requested).toBe("incremental");
    expect(lib.startMemoryIndex).not.toHaveBeenCalled();
  });

  it("starts the full pass with confirm: true, and never asks the person for one", async () => {
    const { index } = await routes();
    expect((await index.POST(req("POST", "/index", { mode: "full", confirm: true }) as never)).status).toBe(200);
    expect(lib.startMemoryIndex).toHaveBeenLastCalledWith("full", "manual");

    h.person = true;
    lib.startMemoryIndex.mockClear();
    expect((await index.POST(req("POST", "/index", { mode: "full" }, null) as never)).status).toBe(200);
    expect(lib.startMemoryIndex).toHaveBeenCalledWith("full", "manual");
    expect(lib.resolveIndexMode).not.toHaveBeenCalled();
  });

  it("still refuses a switched-off box before the gate", async () => {
    h.enabled = false;
    const { index } = await routes();
    const res = await index.POST(req("POST", "/index", { mode: "full", confirm: true }) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("disabled");
  });

  it("stops the running pass, and says when there is none", async () => {
    const { index } = await routes();
    let res = await index.DELETE(req("DELETE", "/index") as never);
    expect(res.status).toBe(200);
    expect((await res.json()).stopped).toBe(true);

    h.stopped = false;
    res = await index.DELETE(req("DELETE", "/index") as never);
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("not_running");
  });
});

describe("the reset", () => {
  it("without confirm names exactly what would be cleared and kept, and writes nothing", async () => {
    const { reset } = await routes();
    const res = await reset.POST(req("POST", "/reset", {}));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.kind).toBe("confirm_required");
    expect(body.would.clears.join(" ")).toMatch(/switch.*schedule.*setup/);
    expect(body.would.keeps.join(" ")).toMatch(/folder list.*embedding model.*index already built.*nothing on disk is deleted/);
    expect(lib.writeMemorySchedule).not.toHaveBeenCalled();
    expect(shard.setMemoryShardEnabled).not.toHaveBeenCalled();
  });

  it("resets with confirm: true and says what it cleared", async () => {
    const { reset } = await routes();
    const res = await reset.POST(req("POST", "/reset", { confirm: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ enabled: false, setupComplete: false });
    expect(body.cleared).toHaveLength(3);
    expect(shard.setMemoryShardEnabled).toHaveBeenCalledWith(false);
    expect(shard.setMemoryShardSetupComplete).toHaveBeenCalledWith(false);
  });

  it("asks the person for no confirm: the button is the decision", async () => {
    h.person = true;
    const { reset } = await routes();
    expect((await reset.POST(req("POST", "/reset", undefined, null))).status).toBe(200);
  });
});

describe("the provider", () => {
  it("answers a move without confirm with the re-embed estimate on the target, and moves nothing", async () => {
    const { provider } = await routes();
    const res = await provider.POST(req("POST", "/provider", { source: "cloud" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "confirm_required", from: "local", to: "cloud", model: "text-embedding-3-large" });
    expect(body.estimate.embedder).toBe("cloud");
    expect(body.estimate.cost).toMatch(/ClawBox AI plan/);
    expect(shard.switchToCloudEmbeddings).not.toHaveBeenCalled();
  });

  it("moves with confirm: true", async () => {
    const { provider } = await routes();
    const res = await provider.POST(req("POST", "/provider", { source: "cloud", confirm: true }));
    expect(res.status).toBe(200);
    expect(shard.switchToCloudEmbeddings).toHaveBeenCalled();
  });

  it("needs no confirm to stay where it is", async () => {
    const { provider } = await routes();
    expect((await provider.POST(req("POST", "/provider", { source: "local" }))).status).toBe(200);
    expect(shard.switchToLocalEmbeddings).toHaveBeenCalled();
  });

  it("refuses the assistant a cloud that is not on offer and a model that is not downloaded", async () => {
    const { provider } = await routes();
    h.cloudAvailable = false;
    let res = await provider.POST(req("POST", "/provider", { source: "cloud", confirm: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("cloud_unavailable");

    Object.assign(h, { cloudAvailable: true, placement: "cloud", localInstalled: false });
    res = await provider.POST(req("POST", "/provider", { source: "local", confirm: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("local_not_installed");
    expect(shard.switchToLocalEmbeddings).not.toHaveBeenCalled();
    expect(shard.switchToCloudEmbeddings).not.toHaveBeenCalled();
  });
});

describe("the folders", () => {
  it("adds a folder named from the Files home and counts what a pass would read", async () => {
    const { sources } = await routes();
    const res = await sources.POST(req("POST", "/sources", { path: "Acme notes" }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    const folder = fs.realpathSync(path.join(root, "Acme notes"));
    expect(body).toMatchObject({ paths: [folder], folder, added: true });
    // Three markdown files and one PDF; the photo and the hidden folder's file are not read.
    expect(body.wouldRead).toEqual({ files: 4, markdown: 3, documents: 1, documentsOverCap: 0, complete: true });

    const again = await (await sources.POST(req("POST", "/sources", { path: folder }) as never)).json();
    expect(again).toMatchObject({ paths: [folder], added: false });
  });

  it("holds the assistant to the picker's rules: no hidden folder, nothing outside the Files root", async () => {
    const { sources } = await routes();
    let res = await sources.POST(req("POST", "/sources", { path: ".cache/app" }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).kind).toBe("hidden");

    res = await sources.POST(req("POST", "/sources", { path: path.dirname(root) }) as never);
    expect(res.status).toBe(404);
    expect((await res.json()).kind).toBe("not_found");
    expect(h.extraPaths).toEqual([]);
  });

  it("lists and removes folders for the assistant", async () => {
    h.extraPaths = ["/srv/files/Globex", "/srv/files/Initech"];
    const { sources } = await routes();
    expect(await (await sources.GET(req("GET", "/sources") as never)).json()).toEqual({ paths: ["/srv/files/Globex", "/srv/files/Initech"] });
    const res = await sources.DELETE(req("DELETE", "/sources", { path: "/srv/files/Globex" }) as never);
    expect(await res.json()).toEqual({ paths: ["/srv/files/Initech"] });
  });

  it("keeps the person's answer as it was: no walk, no count", async () => {
    h.person = true;
    const { sources } = await routes();
    const body = await (await sources.POST(req("POST", "/sources", { path: "Acme notes" }, null) as never)).json();
    expect(body.wouldRead).toBeUndefined();
    expect(Object.keys(body)).toEqual(["paths"]);
  });
});
