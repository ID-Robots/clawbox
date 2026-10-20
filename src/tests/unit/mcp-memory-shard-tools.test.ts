/**
 * Memory Shard as the assistant's tools (mcp/tools/memory.ts): every action
 * the Memory Shard app has, through the app's own routes, with the owner's go
 * required where the work costs hours or clears a setting.
 *
 * The routes are stubbed at `api`/`apiGet`; what the routes themselves admit
 * and refuse is src/tests/routes/memory-shard-assistant.test.ts. All folders
 * and values are synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { api, apiGet } = vi.hoisted(() => ({ api: vi.fn(), apiGet: vi.fn() }));
vi.mock("../../../mcp/lib/api", () => ({
  api: (...a: unknown[]) => api(...a),
  apiGet: (...a: unknown[]) => apiGet(...a),
}));

import { MEMORY_SHARD_TOOLS, registerMemoryTools } from "../../../mcp/tools/memory";
import { ApiError } from "../../../mcp/lib/errors";
import { contractViolations, paramDescriptionViolations } from "../../../mcp/lib/register";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";

const BASE = "/setup-api/clawkeep/memory";

function harness(edition: "openclaw" | "hermes" = "hermes"): CaptureHarness {
  const h = captureRegistrar(edition);
  registerMemoryTools(h.reg);
  return h;
}

/** Route stubs keyed `METHOD /path`; an ApiError value is thrown, as the route's refusal. */
function routes(table: Record<string, unknown>) {
  api.mockImplementation(async (path: string, opts: { method?: string } = {}) => {
    const key = `${opts.method ?? "GET"} ${path}`;
    if (!(key in table)) throw new Error(`unexpected call ${key}`);
    const reply = table[key];
    if (reply instanceof ApiError) throw reply;
    return reply;
  });
}

const refusal = (status: number, body: Record<string, unknown>) => new ApiError(status, JSON.stringify(body));
const sent = (n = 0) => api.mock.calls[n] as [string, { method?: string; body?: Record<string, unknown>; timeoutMs?: number; onTimeout?: unknown }];
const parse = (h: CaptureHarness, tool: string, args: unknown) => z.object(h.get(tool).shape).safeParse(args);

const ESTIMATE = {
  files: 140,
  chunks: 3_400,
  embedder: "cloud",
  tokens: 1_020_000,
  minutes: { low: 10, high: 40 },
  basis: "a rough rate for the ClawBox AI cloud embedder over 3400 passages",
  cost: "Sent to the ClawBox AI cloud embedder: about 1,020,000 tokens, counted against the owner's ClawBox AI plan.",
};

beforeEach(() => {
  api.mockReset();
  apiGet.mockReset();
});

describe("the family", () => {
  it("registers every tool on Hermes, all but search on OpenClaw, inside the contract", () => {
    expect(harness("hermes").names().sort()).toEqual([...MEMORY_SHARD_TOOLS].sort());
    expect(harness("openclaw").names().sort()).toEqual(MEMORY_SHARD_TOOLS.filter((n) => n !== "memory_shard_search").sort());
    for (const edition of ["openclaw", "hermes"] as const) {
      for (const info of harness(edition).reg.list()) {
        expect(contractViolations(info), info.name).toEqual([]);
        expect(paramDescriptionViolations(info), info.name).toEqual([]);
      }
    }
  });

  it("keeps search on the core profile and the management tools on the full one", () => {
    const h = harness("hermes");
    expect(h.get("memory_shard_search").opts.profile).toBe("core");
    for (const name of MEMORY_SHARD_TOOLS.filter((n) => n !== "memory_shard_search")) {
      expect(h.get(name).opts.profile, name).toBeUndefined();
    }
  });

  it("marks the reads read-only and the provider move and the reset destructive", () => {
    const h = harness();
    for (const name of ["memory_shard_status", "memory_shard_search", "memory_shard_sources_list", "memory_shard_schedule_get", "memory_shard_provider_get"]) {
      expect(h.get(name).opts.readOnly, name).toBe(true);
    }
    for (const name of ["memory_shard_provider_set", "memory_shard_reset"]) {
      expect(h.get(name).opts.destructive, name).toBe(true);
      expect(h.get(name).opts.readOnly, name).toBe(false);
    }
  });

  it("says in every gated tool that confirm waits for the owner's yes", () => {
    const h = harness();
    for (const name of ["memory_shard_reindex", "memory_shard_provider_set", "memory_shard_reset"]) {
      expect(h.get(name).description, name).toMatch(/confirm: true/);
      expect(h.get(name).description, name).toMatch(/owner said yes/);
    }
  });
});

describe("memory_shard_reindex", () => {
  it("starts an incremental pass on its own, without confirm", async () => {
    routes({ [`POST ${BASE}/index`]: { accepted: true, run: { status: "running", mode: "incremental" } } });
    const out = await harness().call("memory_shard_reindex", { mode: "incremental", confirm: false });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const [path, opts] = sent();
    expect(path).toBe(`${BASE}/index`);
    expect(opts.method).toBe("POST");
    expect(opts.body).toEqual({ mode: "incremental" });
    expect(opts.onTimeout).toBeDefined();
    expect(out.text).toMatch(/Started an incremental indexing pass/);
    expect(out.text).toMatch(/Do not check it in a loop/);
  });

  it("answers a full pass without confirm with the route's estimate, and starts nothing", async () => {
    routes({ [`POST ${BASE}/index`]: refusal(409, { kind: "confirm_required", error: "A full reindex embeds every file again.", mode: "full", requested: "full", estimate: ESTIMATE, reasons: [{ code: "embedder_changed", mode: "full", detail: "The index was built by a different embedding model." }] }) });
    const out = await harness().call("memory_shard_reindex", { mode: "full", confirm: false });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(sent()[1].body).toEqual({ mode: "full" });
    expect(api).toHaveBeenCalledTimes(1);
    const r = JSON.parse(out.text) as Record<string, unknown>;
    expect(r).toMatchObject({ started: false, pass: "full", files: 140, passages: 3_400, time: "about 10–40 min", tokens: 1_020_000 });
    expect(String(r.embedding_cost)).toMatch(/ClawBox AI plan/);
    expect(r.reasons).toEqual([{ why: "embedder_changed", fixed_by: "full pass", detail: "The index was built by a different embedding model." }]);
    expect(String(r.next)).toMatch(/Nothing was done.*confirm: true only after they said yes/);
  });

  it("says when an incremental ask can only run in full, and gates it the same way", async () => {
    routes({ [`POST ${BASE}/index`]: refusal(409, { kind: "confirm_required", mode: "full", requested: "incremental", estimate: { ...ESTIMATE, minutes: null, basis: "nothing is indexed yet" } }) });
    const out = await harness().call("memory_shard_reindex", { mode: "incremental", confirm: false });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const r = JSON.parse(out.text) as Record<string, unknown>;
    expect(r.why_full).toMatch(/cannot be updated incrementally/);
    expect(r.time).toBe("unknown");
  });

  it("passes confirm: true through once the owner said yes", async () => {
    routes({ [`POST ${BASE}/index`]: { accepted: true, run: { status: "running", mode: "full" } } });
    const out = await harness().call("memory_shard_reindex", { mode: "full", confirm: true });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(sent()[1].body).toEqual({ mode: "full", confirm: true });
    expect(out.text).toMatch(/Started a full indexing pass/);
  });

  it("turns a pass already running, a switched-off box and an owner-only build into instructions", async () => {
    routes({ [`POST ${BASE}/index`]: refusal(409, { accepted: false, kind: "running", run: { status: "running" } }) });
    let out = await harness().call("memory_shard_reindex", { mode: "incremental" });
    expect(out.isError && out.error.code).toBe("CONFLICT");
    if (out.isError) expect(out.error.next).toMatch(/already running/);

    routes({ [`POST ${BASE}/index`]: refusal(409, { kind: "disabled", error: "Memory Shard is switched off." }) });
    out = await harness().call("memory_shard_reindex", { mode: "incremental" });
    expect(out.isError && out.error.next).toMatch(/memory_shard_enable/);

    // An older build that still keeps the routes to the owner, or a request
    // that carried no bearer: refused 403, said as the owner's to do.
    routes({ [`POST ${BASE}/index`]: refusal(403, { kind: "owner_only", error: "Starting an index run needs a signed-in browser session." }) });
    out = await harness().call("memory_shard_reindex", { mode: "incremental" });
    expect(out.isError && out.error.code).toBe("CONFLICT");
    if (out.isError) expect(out.error.next).toMatch(/keeps that to the owner\. Do not retry/);
  });

  it("refuses a mode or a confirm that is not one before anything is sent", () => {
    const h = harness();
    expect(parse(h, "memory_shard_reindex", { mode: "partial" }).success).toBe(false);
    expect(parse(h, "memory_shard_reindex", { mode: "full", confirm: "yes" }).success).toBe(false);
    expect(parse(h, "memory_shard_reindex", {}).success).toBe(true);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("memory_shard_reindex_stop", () => {
  it("stops the running pass through DELETE on the index route", async () => {
    routes({ [`DELETE ${BASE}/index`]: { stopped: true, run: { status: "running" } } });
    const out = await harness().call("memory_shard_reindex_stop", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/Stopping the indexing pass/);
    expect(out.text).toMatch(/carries on from there/);
  });

  it("says a stopped FULL pass is finished only by a new full one, behind the owner's yes", async () => {
    routes({ [`DELETE ${BASE}/index`]: { stopped: true, run: { status: "running", mode: "full" } } });
    const out = await harness().call("memory_shard_reindex_stop", {});
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(out.text).toMatch(/Stopping the full reindex/);
    expect(out.text).toMatch(/an incremental pass will not finish it/);
    expect(out.text).toMatch(/only a new full pass rebuilds the index, and that needs the owner's yes/);
    expect(out.text).not.toMatch(/carries on from there/);
  });

  it("says there is nothing to stop", async () => {
    routes({ [`DELETE ${BASE}/index`]: refusal(409, { kind: "not_running", error: "No indexing pass is running." }) });
    const out = await harness().call("memory_shard_reindex_stop", {});
    expect(out.isError && out.error.code).toBe("CONFLICT");
    if (out.isError) expect(out.error.next).toMatch(/nothing to stop/);
  });
});

describe("the folders", () => {
  it("lists the folders, and says so when there are none", async () => {
    routes({ [`GET ${BASE}/sources`]: { paths: ["/srv/files/Acme notes", "/srv/files/Globex"] } });
    let out = await harness().call("memory_shard_sources_list", {});
    expect(out.isError).toBe(false);
    if (!out.isError) expect(JSON.parse(out.text)).toEqual({ folders: ["/srv/files/Acme notes", "/srv/files/Globex"], count: 2 });

    routes({ [`GET ${BASE}/sources`]: { paths: [] } });
    out = await harness().call("memory_shard_sources_list", {});
    if (!out.isError) expect(out.text).toMatch(/no folders yet/);
  });

  it("adds a folder and says how many files a pass would read from it", async () => {
    routes({
      [`POST ${BASE}/sources`]: {
        paths: ["/srv/files/Acme notes"], folder: "/srv/files/Acme notes", added: true,
        wouldRead: { files: 12, markdown: 9, documents: 3, documentsOverCap: 0, complete: true },
      },
    });
    const out = await harness().call("memory_shard_sources_add", { path: " Acme notes " });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(sent()[1].body).toEqual({ path: "Acme notes" });
    expect(out.text).toMatch(/Added \/srv\/files\/Acme notes/);
    expect(out.text).toMatch(/A pass would read 12 file\(s\) from it \(9 markdown, 3 PDF or office documents/);
    expect(out.text).toMatch(/memory_shard_reindex \(incremental\)/);
  });

  it("says a count is a floor when the walk could not see everything, and an add twice is no error", async () => {
    routes({ [`POST ${BASE}/sources`]: { paths: ["/srv/files/Globex"], folder: "/srv/files/Globex", added: false, wouldRead: { files: 20_000, markdown: 20_000, documents: 0, complete: false } } });
    const out = await harness().call("memory_shard_sources_add", { path: "/srv/files/Globex" });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(out.text).toMatch(/already one of Memory Shard's folders/);
    expect(out.text).toMatch(/at least 20000 file/);
  });

  it("turns the picker's refusals into instructions", async () => {
    routes({ [`POST ${BASE}/sources`]: refusal(404, { kind: "not_found", error: "Folder not found." }) });
    let out = await harness().call("memory_shard_sources_add", { path: "/etc" });
    expect(out.isError && out.error.code).toBe("NOT_FOUND");
    if (out.isError) expect(out.error.next).toMatch(/inside the owner's Files/);

    routes({ [`POST ${BASE}/sources`]: refusal(400, { kind: "hidden", error: "Hidden folders are left out of Memory Shard." }) });
    out = await harness().call("memory_shard_sources_add", { path: ".cache" });
    expect(out.isError && out.error.code).toBe("BAD_ARGUMENT");
  });

  it("removes a listed folder by its listed path, and refuses one that is not listed", async () => {
    routes({ [`GET ${BASE}/sources`]: { paths: ["/srv/files/Acme notes", "/srv/files/Globex"] }, [`DELETE ${BASE}/sources`]: { paths: ["/srv/files/Globex"] } });
    let out = await harness().call("memory_shard_sources_remove", { path: "/srv/files/Acme notes/" });
    expect(out.isError).toBe(false);
    expect(sent(1)).toEqual([`${BASE}/sources`, expect.objectContaining({ method: "DELETE", body: { path: "/srv/files/Acme notes" } })]);
    if (!out.isError) expect(out.text).toMatch(/no longer indexes \/srv\/files\/Acme notes; 1 folder\(s\) left\. The files were not touched/);

    api.mockClear();
    out = await harness().call("memory_shard_sources_remove", { path: "/srv/files/Initech" });
    expect(out.isError && out.error.code).toBe("NOT_FOUND");
    if (out.isError) expect(out.error.next).toMatch(/\/srv\/files\/Globex/);
    expect(api.mock.calls.map((c) => (c[1] as { method?: string }).method)).toEqual(["GET"]);
  });

  it("refuses an empty or oversized path before anything is sent", () => {
    const h = harness();
    expect(parse(h, "memory_shard_sources_add", { path: "" }).success).toBe(false);
    expect(parse(h, "memory_shard_sources_remove", { path: "x".repeat(4097) }).success).toBe(false);
  });
});

describe("the schedule", () => {
  it("reads it in words", async () => {
    routes({ [`GET ${BASE}/schedule`]: { schedule: { enabled: true, frequency: "weekly", timeOfDay: "02:30", weekday: 3 }, nextRunAtMs: Date.UTC(2026, 9, 21, 2, 30) } });
    const out = await harness().call("memory_shard_schedule_get", {});
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(JSON.parse(out.text)).toMatchObject({ schedule: "every Wednesday at 02:30 (box time)", weekday: "wednesday", next_pass: "2026-10-21 02:30 UTC" });
  });

  it("lays a change over the schedule in force and saves the whole of it", async () => {
    routes({
      [`GET ${BASE}/schedule`]: { schedule: { enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 } },
      [`PUT ${BASE}/schedule`]: { schedule: { enabled: true, frequency: "weekly", timeOfDay: "03:00", weekday: 5 }, nextRunAtMs: Date.UTC(2026, 9, 23, 3, 0) },
    });
    const out = await harness().call("memory_shard_schedule_set", { frequency: "weekly", weekday: "friday" });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent(1)[1]).toMatchObject({ method: "PUT", body: { enabled: true, frequency: "weekly", timeOfDay: "03:00", weekday: 5 } });
    expect(out.text).toMatch(/every Friday at 03:00/);
  });

  it("answers a schedule that would start a first full build with its estimate, and saves it only with confirm", async () => {
    const current = { schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0 } };
    routes({
      [`GET ${BASE}/schedule`]: current,
      [`PUT ${BASE}/schedule`]: refusal(409, { kind: "confirm_required", mode: "full", requested: "schedule", estimate: ESTIMATE }),
    });
    let out = await harness().call("memory_shard_schedule_set", { enabled: true });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent(1)[1].body).toEqual({ enabled: true, frequency: "daily", timeOfDay: "03:00", weekday: 0 });
    expect(JSON.parse(out.text)).toMatchObject({ saved: false, files: 140, time: "about 10–40 min" });
    expect(out.text).toMatch(/no index to update yet/);

    api.mockClear();
    routes({ [`GET ${BASE}/schedule`]: current, [`PUT ${BASE}/schedule`]: { schedule: { ...current.schedule, enabled: true }, nextRunAtMs: 0 } });
    out = await harness().call("memory_shard_schedule_set", { enabled: true, confirm: true });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent(1)[1].body).toMatchObject({ enabled: true, confirm: true });
    expect(out.text).toMatch(/^Saved: Memory Shard refreshes every day at 03:00/);
  });

  it("refuses an empty change and a time that is not one", async () => {
    const out = await harness().call("memory_shard_schedule_set", {});
    expect(out.isError && out.error.code).toBe("BAD_ARGUMENT");
    expect(api).not.toHaveBeenCalled();
    const h = harness();
    expect(parse(h, "memory_shard_schedule_set", { time_of_day: "25:00" }).success).toBe(false);
    expect(parse(h, "memory_shard_schedule_set", { weekday: "someday" }).success).toBe(false);
  });
});

describe("the embedder", () => {
  const PROVIDER = { source: "local", recorded: true, cloudSupported: true, cloudAvailable: true, cloudReason: null, localInstalled: true };

  it("reads where the index is embedded", async () => {
    routes({ [`GET ${BASE}/provider`]: PROVIDER });
    const out = await harness().call("memory_shard_provider_get", {});
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(JSON.parse(out.text)).toMatchObject({ embedded: "the model on this box", cloud_on_offer: true, on_box_model_downloaded: true });
  });

  it("changes nothing when the index is already there", async () => {
    routes({ [`GET ${BASE}/provider`]: PROVIDER });
    const out = await harness().call("memory_shard_provider_set", { source: "local" });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(out.text).toMatch(/already embedded by the model on this box; nothing changed/);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("answers a move without confirm with the re-embed's estimate, and moves nothing", async () => {
    routes({
      [`GET ${BASE}/provider`]: PROVIDER,
      [`POST ${BASE}/provider`]: refusal(409, { kind: "confirm_required", from: "local", to: "cloud", model: "text-embedding-3-large", estimate: ESTIMATE }),
    });
    const out = await harness().call("memory_shard_provider_set", { source: "cloud", confirm: false });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent(1)[1].body).toEqual({ source: "cloud" });
    expect(api).toHaveBeenCalledTimes(2);
    expect(JSON.parse(out.text)).toMatchObject({ switched: false, from: "the model on this box", to: "the ClawBox AI cloud", model: "text-embedding-3-large", files: 140, time: "about 10–40 min" });
  });

  it("with the owner's yes, moves the index and starts the full pass the move needs", async () => {
    routes({
      [`GET ${BASE}/provider`]: PROVIDER,
      [`POST ${BASE}/provider`]: { source: "cloud", model: "text-embedding-3-large" },
      [`POST ${BASE}/index`]: { accepted: true, run: { status: "running", mode: "full" } },
    });
    const out = await harness().call("memory_shard_provider_set", { source: "cloud", confirm: true });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent(1)[1].body).toEqual({ source: "cloud", confirm: true });
    expect(sent(2)).toEqual([`${BASE}/index`, expect.objectContaining({ method: "POST", body: { mode: "full", confirm: true } })]);
    expect(out.text).toMatch(/now embedded by the ClawBox AI cloud \(text-embedding-3-large\)\. Started the full pass/);
  });

  it("says so when the move landed but its full pass could not start", async () => {
    routes({
      [`GET ${BASE}/provider`]: { ...PROVIDER, source: "cloud" },
      [`POST ${BASE}/provider`]: { source: "local", model: "qwen3-embedding-0.6b" },
      [`POST ${BASE}/index`]: refusal(409, { accepted: false, kind: "running" }),
    });
    const out = await harness().call("memory_shard_provider_set", { source: "local", confirm: true });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(out.text).toMatch(/now embedded by the model on this box/);
    expect(out.text).toMatch(/full pass it needs did not start: .*already running/);
  });

  it("turns an unavailable cloud and a model not downloaded into instructions", async () => {
    routes({ [`GET ${BASE}/provider`]: PROVIDER, [`POST ${BASE}/provider`]: refusal(409, { kind: "cloud_unavailable", error: "The ClawBox AI cloud model is not available on this box right now." }) });
    let out = await harness().call("memory_shard_provider_set", { source: "cloud", confirm: true });
    expect(out.isError && out.error.code).toBe("CONFLICT");

    routes({ [`GET ${BASE}/provider`]: { ...PROVIDER, source: "cloud", localInstalled: false }, [`POST ${BASE}/provider`]: refusal(409, { kind: "local_not_installed", error: "The embedding model for this box is not downloaded yet." }) });
    out = await harness().call("memory_shard_provider_set", { source: "local" });
    expect(out.isError && out.error.next).toMatch(/On this box/);
  });

  it("refuses a source that is not one", () => {
    expect(parse(harness(), "memory_shard_provider_set", { source: "elsewhere" }).success).toBe(false);
  });
});

describe("memory_shard_enable", () => {
  it("switches it on and off through the owner's switch route", async () => {
    routes({ [`POST ${BASE}/enable`]: { enabled: true, setupComplete: true } });
    let out = await harness().call("memory_shard_enable", { on: true });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent()[1].body).toEqual({ enabled: true });
    expect(out.text).toMatch(/Memory Shard is on/);

    routes({ [`POST ${BASE}/enable`]: { enabled: false, setupComplete: true } });
    out = await harness().call("memory_shard_enable", { on: false });
    if (!out.isError) expect(out.text).toMatch(/folders and the index are kept/);
  });

  it("answers switching on over a schedule that would start a first full build with its estimate", async () => {
    routes({ [`POST ${BASE}/enable`]: refusal(409, { kind: "confirm_required", mode: "full", requested: "schedule", estimate: ESTIMATE }) });
    let out = await harness().call("memory_shard_enable", { on: true });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent()[1].body).toEqual({ enabled: true });
    expect(JSON.parse(out.text)).toMatchObject({ switched_on: false, files: 140 });

    api.mockClear();
    routes({ [`POST ${BASE}/enable`]: { enabled: true, setupComplete: true } });
    out = await harness().call("memory_shard_enable", { on: true, confirm: true });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent()[1].body).toEqual({ enabled: true, confirm: true });
    expect(out.text).toMatch(/Memory Shard is on/);
  });

  it("says the paid plan is the owner's, in the gate's own words", async () => {
    routes({ [`POST ${BASE}/enable`]: refusal(402, { error: "paid_plan_required", code: "paid_plan_required", message: "Memory Shard needs ClawBox AI Pro or Max." }) });
    const out = await harness().call("memory_shard_enable", { on: true });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toBe("Memory Shard needs ClawBox AI Pro or Max.");
    expect(out.error.next).toMatch(/Settings → Providers; there is no tool for it/);
  });

  it("refuses a switch that is not a boolean", () => {
    expect(parse(harness(), "memory_shard_enable", { on: "yes" }).success).toBe(false);
    expect(parse(harness(), "memory_shard_enable", {}).success).toBe(false);
  });
});

describe("memory_shard_reset", () => {
  const WOULD = { clears: ["the Memory Shard switch", "the saved refresh schedule", "the record that setup was finished"], keeps: ["the folder list", "the index already built"] };

  it("without confirm answers exactly what would be cleared and kept, and resets nothing", async () => {
    routes({ [`POST ${BASE}/reset`]: refusal(409, { kind: "confirm_required", would: WOULD }) });
    const out = await harness().call("memory_shard_reset", { confirm: false });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent()[1].body).toEqual({});
    expect(JSON.parse(out.text)).toMatchObject({ reset: false, would_clear: WOULD.clears, keeps: WOULD.keeps });
  });

  it("with the owner's yes resets, and says what was cleared", async () => {
    routes({ [`POST ${BASE}/reset`]: { enabled: false, setupComplete: false, cleared: WOULD.clears, kept: WOULD.keeps } });
    const out = await harness().call("memory_shard_reset", { confirm: true });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(sent()[1].body).toEqual({ confirm: true });
    expect(JSON.parse(out.text)).toMatchObject({ reset: true, cleared: WOULD.clears, kept: WOULD.keeps });
  });
});

describe("memory_shard_search", () => {
  it("searches through the route with the query and the limit", async () => {
    apiGet.mockResolvedValue({ results: [{ path: "Acme notes/lease.md", snippet: "The deposit is two months.", score: 0.8 }] });
    const out = await harness().call("memory_shard_search", { query: "  deposit  ", limit: 3 });
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(apiGet).toHaveBeenCalledWith(`${BASE}/search`, expect.objectContaining({ query: { q: "deposit", limit: 3 } }));
    expect(JSON.parse(out.text).passages).toHaveLength(1);
  });

  it("says nothing matched rather than answering an empty list", async () => {
    apiGet.mockResolvedValue({ results: [] });
    const out = await harness().call("memory_shard_search", { query: "Initech", limit: 5 });
    if (!out.isError) expect(out.text).toMatch(/Nothing in the owner's indexed documents matched "Initech"/);
  });
});

describe("memory_shard_status explains why a reindex is wanted", () => {
  const STATUS = {
    available: true, enabled: true, setupComplete: true, health: "degraded", semanticAvailable: true, location: "local",
    sourceCount: 2, files: 120, chunks: 3_400, pendingFiles: 0, indexIdentity: "valid",
    run: { status: "succeeded", mode: "incremental" }, schedule: { enabled: false },
  };

  it("names a full reason, and keeps the full pass for the owner's go", async () => {
    apiGet.mockResolvedValue({
      ...STATUS,
      indexIdentity: "mismatched",
      reindex: { needed: true, mode: "full", reasons: [{ code: "embedder_changed", mode: "full", detail: "The index was built by a different embedding model." }] },
    });
    const out = await harness().call("memory_shard_status", {});
    if (out.isError) throw new Error(JSON.stringify(out.error));
    const s = JSON.parse(out.text) as Record<string, unknown>;
    expect(s.needs_reindex).toBe(true);
    expect(s.reindex).toEqual({ pass: "full", reasons: [{ why: "embedder_changed", fixed_by: "full pass", detail: "The index was built by a different embedding model." }] });
    expect(String(s.guidance)).toMatch(/needs a FULL pass/);
    expect(String(s.guidance)).toMatch(/starts it only with confirm: true after they said yes/);
  });

  it("sends the assistant to start an incremental pass itself when that is what fixes it", async () => {
    apiGet.mockResolvedValue({
      ...STATUS,
      pendingFiles: 7,
      reindex: { needed: true, mode: "incremental", reasons: [{ code: "files_waiting", mode: "incremental", detail: "7 files in the folders are not in the index yet." }] },
    });
    const out = await harness().call("memory_shard_status", {});
    if (out.isError) throw new Error(JSON.stringify(out.error));
    const s = JSON.parse(out.text) as Record<string, unknown>;
    expect(s.files_waiting).toBe(7);
    expect(String(s.guidance)).toMatch(/start it yourself with memory_shard_reindex \(mode incremental\)/);
    expect(String(s.guidance)).not.toMatch(/FULL pass/);
  });

  it("reads an older build's bare needs-reindex facts the way it always did", async () => {
    apiGet.mockResolvedValue({ ...STATUS, indexIdentity: "mismatched" });
    const out = await harness().call("memory_shard_status", {});
    if (out.isError) throw new Error(JSON.stringify(out.error));
    const s = JSON.parse(out.text) as Record<string, unknown>;
    expect(s.needs_reindex).toBe(true);
    expect(s.reindex).toBeUndefined();
  });

  it("offers the stop while a pass runs", async () => {
    apiGet.mockResolvedValue({ ...STATUS, run: { status: "running", mode: "full", progress: { filesDone: 3, filesTotal: 12, chunks: 40 } } });
    const out = await harness().call("memory_shard_status", {});
    if (out.isError) throw new Error(JSON.stringify(out.error));
    expect(out.text).toMatch(/memory_shard_reindex_stop stops it/);
    expect(out.text).toMatch(/3 of 12 files \(25%\)/);
  });
});
