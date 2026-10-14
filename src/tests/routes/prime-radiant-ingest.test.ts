/**
 * POST/GET /setup-api/prime-radiant/ingest, GET ingest/<id>/events (SSE) and
 * POST ingest/upload, over a real vault in a tmp dir with the model replaced
 * through the client override. The writes are owner-cookie AND same-origin;
 * folders come from the Files tree only; the GETs never create anything.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);
const owner = vi.hoisted(() => ({ hasOwnerSession: vi.fn(async () => true) }));
vi.mock("@/lib/owner-session", () => owner);
const creds = vi.hoisted(() => ({
  resolveClawaiToken: vi.fn(async (): Promise<string | null> => null),
  clawaiCredentialGeneration: vi.fn(() => 0),
  noteClawaiCredentialRefused: vi.fn(async () => undefined),
  proxyRefusedClawaiCredential: vi.fn(async () => false),
}));
vi.mock("@/lib/harness/credentials", () => creds);

import { GET as listGET, POST as ingestPOST } from "@/app/setup-api/prime-radiant/ingest/route";
import { GET as eventsGET } from "@/app/setup-api/prime-radiant/ingest/[id]/events/route";
import { POST as uploadPOST } from "@/app/setup-api/prime-radiant/ingest/upload/route";
import { setFlashClientOverride, type FlashClient } from "@/lib/prime-radiant/flash-client";
import { ingestFinished, listIngestJobs, stopIngest } from "@/lib/prime-radiant/ingest";
import { readVaultSnapshot } from "@/lib/prime-radiant/vault";
import { readWriterItems } from "@/lib/prime-radiant/writer";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-ingest-routes-"));
const prev = { dir: process.env.PRIME_RADIANT_DIR, files: process.env.FILES_ROOT };
let n = 0;
let filesRoot: string;
let vault: string;

const ORIGIN = "http://clawbox.local";
const API = `${ORIGIN}/setup-api/prime-radiant`;

function post(url: string, body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request(url, { method: "POST", body, headers: { origin: ORIGIN, ...headers }, duplex: "half" } as RequestInit);
}
const ingest = (body: unknown, headers: Record<string, string> = {}) =>
  ingestPOST(post(`${API}/ingest`, JSON.stringify(body), { "content-type": "application/json", ...headers }));
const upload = (name: string, data: string, batch?: string) =>
  uploadPOST(post(`${API}/ingest/upload?name=${encodeURIComponent(name)}${batch ? `&batch=${batch}` : ""}`, data, { "content-length": String(Buffer.byteLength(data)) }));
const events = (id: string, signal?: AbortSignal) =>
  eventsGET(new Request(`${API}/ingest/${id}/events`, { signal }), { params: Promise.resolve({ id }) });

let delayMs = 0;
const client: FlashClient = {
  model: "deepseek-v4-flash",
  async complete(request) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
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
  owner.hasOwnerSession.mockReset().mockResolvedValue(true);
  creds.resolveClawaiToken.mockReset().mockResolvedValue(null);
  setFlashClientOverride(client);
  delayMs = 0;
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

  it("refuses the MCP bearer (no owner cookie) on the writes", async () => {
    owner.hasOwnerSession.mockResolvedValue(false);
    for (const res of [await ingest({ folders: ["Documents"] }), await upload("a.md", "x")]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("owner_only");
    }
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
    expect(labels).toEqual(["upload/Price list.md", "upload/notes.txt"]);
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
