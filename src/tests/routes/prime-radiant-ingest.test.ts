/**
 * POST/GET /setup-api/prime-radiant/ingest, GET ingest/<id>/events (SSE),
 * POST ingest/upload and POST ingest/preview, over a real vault in a tmp dir with the model replaced
 * through the client override. The writes are the owner's cookie or the
 * assistant's MCP bearer, never another site (the drop stays the owner's);
 * folders and named files come from the Files tree only; the GETs never
 * create anything.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn(async () => true) }));
vi.mock("@/lib/owner-session", () => owner);
const creds = vi.hoisted(() => ({
  resolveClawaiToken: vi.fn(async (): Promise<string | null> => null),
  clawaiCredentialGeneration: vi.fn(() => 0),
  noteClawaiCredentialRefused: vi.fn(async () => undefined),
  proxyRefusedClawaiCredential: vi.fn(async () => false),
}));
vi.mock("@/lib/harness/credentials", () => creds);
const bearer = vi.hoisted(() => ({ verifyMcpBearer: vi.fn((h: string | null) => h === "Bearer test-assistant-bearer") }));
vi.mock("@/lib/mcp-token", () => bearer);
/** The MCP server's headers: the bearer and no Origin (it is no browser). */
const ASSISTANT = { authorization: "Bearer test-assistant-bearer", origin: "" };

import { GET as listGET, POST as ingestPOST } from "@/app/setup-api/prime-radiant/ingest/route";
import { GET as eventsGET } from "@/app/setup-api/prime-radiant/ingest/[id]/events/route";
import { DELETE as jobDELETE, GET as jobGET } from "@/app/setup-api/prime-radiant/ingest/[id]/route";
import { POST as retryPOST } from "@/app/setup-api/prime-radiant/ingest/[id]/retry/route";
import { POST as uploadPOST } from "@/app/setup-api/prime-radiant/ingest/upload/route";
import { POST as previewPOST } from "@/app/setup-api/prime-radiant/ingest/preview/route";
import { writeSettings } from "@/lib/prime-radiant/settings";
import { FlashCallError, setFlashClientOverride, type FlashClient } from "@/lib/prime-radiant/flash-client";
import { ingestFinished, listIngestJobs, stopIngest } from "@/lib/prime-radiant/ingest";
import { readVaultSnapshot } from "@/lib/prime-radiant/vault";
import { readWriterItems } from "@/lib/prime-radiant/writer";
import { execFileSync } from "child_process";

/** `<author>|<subject>` of the vault's last commit. */
const gitLog = (vault: string) =>
  execFileSync("git", ["-C", vault, "log", "-1", "--format=%an|%s"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" }).trim();

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-ingest-routes-"));
const prev = { dir: process.env.PRIME_RADIANT_DIR, files: process.env.FILES_ROOT };
let n = 0;
let filesRoot: string;
let vault: string;

const ORIGIN = "http://clawbox.local";
const API = `${ORIGIN}/setup-api/prime-radiant`;

function post(url: string, body: BodyInit | null, headers: Record<string, string> = {}) {
  const all = Object.fromEntries(Object.entries({ origin: ORIGIN, ...headers }).filter(([, v]) => v !== ""));
  return new Request(url, { method: "POST", body, headers: all, duplex: "half" } as RequestInit);
}
const ingest = (body: unknown, headers: Record<string, string> = {}) =>
  ingestPOST(post(`${API}/ingest`, JSON.stringify(body), { "content-type": "application/json", ...headers }));
const upload = (name: string, data: string, batch?: string) =>
  uploadPOST(post(`${API}/ingest/upload?name=${encodeURIComponent(name)}${batch ? `&batch=${batch}` : ""}`, data, { "content-length": String(Buffer.byteLength(data)) }));
const preview = (body: unknown, headers: Record<string, string> = {}) =>
  previewPOST(post(`${API}/ingest/preview`, JSON.stringify(body), { "content-type": "application/json", ...headers }));
const events = (id: string, signal?: AbortSignal) =>
  eventsGET(new Request(`${API}/ingest/${id}/events`, { signal }), { params: Promise.resolve({ id }) });

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jobGet = (id: string) => jobGET(new Request(`${API}/ingest/${id}`), params(id));
const jobStop = (id: string, headers: Record<string, string> = {}) =>
  jobDELETE(new Request(`${API}/ingest/${id}`, { method: "DELETE", headers: { origin: ORIGIN, ...headers } }), params(id));
const retry = (id: string, headers: Record<string, string> = {}) => retryPOST(post(`${API}/ingest/${id}/retry`, null, headers), params(id));

let delayMs = 0;
let failing = false;
const client: FlashClient = {
  model: "deepseek-v4-flash",
  async complete(request) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failing) throw new FlashCallError("refused", "plan", 403);
    const items = readWriterItems(request.user) ?? [];
    const cards = items.map((it) => ({
      i: it.i,
      useful: true,
      type: "concept",
      title: `Acme ${path.basename(it.path).replace(/\.\w+$/, "")}`,
      domain: "sales",
      summary: "A synthetic Acme document.",
      facts: [{ fact: `${path.basename(it.path)} is about Acme Widgets Ltd.`, confidence: 0.7 }],
      sensitivity: "internal",
      confidence: 0.7,
    }));
    return { text: JSON.stringify(cards), model: "deepseek-v4-flash", usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0 } };
  },
};

async function readSse(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event:"))
    .map((block) => {
      const [ev, data] = block.split("\n");
      return { event: ev.slice("event: ".length), data: JSON.parse(data.slice("data: ".length)) };
    });
}

beforeEach(() => {
  auth.requireSession.mockReset().mockResolvedValue(null);
  owner.hasPersonSession.mockReset().mockResolvedValue(true);
  creds.resolveClawaiToken.mockReset().mockResolvedValue(null);
  setFlashClientOverride(client);
  delayMs = 0;
  failing = false;
  const caseDir = path.join(base, `case-${++n}`);
  filesRoot = path.join(caseDir, "home");
  fs.mkdirSync(path.join(filesRoot, "Documents", "acme"), { recursive: true });
  fs.writeFileSync(path.join(filesRoot, "Documents", "acme", "catalogue.md"), "Acme Widgets Ltd sells blue widgets.");
  fs.writeFileSync(path.join(filesRoot, "Documents", "acme", "support.txt"), "Support answers on weekdays.");
  process.env.FILES_ROOT = filesRoot;
  process.env.PRIME_RADIANT_DIR = path.join(caseDir, "prime-radiant");
  vault = path.join(process.env.PRIME_RADIANT_DIR, "vault");
});

afterEach(async () => {
  for (const j of listIngestJobs(vault)) {
    stopIngest(j.id);
    await ingestFinished(j.id);
  }
  setFlashClientOverride(null);
});

afterAll(() => {
  for (const [key, value] of [["PRIME_RADIANT_DIR", prev.dir], ["FILES_ROOT", prev.files]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe("auth", () => {
  it("answers whatever requireSession answers, before anything else", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "x", code: "unauthorized" }, { status: 401 }));
    for (const res of [await ingest({ folders: ["Documents"] }), await listGET(new Request(`${API}/ingest`)), await events("ing-000000000000"), await upload("a.md", "x")]) {
      expect(res.status).toBe(401);
    }
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
  });

  it("refuses a caller with neither a person's cookie nor the assistant's bearer on the writes", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    for (const res of [await ingest({ folders: ["Documents"] }), await upload("a.md", "x")]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
  });

  it("admits the assistant's bearer to start an ingest, but keeps the drop the owner's", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    const drop = await uploadPOST(post(`${API}/ingest/upload?name=a.md`, "x", { ...ASSISTANT, "content-length": "1" }));
    expect(drop.status).toBe(403);
    expect((await drop.json()).code).toBe("owner_only");
    const res = await ingest({ folders: ["Documents"] }, ASSISTANT);
    expect(res.status).toBe(202);
    const { job } = await res.json();
    await ingestFinished(job.id);
    // Its commits name it, so History shows who imported and the assistant can undo it.
    expect(gitLog(vault)).toMatch(/^ClawBox assistant\|ingest: /);
  });

  it("names Prime Radiant on an import the owner started", async () => {
    const { job } = await (await ingest({ folders: ["Documents"] })).json();
    await ingestFinished(job.id);
    expect(gitLog(vault)).toMatch(/^Prime Radiant\|ingest: /);
  });

  it("refuses a cross-site page riding the owner's cookie", async () => {
    for (const res of [
      await ingest({ folders: ["Documents"] }, { origin: "https://evil.example.com" }),
      await uploadPOST(post(`${API}/ingest/upload?name=a.md`, "x", { origin: "https://evil.example.com" })),
    ]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("cross_origin");
    }
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
  });
});

describe("POST ingest: validation", () => {
  it("refuses a malformed body", async () => {
    for (const body of [{}, { folders: [], upload: "x" }, { folders: "Documents" }, { folders: [] }, { folders: Array(21).fill("Documents") }]) {
      const res = await ingest(body);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid");
    }
    const res = await ingestPOST(post(`${API}/ingest`, "{not json"));
    expect(res.status).toBe(400);
  });

  it("refuses a folder outside the Files tree, a missing one, a file, and ClawBox's own output", async () => {
    const outside = path.join(base, `outside-${n}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(filesRoot, "link-out"));
    for (const [folder, status] of [
      [outside, 404],
      ["../../etc", 404],
      ["Documents/missing", 404],
      ["link-out", 404],
      ["Documents/acme/catalogue.md", 400],
    ] as const) {
      const res = await ingest({ folders: ["Documents", folder] });
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code: "folder_not_found", index: 1 });
    }
    // The Prime Radiant folder itself, placed inside the Files tree.
    process.env.PRIME_RADIANT_DIR = path.join(filesRoot, "pr");
    fs.mkdirSync(path.join(filesRoot, "pr", "vault"), { recursive: true });
    const own = await ingest({ folders: ["pr/vault"] });
    expect(own.status).toBe(400);
    expect((await own.json()).code).toBe("folder_refused");
  });

  it("answers 412 without a ClawBox AI sign-in, reading nothing", async () => {
    setFlashClientOverride(null);
    const res = await ingest({ folders: ["Documents"] });
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("no_credential");
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
  });

  it("refuses an unknown upload batch", async () => {
    for (const batch of ["0123456789abcdef", "../../x", 7]) {
      const res = await ingest({ upload: batch });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("unknown_batch");
    }
  });
});

describe("an ingest through the routes", () => {
  it("starts with 202, streams progress over SSE to the end, and lists the job", async () => {
    const res = await ingest({ folders: ["Documents"] });
    expect(res.status).toBe(202);
    const { job } = await res.json();
    expect(job).toMatchObject({ status: "running", kind: "folders", id: expect.stringMatching(/^ing-[0-9a-f]{12}$/) });
    expect(job.folders[0]).toMatch(/Documents$/);

    const stream = await events(job.id);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(stream.headers.get("cache-control")).toBe("no-store");
    const frames = await readSse(stream);
    expect(frames.at(-1)).toMatchObject({ event: "end", data: { id: job.id, status: "done", done: 2, pages: 2, commits: 1 } });
    const files = frames.filter((f) => f.event === "file").map((f) => f.data as { status: string; label: string });
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.status === "done")).toBe(true);

    const snap = await readVaultSnapshot(vault);
    expect(snap.pages.map((p) => p.path).sort()).toEqual(["concepts/acme-catalogue.md", "concepts/acme-support.md"]);

    const list = await (await listGET(new Request(`${API}/ingest`))).json();
    expect(list.running).toBeNull();
    expect(list.jobs[0]).toMatchObject({ id: job.id, status: "done" });
  });

  it("answers a finished job's events at once, and 404 for an unknown or malformed id", async () => {
    const { job } = await (await ingest({ folders: ["Documents"] })).json();
    await ingestFinished(job.id);
    const frames = await readSse(await events(job.id));
    expect(frames.map((f) => f.event)).toEqual(["job", "end"]);
    for (const id of ["ing-ffffffffffff", "../../etc", "ing-XYZ"]) {
      const res = await events(id);
      expect(res.status).toBe(404);
    }
  });

  it("refuses a second job while one runs", async () => {
    delayMs = 150;
    const first = await (await ingest({ folders: ["Documents"] })).json();
    const second = await ingest({ folders: ["Documents"] });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "busy", runningId: first.job.id });
    const list = await (await listGET(new Request(`${API}/ingest`))).json();
    expect(list.running).toBe(first.job.id);
    await ingestFinished(first.job.id);
  });

  it("closes the stream when the client goes away", async () => {
    delayMs = 300;
    const { job } = await (await ingest({ folders: ["Documents"] })).json();
    const ctl = new AbortController();
    const res = await events(job.id, ctl.signal);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toMatch(/^event: job/);
    ctl.abort();
    let done = false;
    for (let i = 0; i < 20 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
    await ingestFinished(job.id);
  });

  it("GET ingest creates nothing on a fresh box", async () => {
    const res = await listGET(new Request(`${API}/ingest`));
    expect(await res.json()).toEqual({ running: null, jobs: [] });
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
  });
});

describe("drop: upload then ingest", () => {
  it("stages files under one batch, ingests it, and removes the staging folder", async () => {
    const a = await upload("Price list.md", "Acme price list: widgets cost little.");
    expect(a.status).toBe(200);
    const { batch, name } = await a.json();
    expect(name).toBe("Price list.md");
    expect(batch).toMatch(/^[0-9a-f]{16}$/);
    const b = await upload("notes.txt", "Notes from the Acme sales call.", batch);
    expect(b.status).toBe(200);

    const res = await ingest({ upload: batch });
    expect(res.status).toBe(202);
    const { job } = await res.json();
    expect(job.kind).toBe("upload");
    const frames = await readSse(await events(job.id));
    expect(frames.at(-1)).toMatchObject({ event: "end", data: { status: "done", done: 2 } });
    const labels = frames.filter((f) => f.event === "file").map((f) => (f.data as { label: string }).label).sort();
    // Each file by the name it was dropped under.
    expect(labels).toEqual(["Price list.md", "notes.txt"]);
    expect(fs.existsSync(path.join(process.env.PRIME_RADIANT_DIR!, "uploads", batch))).toBe(false);
  });

  it("answers the staging refusals with their codes", async () => {
    const bad = await upload("photo.png", "x");
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("invalid_name");
    const unknown = await upload("a.md", "x", "0123456789abcdef");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("unknown_batch");
    const big = await uploadPOST(post(`${API}/ingest/upload?name=a.md`, "x", { "content-length": String(20 * 1024 * 1024) }));
    expect(big.status).toBe(413);
    expect((await big.json()).code).toBe("too_large");
  });
});

describe("named files: ingested as one staged batch", () => {
  it("stages the files the assistant names, ingests them like a drop, and removes the staging", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    const res = await ingest({ files: ["Documents/acme/catalogue.md", path.join(filesRoot, "Documents", "acme", "support.txt"), "Documents/acme/catalogue.md"] }, ASSISTANT);
    expect(res.status).toBe(202);
    const { job } = await res.json();
    expect(job.kind).toBe("upload");
    const frames = await readSse(await events(job.id));
    expect(frames.at(-1)).toMatchObject({ event: "end", data: { status: "done", done: 2 } });
    const labels = frames.filter((f) => f.event === "file").map((f) => (f.data as { label: string }).label).sort();
    expect(labels).toEqual(["catalogue.md", "support.txt"]);
    expect(fs.readdirSync(path.join(process.env.PRIME_RADIANT_DIR!, "uploads"))).toEqual([]);
    // The originals are read, never moved.
    expect(fs.existsSync(path.join(filesRoot, "Documents", "acme", "catalogue.md"))).toBe(true);
  });

  it("refuses a file outside the Files tree, a folder, a kind it cannot read and ClawBox's own, by index", async () => {
    const outside = path.join(base, `outside-file-${n}.md`);
    fs.writeFileSync(outside, "Outside the Files tree.");
    fs.writeFileSync(path.join(filesRoot, "Documents", "photo.png"), "png");
    for (const [file, status, code] of [
      [outside, 404, "file_not_found"],
      ["Documents/missing.md", 404, "file_not_found"],
      ["Documents/acme", 400, "file_not_found"],
      ["Documents/photo.png", 400, "invalid_name"],
    ] as const) {
      const res = await ingest({ files: ["Documents/acme/catalogue.md", file] }, ASSISTANT);
      expect(res.status, file).toBe(status);
      expect(await res.json()).toMatchObject({ code, index: 1 });
    }
    process.env.PRIME_RADIANT_DIR = path.join(filesRoot, "pr");
    fs.mkdirSync(path.join(filesRoot, "pr", "vault"), { recursive: true });
    fs.writeFileSync(path.join(filesRoot, "pr", "vault", "page.md"), "x");
    const own = await ingest({ files: ["pr/vault/page.md"] }, ASSISTANT);
    expect(own.status).toBe(400);
    expect((await own.json()).code).toBe("file_refused");
    for (const body of [{ files: [] }, { files: "a.md" }, { folders: ["Documents"], files: ["Documents/acme/catalogue.md"] }]) {
      expect((await ingest(body, ASSISTANT)).status).toBe(400);
    }
    expect(fs.existsSync(path.join(filesRoot, "pr", "uploads"))).toBe(false);
  });
});

describe("one job: read, stop, retry its dead letters", () => {
  it("GET answers the job and its dead letters without a path, and 404 for an unknown id", async () => {
    failing = true;
    const { job } = await (await ingest({ folders: ["Documents"] })).json();
    await ingestFinished(job.id);
    const res = await jobGet(job.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job).toMatchObject({ id: job.id, failed: 2, deadLetter: 2 });
    expect(body.deadLetter).toHaveLength(2);
    expect(body.deadLetter[0]).toEqual({ seq: expect.any(Number), label: expect.stringMatching(/Documents\/acme\//), error: expect.any(String), attempts: 1, bytes: expect.any(Number) });
    expect(body.deadLetter.every((d: object) => !("source" in d))).toBe(true);
    for (const id of ["ing-ffffffffffff", "../x"]) expect((await jobGet(id)).status).toBe(404);
  });

  it("DELETE stops a running job (202), then answers 409 not_running; the owner's page only", async () => {
    delayMs = 300;
    const { job } = await (await ingest({ folders: ["Documents"] })).json();
    owner.hasPersonSession.mockResolvedValueOnce(false);
    expect((await jobStop(job.id)).status).toBe(403);
    expect((await jobStop(job.id, { origin: "https://evil.example.com" })).status).toBe(403);
    const res = await jobStop(job.id);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ stopping: true, job: { id: job.id } });
    await ingestFinished(job.id);
    const final = await (await jobGet(job.id)).json();
    expect(final.job).toMatchObject({ error: "The ingest was stopped.", status: expect.not.stringMatching(/^running$/) });
    const again = await jobStop(job.id);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("not_running");
    expect((await jobStop("ing-ffffffffffff")).status).toBe(404);
  });

  it("POST retry starts a job over the dead letters, then has nothing left to retry", async () => {
    failing = true;
    const { job } = await (await ingest({ folders: ["Documents"] })).json();
    await ingestFinished(job.id);
    failing = false;
    owner.hasPersonSession.mockResolvedValueOnce(false);
    expect((await retry(job.id)).status).toBe(403);

    const res = await retry(job.id);
    expect(res.status).toBe(202);
    const { job: second } = await res.json();
    expect(second).toMatchObject({ kind: "retry", retryOf: job.id, status: "running" });
    const frames = await readSse(await events(second.id));
    expect(frames.at(-1)).toMatchObject({ event: "end", data: { status: "done", done: 2, deadLetter: 0 } });
    expect((await (await jobGet(job.id)).json()).deadLetter).toEqual([]);

    const none = await retry(job.id);
    expect(none.status).toBe(409);
    expect((await none.json()).code).toBe("nothing_to_retry");
    expect((await retry("ing-ffffffffffff")).status).toBe(404);
  });

  it("POST retry answers 412 without a ClawBox AI sign-in", async () => {
    failing = true;
    const { job } = await (await ingest({ folders: ["Documents"] })).json();
    await ingestFinished(job.id);
    setFlashClientOverride(null);
    const res = await retry(job.id);
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("no_credential");
  });
});

describe("POST ingest/preview", () => {
  it("counts what an ingest of the folders would read, with the reasons for what it leaves out, and writes nothing", async () => {
    fs.mkdirSync(path.join(filesRoot, "Projects", "site", ".git"), { recursive: true });
    fs.writeFileSync(path.join(filesRoot, "Projects", "site", "README.md"), "Site readme.");
    fs.writeFileSync(path.join(filesRoot, "Documents", "acme", "LICENSE.md"), "MIT");
    fs.mkdirSync(path.join(filesRoot, "snap", "chromium"), { recursive: true });
    fs.writeFileSync(path.join(filesRoot, "snap", "chromium", "cache.txt"), "x");
    const res = await preview({ folders: ["."] });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { preview: p } = await res.json();
    expect(p).toMatchObject({ documents: 2, truncated: false, limit: 5000 });
    expect(p.skips).toMatchObject({ codeProject: 1, boilerplate: 1, excludedFolder: 1 });
    expect(p.topFolders).toEqual([{ label: expect.stringMatching(/Documents$/), documents: 2 }]);
    expect(p.codeProjects).toEqual([expect.stringMatching(/Projects\/site$/)]);
    expect(fs.existsSync(process.env.PRIME_RADIANT_DIR!)).toBe(false);
  });

  it("reads a project the owner picks, and follows the settings' Skip code projects", async () => {
    fs.mkdirSync(path.join(filesRoot, "Projects", "site", ".git"), { recursive: true });
    fs.writeFileSync(path.join(filesRoot, "Projects", "site", "README.md"), "Site readme.");
    expect((await (await preview({ folders: ["Projects/site"] })).json()).preview.documents).toBe(1);
    expect((await (await preview({ folders: ["Projects"] })).json()).preview.documents).toBe(0);
    writeSettings({ ingest: { skipCodeProjects: false } });
    expect((await (await preview({ folders: ["Projects"] })).json()).preview.documents).toBe(1);
  });

  it("refuses what an ingest refuses: no folders, a bad folder, ClawBox's own output, another site, the MCP bearer", async () => {
    for (const body of [{}, { folders: [] }, { folders: "Documents" }, { folders: Array(21).fill("Documents") }]) {
      const res = await preview(body);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid");
    }
    const missing = await preview({ folders: ["Documents", "Documents/missing"] });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "folder_not_found", index: 1 });
    process.env.PRIME_RADIANT_DIR = path.join(filesRoot, "pr");
    fs.mkdirSync(path.join(filesRoot, "pr", "vault"), { recursive: true });
    expect((await (await preview({ folders: ["pr/vault"] })).json()).code).toBe("folder_refused");
    const cross = await preview({ folders: ["Documents"] }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    owner.hasPersonSession.mockResolvedValue(false);
    const bearer = await preview({ folders: ["Documents"] });
    expect(bearer.status).toBe(403);
    expect((await bearer.json()).code).toBe("owner_only");
  });
});
