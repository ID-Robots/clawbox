/**
 * The run-history routes (TASK-1178) against the real store in a temp root:
 *
 *  - GET /setup-api/coding-agent/history — the settings card's summary.
 *  - GET /setup-api/coding-agent/history/export — owner-only, a real .zip.
 *  - GET /setup-api/coding-agent/runs?history=1 — the older runs' pages.
 *  - POST /setup-api/coding-agent/enable { historyRetention }.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";
import { unzip } from "@/tests/helpers/unzip";

vi.mock("@/lib/coding-agent-mcp-refresh", () => ({ refreshCodingAgentToolsIfChanged: vi.fn(async () => undefined) }));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

let session: SessionFixture;
let restore: () => void;
let home: string;
let data: string;
let history: typeof import("@/lib/coding-run-history");
let historyRoute: typeof import("@/app/setup-api/coding-agent/history/route");
let exportRoute: typeof import("@/app/setup-api/coding-agent/history/export/route");
let runsRoute: typeof import("@/app/setup-api/coding-agent/runs/route");
let enableRoute: typeof import("@/app/setup-api/coding-agent/enable/route");

const url = (p: string) => `http://localhost/setup-api/coding-agent/${p}`;
const asOwner = (p: string, init: RequestInit = {}) => new Request(url(p), { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Cookie: session.cookie } });
const asAgent = (p: string, init: RequestInit = {}) => new Request(url(p), { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${MCP_TOKEN}` } });

/** An older run "keep everything" kept, with one evidence file. */
function older(id: string, startedAt = 1_000) {
  const evidence = path.join(data, "coding-agent-artifacts", id);
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "shot.png"), "\x89PNG fake");
  expect(history.writeOlderRun({ id, task: `Older ${id}`, status: "completed", startedAt, completedAt: startedAt + 1, directory: "/home/x/Projects/site" })).toBe(true); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN", "HOME", "CLAUDE_DS_CONFIG_DIR");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "history-route-home-"));
  process.env.HOME = home;
  delete process.env.CLAUDE_DS_CONFIG_DIR;
  data = path.join(session.root, "data");
  vi.resetModules();
  history = await import("@/lib/coding-run-history");
  history.invalidateUsage();
  historyRoute = await import("@/app/setup-api/coding-agent/history/route");
  exportRoute = await import("@/app/setup-api/coding-agent/history/export/route");
  runsRoute = await import("@/app/setup-api/coding-agent/runs/route");
  enableRoute = await import("@/app/setup-api/coding-agent/enable/route");
});

afterEach(async () => {
  const lib = await import("@/lib/coding-agent");
  await lib._resetCodingAgentStateForTests();
  session.cleanup();
  restore();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(session.root, { recursive: true, force: true });
});

describe("GET history", () => {
  it("answers the card's summary: the mode, the counts, the weight, the disk and the transcript period", async () => {
    older("run-aaaaaaa1");
    const res = await historyRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "standard",
      liveKept: 30,
      counts: { live: 0, older: 1 },
      disk: { minFreeBytes: 2 * 1024 ** 3 },
    });
    // The extended N and the archive went with their modes (SCA2 C1).
    for (const gone of ["limit", "limits"]) expect(body[gone], gone).toBeUndefined();
    expect(body.counts.archived).toBeUndefined();
    expect(body.usage.archive).toBeUndefined();
    expect(body.usage.olderRuns).toBeGreaterThan(0);
    expect(body.usage.total).toBeGreaterThanOrEqual(body.usage.olderRuns + body.usage.evidence);
    expect(typeof body.disk.low).toBe("boolean");
    expect(body.transcripts.map((t: { label: string }) => t.label)).toEqual(["~/.claude-ds/settings.json", "~/.claude/settings.json"]);
  });

  it("has no archive to page or clear any more", () => {
    expect((historyRoute as Record<string, unknown>).DELETE).toBeUndefined();
  });
});

describe("GET history/export", () => {
  it("is the owner's alone", async () => {
    const res = await exportRoute.GET(asAgent("history/export"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
  });

  it("streams the whole history — the live list and the older runs — under one manifest, and nothing per run", async () => {
    older("run-aaaaaaa1");
    const live = { id: "run-bbbbbbb1", task: "live one", directory: "/home/x/Projects/site", status: "completed", startedAt: 5_000 }; // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    fs.writeFileSync(path.join(data, "coding-agent-runs.json"), JSON.stringify([live]));
    fs.mkdirSync(path.join(data, "coding-agent-artifacts", live.id), { recursive: true });
    fs.writeFileSync(path.join(data, "coding-agent-artifacts", live.id, "report.md"), "# Report");
    const res = await exportRoute.GET(asOwner("history/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="clawbox-run-history-\d{4}-\d{2}-\d{2}\.zip"$/);
    const entries = unzip(Buffer.from(await res.arrayBuffer()));
    const byName = new Map(entries.map((e) => [e.name, e.data.toString()]));
    const manifest = JSON.parse(byName.get("manifest.json")!);
    expect(manifest).toMatchObject({ kind: "clawbox-run-history", retention: "standard", runs: 1, olderRuns: 1 });
    expect(manifest.archivedRuns).toBeUndefined();
    expect(JSON.parse(byName.get("runs.json")!)[0]).toMatchObject({ id: live.id, task: "live one" });
    expect(byName.get(`evidence/${live.id}/report.md`)).toBe("# Report");
    expect(byName.has("older-runs/run-aaaaaaa1.json")).toBe(true);
    expect(byName.has("evidence/run-aaaaaaa1/shot.png")).toBe(true);
    // The per-run zip went with the archive: `?runId=` is the whole export too.
    const perRun = await exportRoute.GET(asOwner("history/export?runId=run-aaaaaaa1"));
    expect(perRun.headers.get("content-disposition")).toMatch(/clawbox-run-history-/);
  });
});

describe("GET runs?history=1", () => {
  it("pages the older runs with a total", async () => {
    for (let i = 1; i <= 3; i += 1) {
      history.writeOlderRun({ id: `run-cccccc0${i}`, task: `older ${i}`, directory: "/home/x/Projects/site", status: "completed", startedAt: i * 1000 } as never); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    }
    const res = await runsRoute.GET(asAgent("runs?history=1&offset=1&limit=1"));
    const body = await res.json();
    expect(body).toMatchObject({ total: 3, offset: 1 });
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual(["run-cccccc02"]);
    expect(body.runs[0]).toHaveProperty("transcriptPath");
    // An older run is found by id like any other.
    const one = await runsRoute.GET(asAgent("runs?id=run-cccccc01"));
    expect((await one.json()).run).toMatchObject({ id: "run-cccccc01", task: "older 1" });
  });
});

describe("POST enable { historyRetention }", () => {
  const post = (body: unknown, owner = true) => enableRoute.POST((owner ? asOwner : asAgent)("enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  it("saves the mode and answers the status carrying it, with no extended N", async () => {
    const res = await post({ historyRetention: "everything" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ historyRetention: "everything", historyLiveKept: 30 });
    // The N went with its mode (SCA2 C1), its choices before it (SCA C3).
    expect(body.historyLimit).toBeUndefined();
    expect(body.historyLimits).toBeUndefined();
    const cfg = JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf-8"));
    expect(cfg).toMatchObject({ coding_agent_history_retention: "everything" });
    expect(cfg.coding_agent_history_limit).toBeUndefined();
  });

  it("refuses a value the box does not offer — the retired modes included — before saving anything, the N it no longer takes, and the agent's bearer", async () => {
    for (const body of [{ historyRetention: "forever" }, { historyRetention: 3 }, { historyRetention: "extended" }, { historyRetention: "archive" }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).kind).toBe("invalid");
    }
    // A body about the N alone is a body the route does not know (400, no
    // kind); one that carries it beside a mode saves the mode and ignores it.
    expect((await post({ historyLimit: 300 })).status).toBe(400);
    expect((await post({ historyRetention: "everything" }, false)).status).toBe(403);
    const cfg = JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf-8"));
    expect(cfg.coding_agent_history_retention).toBeUndefined();
    expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("keeps Claude Code's transcripts under everything, merged into its settings", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    expect((await post({ historyRetention: "everything" })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"))).toEqual({ permissions: { allow: ["Bash(ls)"] }, cleanupPeriodDays: 36_500 });
    expect((await post({ historyRetention: "standard" })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"))).toEqual({ permissions: { allow: ["Bash(ls)"] } });
  });
});
