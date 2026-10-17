/**
 * The search index size limit through the routes: the settings route saves
 * `search.indexLimitMb` and, only when it changed, has the index re-plan to
 * it; the status route shows the index's MB used against the limit, its
 * chunks and its capped pages. The index itself is stubbed (it embeds; it is
 * pinned in prime-radiant-shard-index.test.ts).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/route-auth", () => auth);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn(async () => true) }));
vi.mock("@/lib/owner-session", () => owner);
vi.mock("@/lib/mcp-token", () => ({ verifyMcpBearer: (h: string | null) => h === "Bearer test-assistant-bearer" }));
vi.mock("@/lib/prime-radiant/opus-source", () => ({ detectOpusSource: async () => ({ source: "none" }) }));
vi.mock("@/lib/prime-radiant/nightly-scheduler", () => ({ nextRunAtMs: () => null, refresh: async () => undefined }));
const MB = 1024 * 1024;
const shard = vi.hoisted(() => ({
  vaultIndexLimitChanged: vi.fn(async () => null),
  vaultIndexStatus: vi.fn(async () => ({
    exists: true, pages: 1200, chunks: 41_000, identity: "valid", needsFullScan: true, builtAt: 1, withoutPageVector: 3,
    usedBytes: 41_000 * 1029, limitBytes: 160 * 1024 * 1024, maxChunks: 163_047, cappedPages: 3, migrationPending: false,
  })),
}));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);

import { GET as settingsGET, PUT as settingsPUT } from "@/app/setup-api/prime-radiant/settings/route";
import { GET as statusGET } from "@/app/setup-api/prime-radiant/status/route";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-index-limit-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

const ORIGIN = "http://clawbox.local";
const API = `${ORIGIN}/setup-api/prime-radiant`;

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${API}${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
  });
}

/** The re-plan is queued without being awaited: let it start. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  shard.vaultIndexLimitChanged.mockClear();
  owner.hasPersonSession.mockResolvedValue(true);
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the settings route", () => {
  it("answers the limit with its default and bounds", async () => {
    const get = await (await settingsGET(req("GET", "/settings"))).json();
    expect(get.settings.search).toEqual({ indexLimitMb: 160 });
    expect(get.defaults.search).toEqual({ indexLimitMb: 160 });
    expect(get.limits.searchIndexLimitMb).toEqual({ min: 32, max: 4096 });
  });

  it("saves a new limit and has the index re-plan to it — only when it changed", async () => {
    const saved = await settingsPUT(req("PUT", "/settings", { search: { indexLimitMb: 512 } }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings.search).toEqual({ indexLimitMb: 512 });
    await settle();
    expect(shard.vaultIndexLimitChanged).toHaveBeenCalledTimes(1);

    // The same value again, or another section: no re-plan.
    await settingsPUT(req("PUT", "/settings", { search: { indexLimitMb: 512 } }));
    await settingsPUT(req("PUT", "/settings", { nightly: { time: "02:15" } }));
    await settle();
    expect(shard.vaultIndexLimitChanged).toHaveBeenCalledTimes(1);

    // Back to the default (null): a change, so a re-plan.
    const reset = await settingsPUT(req("PUT", "/settings", { search: { indexLimitMb: null } }));
    expect((await reset.json()).settings.search).toEqual({ indexLimitMb: 160 });
    await settle();
    expect(shard.vaultIndexLimitChanged).toHaveBeenCalledTimes(2);
  });

  it("lets the assistant change it through the MCP bearer", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    const saved = await settingsPUT(req("PUT", "/settings", { search: { indexLimitMb: 64 } }, { authorization: "Bearer test-assistant-bearer" }));
    expect(saved.status).toBe(200);
    await settle();
    expect(shard.vaultIndexLimitChanged).toHaveBeenCalledTimes(1);
  });

  it("refuses a bad limit whole, saves nothing and re-plans nothing", async () => {
    await settingsPUT(req("PUT", "/settings", { search: { indexLimitMb: 256 } }));
    await settle();
    shard.vaultIndexLimitChanged.mockClear();
    for (const bad of [{ search: { indexLimitMb: 16 } }, { search: { indexLimitMb: 5000 } }, { search: { indexLimitMb: 64.5 } }, { search: { indexLimitMb: "64" } }, { search: { limit: 64 } }]) {
      const res = await settingsPUT(req("PUT", "/settings", bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).code).toBe("invalid");
    }
    await settle();
    expect(shard.vaultIndexLimitChanged).not.toHaveBeenCalled();
    expect((await (await settingsGET(req("GET", "/settings"))).json()).settings.search).toEqual({ indexLimitMb: 256 });
  });
});

describe("the status route", () => {
  it("shows the index's MB used against the limit, its chunks and its capped pages", async () => {
    const body = await (await statusGET(req("GET", "/status"))).json();
    expect(body.index).toEqual({
      exists: true,
      usedMb: Math.round(((41_000 * 1029) / MB) * 10) / 10,
      limitMb: 160,
      chunks: 41_000,
      maxChunks: 163_047,
      pages: 1200,
      cappedPages: 3,
      withoutPageVector: 3,
      needsFullScan: true,
      migrationPending: false,
    });
    expect(body.initialised).toBe(false);
  });

  it("still answers when the index cannot be read", async () => {
    shard.vaultIndexStatus.mockRejectedValueOnce(new Error("disk"));
    const res = await statusGET(req("GET", "/status"));
    expect(res.status).toBe(200);
    expect((await res.json()).index).toBeNull();
  });
});
