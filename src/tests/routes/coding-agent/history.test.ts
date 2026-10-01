/**
 * The run-history routes (TASK-1178) against the real store in a temp root:
 *
 *  - GET /setup-api/coding-agent/history — the settings card's summary, the
 *    archive's pages and one archived run; DELETE ?view=archive — owner-only.
 *  - GET /setup-api/coding-agent/history/export — owner-only, a real .zip.
 *  - GET /setup-api/coding-agent/history/file — an archived run's evidence,
 *    under the artifacts route's rules.
 *  - GET /setup-api/coding-agent/runs?history=1 — the older runs' pages.
 *  - POST /setup-api/coding-agent/enable { historyRetention, historyLimit }.
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
let fileRoute: typeof import("@/app/setup-api/coding-agent/history/file/route");
let runsRoute: typeof import("@/app/setup-api/coding-agent/runs/route");
let enableRoute: typeof import("@/app/setup-api/coding-agent/enable/route");

const url = (p: string) => `http://localhost/setup-api/coding-agent/${p}`;
const asOwner = (p: string, init: RequestInit = {}) => new Request(url(p), { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Cookie: session.cookie } });
const asAgent = (p: string, init: RequestInit = {}) => new Request(url(p), { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${MCP_TOKEN}` } });

function archived(id: string, startedAt = 1_000) {
  const evidence = path.join(data, "coding-agent-artifacts", id);
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "shot.png"), "\x89PNG fake");
  fs.writeFileSync(path.join(evidence, "page.html"), "<script>alert(1)</script>");
  return history.archiveRun(
    { id, task: `Archived ${id}`, status: "completed", startedAt, completedAt: startedAt + 1, directory: "/home/x/Projects/site" },
    { evidenceDir: evidence, inputsDir: null, streamLog: null, stderrLog: null, transcript: null },
    "trimmed",
  )!;
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
  fileRoute = await import("@/app/setup-api/coding-agent/history/file/route");
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
    archived("run-aaaaaaa1");
    const res = await historyRoute.GET(asOwner("history"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "standard",
      limit: 100,
      limits: [100, 300, 1000],
      liveKept: 30,
      counts: { live: 0, older: 0, archived: 1 },
      disk: { minFreeBytes: 2 * 1024 ** 3 },
    });
    expect(body.usage.archive).toBeGreaterThan(0);
    expect(body.usage.total).toBeGreaterThanOrEqual(body.usage.archive);
    expect(typeof body.disk.low).toBe("boolean");
    expect(body.transcripts.map((t: { label: string }) => t.label)).toEqual(["~/.claude-ds/settings.json", "~/.claude/settings.json"]);
  });

  it("pages the archive, answers one archived run, and a JSON 404 for one it does not hold", async () => {
    archived("run-aaaaaaa1", 1_000);
    archived("run-aaaaaaa2", 2_000);
    archived("run-aaaaaaa3", 3_000);
    const page = await (await historyRoute.GET(asAgent("history?view=archive&offset=1&limit=1"))).json();
    expect(page).toMatchObject({ total: 3, offset: 1, entries: [{ id: "run-aaaaaaa2", title: "Archived run-aaaaaaa2" }] });
    const one = await historyRoute.GET(asOwner("history?view=archive&id=run-aaaaaaa3"));
    expect((await one.json()).run).toMatchObject({ entry: { id: "run-aaaaaaa3" }, record: { task: "Archived run-aaaaaaa3" } });
    const missing = await historyRoute.GET(asOwner("history?view=archive&id=run-zzzzzzzz"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ kind: "not_found" });
  });
});

describe("DELETE history", () => {
  it("refuses the agent's bearer and a request that does not name the archive", async () => {
    archived("run-aaaaaaa1");
    const agent = await historyRoute.DELETE(asAgent("history?view=archive", { method: "DELETE" }));
    expect(agent.status).toBe(403);
    expect(await agent.json()).toMatchObject({ kind: "owner_only" });
    const bare = await historyRoute.DELETE(asOwner("history", { method: "DELETE" }));
    expect(bare.status).toBe(400);
    expect(history.archiveIndex()).toHaveLength(1);
  });

  it("clears the archive for the owner", async () => {
    archived("run-aaaaaaa1");
    archived("run-aaaaaaa2");
    const res = await historyRoute.DELETE(asOwner("history?view=archive", { method: "DELETE" }));
    expect(await res.json()).toEqual({ cleared: 2 });
    expect(fs.existsSync(path.join(data, "coding-agent-archive"))).toBe(false);
  });
});

describe("GET history/export", () => {
  it("is the owner's alone", async () => {
    const res = await exportRoute.GET(asAgent("history/export"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
  });

  it("streams one archived run as a zip, and 404s one it does not hold", async () => {
    archived("run-aaaaaaa1");
    const res = await exportRoute.GET(asOwner("history/export?runId=run-aaaaaaa1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="clawbox-run-aaaaaaa1.zip"');
    const names = unzip(Buffer.from(await res.arrayBuffer())).map((e) => e.name).sort();
    expect(names).toEqual(["run-aaaaaaa1/archive.json", "run-aaaaaaa1/evidence/page.html", "run-aaaaaaa1/evidence/shot.png", "run-aaaaaaa1/run.json"]);
    expect((await exportRoute.GET(asOwner("history/export?runId=run-zzzzzzzz"))).status).toBe(404);
    expect((await exportRoute.GET(asOwner("history/export?runId=../../config"))).status).toBe(404);
  });

  it("streams the whole history, live list and archive, under one manifest", async () => {
    archived("run-aaaaaaa1");
    const live = { id: "run-bbbbbbb1", task: "live one", directory: "/home/x/Projects/site", status: "completed", startedAt: 5_000 };
    fs.writeFileSync(path.join(data, "coding-agent-runs.json"), JSON.stringify([live]));
    fs.mkdirSync(path.join(data, "coding-agent-artifacts", live.id), { recursive: true });
    fs.writeFileSync(path.join(data, "coding-agent-artifacts", live.id, "report.md"), "# Report");
    const res = await exportRoute.GET(asOwner("history/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="clawbox-run-history-\d{4}-\d{2}-\d{2}\.zip"$/);
    const entries = unzip(Buffer.from(await res.arrayBuffer()));
    const byName = new Map(entries.map((e) => [e.name, e.data.toString()]));
    expect(JSON.parse(byName.get("manifest.json")!)).toMatchObject({ kind: "clawbox-run-history", retention: "standard", runs: 1, archivedRuns: 1 });
    expect(JSON.parse(byName.get("runs.json")!)[0]).toMatchObject({ id: live.id, task: "live one" });
    expect(byName.get(`evidence/${live.id}/report.md`)).toBe("# Report");
    expect(byName.has("archive/run-aaaaaaa1/run.json")).toBe(true);
  });
});

describe("GET history/file", () => {
  it("serves a picture inline and anything else as plain text, and nothing outside the bundle", async () => {
    archived("run-aaaaaaa1");
    const png = await fileRoute.GET(asOwner("history/file?runId=run-aaaaaaa1&file=shot.png"));
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    const html = await fileRoute.GET(asOwner("history/file?runId=run-aaaaaaa1&file=page.html"));
    expect(html.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await html.text()).toBe("<script>alert(1)</script>");
    for (const bad of ["../run.json", "..%2Frun.json", ".hidden", "nope.png"]) {
      expect((await fileRoute.GET(asOwner(`history/file?runId=run-aaaaaaa1&file=${bad}`))).status, bad).toBe(404);
    }
    expect((await fileRoute.GET(asOwner("history/file?runId=../x&file=shot.png"))).status).toBe(404);
  });
});

describe("GET runs?history=1", () => {
  it("pages the older runs with a total", async () => {
    for (let i = 1; i <= 3; i += 1) {
      history.writeOlderRun({ id: `run-cccccc0${i}`, task: `older ${i}`, directory: "/home/x/Projects/site", status: "completed", startedAt: i * 1000 } as never);
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

describe("POST enable { historyRetention, historyLimit }", () => {
  const post = (body: unknown, owner = true) => enableRoute.POST((owner ? asOwner : asAgent)("enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  it("saves the mode and the limit and answers the status carrying them", async () => {
    const res = await post({ historyRetention: "extended", historyLimit: 300 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ historyRetention: "extended", historyLimit: 300, historyLimits: [100, 300, 1000], historyLiveKept: 30 });
    const cfg = JSON.parse(fs.readFileSync(path.join(data, "config.json"), "utf-8"));
    expect(cfg).toMatchObject({ coding_agent_history_retention: "extended", coding_agent_history_limit: 300 });
  });

  it("refuses a value the box does not offer before saving anything, and the agent's bearer", async () => {
    for (const body of [{ historyRetention: "forever" }, { historyRetention: 3 }, { historyLimit: 50 }, { historyRetention: "extended", historyLimit: "300" }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).kind).toBe("invalid");
    }
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
