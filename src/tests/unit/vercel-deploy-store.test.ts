/**
 * What this box deployed, the owner's standing permission for the assistant,
 * and the rate limit that bounds it.
 *
 * The properties that carry it:
 *
 *  1. THE AUTO-PRODUCTION SWITCH IS OFF UNLESS THE OWNER TURNED IT ON FOR THAT
 *     PROJECT. Off when absent, off when the stored value is anything other
 *     than an explicit `true`, and per project — so "the assistant may ship the
 *     toy site by itself" never also means "and the shop".
 *  2. THE RATE LIMIT SURVIVES A RESTART. It bounds what the agent can spend
 *     unasked; a counter in the web server's memory would be handed back in
 *     full by one `systemctl restart`, and a loop that kept failing would get
 *     its whole allowance again each time.
 *  3. A POLL THAT COMES HOME LATE CANNOT WRITE THE OLD BUILD'S VERDICT OVER
 *     THE NEW BUILD'S RECORD.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDeploy } from "@/lib/vercel-state";

const configGet = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());

let saved: Record<string, unknown> = {};
let store: typeof import("@/lib/vercel-deploy-store");

function deploy(over: Partial<ProjectDeploy> = {}): ProjectDeploy {
  return {
    target: "preview",
    phase: "building",
    readyState: "queued",
    projectId: "prj_acme",
    teamId: null,
    deploymentId: "dpl_1",
    url: null,
    inspectorUrl: null,
    source: "files",
    gitRef: null,
    fileCount: 3,
    by: "owner",
    runId: null,
    startedAt: 1_000,
    endedAt: null,
    detail: null,
    ...over,
  };
}

beforeEach(async () => {
  saved = {};
  vi.resetModules();
  configGet.mockReset().mockImplementation(async (key: string) => saved[key]);
  configSet.mockReset().mockImplementation(async (key: string, value: unknown) => { saved[key] = value; });
  vi.doMock("@/lib/config-store", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/config-store")>()),
    get: configGet,
    set: configSet,
  }));
  store = await import("@/lib/vercel-deploy-store");
});

afterEach(() => { vi.doUnmock("@/lib/config-store"); });

describe("the record of what was deployed", () => {
  it("keeps the last deployment per project and answers it back", async () => {
    await store.recordProjectDeploy("shop", deploy());
    expect((await store.readProjectDeploy("shop"))?.latest).toMatchObject({ deploymentId: "dpl_1", by: "owner" });
    expect(await store.readProjectDeploy("other")).toBeNull();
  });

  it("records WHO asked — after the fact there is no other way to tell", async () => {
    await store.recordProjectDeploy("shop", deploy({ by: "agent", target: "production" }));
    expect((await store.readProjectDeploy("shop"))?.latest.by).toBe("agent");
  });

  it("writes what a poll learned onto the deployment it was told about", async () => {
    await store.recordProjectDeploy("shop", deploy());
    const after = await store.updateProjectDeploy("shop", "dpl_1", { phase: "ready", url: "https://a.example", endedAt: 9 });
    expect(after?.latest).toMatchObject({ phase: "ready", url: "https://a.example", endedAt: 9 });
  });

  it("refuses a poll about a deployment that is no longer the current one", async () => {
    await store.recordProjectDeploy("shop", deploy({ deploymentId: "dpl_2", startedAt: 2_000 }));
    // The first build's verdict, arriving after the owner pressed Deploy again.
    expect(await store.updateProjectDeploy("shop", "dpl_1", { phase: "failed" })).toBeNull();
    expect((await store.readProjectDeploy("shop"))?.latest.phase).toBe("building");
  });

  it("reads a malformed entry as no record rather than taking the page down", async () => {
    saved[store.VERCEL_DEPLOYS_CONFIG_KEY] = { shop: { latest: { nonsense: true }, productionAt: [] }, other: { latest: deploy(), productionAt: [] } };
    expect(await store.readProjectDeploy("shop")).toBeNull();
    expect(await store.readProjectDeploy("other")).not.toBeNull();
  });

  it("has no prototype to poison — a project id can spell __proto__", async () => {
    await store.recordProjectDeploy("shop", deploy());
    // An inherited value is not a record, and must not be answered as one.
    expect(await store.readProjectDeploy("__proto__")).toBeNull();
    expect(await store.readProjectDeploy("constructor")).toBeNull();
  });
});

describe("the owner's standing permission for the assistant", () => {
  it("is off when absent", async () => {
    expect(await store.readAutoProduction("shop")).toBe(false);
  });

  it("is off for anything that is not an explicit true", async () => {
    for (const value of ["true", 1, {}, null]) {
      saved[store.VERCEL_AUTO_PRODUCTION_CONFIG_KEY] = { shop: value };
      expect(await store.readAutoProduction("shop"), JSON.stringify(value)).toBe(false);
    }
  });

  it("is per project — turning it on for one leaves the next one off", async () => {
    await store.setAutoProduction("toy-site", true);
    expect(await store.readAutoProduction("toy-site")).toBe(true);
    expect(await store.readAutoProduction("shop")).toBe(false);
  });

  it("keeps only the trues, so the map cannot grow a row per project ever looked at", async () => {
    await store.setAutoProduction("a", true);
    await store.setAutoProduction("b", false);
    await store.setAutoProduction("a", false);
    expect(saved[store.VERCEL_AUTO_PRODUCTION_CONFIG_KEY]).toEqual({});
  });
});

describe("the production rate limit", () => {
  it("counts production deploys and not previews", async () => {
    const now = Date.now();
    await store.recordProjectDeploy("shop", deploy({ target: "preview", startedAt: now }));
    expect(store.productionAllowance(await store.readProjectDeploy("shop"), now).left).toBe(store.MAX_PRODUCTION_DEPLOYS);
    await store.recordProjectDeploy("shop", deploy({ target: "production", startedAt: now, deploymentId: "dpl_2" }));
    expect(store.productionAllowance(await store.readProjectDeploy("shop"), now).left).toBe(store.MAX_PRODUCTION_DEPLOYS - 1);
  });

  it("runs out, and says when the next one is possible", async () => {
    const now = Date.now();
    for (let i = 0; i < store.MAX_PRODUCTION_DEPLOYS; i++) {
      await store.recordProjectDeploy("shop", deploy({ target: "production", startedAt: now, deploymentId: `dpl_${i}` }));
    }
    const allowance = store.productionAllowance(await store.readProjectDeploy("shop"), now);
    expect(allowance.left).toBe(0);
    expect(allowance.nextAt).toBe(now + store.PRODUCTION_WINDOW_MS);
  });

  it("is a WINDOW, not a total — yesterday's deploys are not held against today's", async () => {
    const now = Date.now();
    const old = now - store.PRODUCTION_WINDOW_MS - 1;
    for (let i = 0; i < store.MAX_PRODUCTION_DEPLOYS; i++) {
      await store.recordProjectDeploy("shop", deploy({ target: "production", startedAt: old, deploymentId: `dpl_${i}` }));
    }
    expect(store.productionAllowance(await store.readProjectDeploy("shop"), now).left).toBe(store.MAX_PRODUCTION_DEPLOYS);
  });

  it("is on DISK, so a restart does not hand the allowance back", async () => {
    const now = Date.now();
    await store.recordProjectDeploy("shop", deploy({ target: "production", startedAt: now }));
    // A fresh module graph is what a restarted web server has.
    vi.resetModules();
    const restarted = await import("@/lib/vercel-deploy-store");
    expect(restarted.productionAllowance(await restarted.readProjectDeploy("shop"), now).left)
      .toBe(store.MAX_PRODUCTION_DEPLOYS - 1);
  });
});

describe("a fresh record", () => {
  it("is never `ready` on a deployment Vercel has only just queued", async () => {
    const fresh = store.newProjectDeploy({
      target: "preview", projectId: "p", teamId: null, deploymentId: "dpl_1", readyState: "queued",
      url: null, inspectorUrl: null, source: "files", gitRef: null, fileCount: 2, by: "owner", runId: null,
    });
    expect(fresh.phase).toBe("building");
    expect(fresh.endedAt).toBeNull();
  });
});
