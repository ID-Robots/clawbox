/**
 * POST ingest `{ files }` when the start itself throws AFTER the files were
 * staged — another job that raced in past the route's own busy check, or a
 * vault that could not be opened. No job owns the staged batch then, so the
 * route must take it away; a batch the owner dropped is the drop's and stays.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/route-auth", () => auth);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn(async () => true) }));
vi.mock("@/lib/owner-session", () => owner);
vi.mock("@/lib/prime-radiant/flash-client", () => ({ flashAvailable: async () => true }));
const start = vi.hoisted(() => ({ startIngest: vi.fn() }));
vi.mock("@/lib/prime-radiant/ingest", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/prime-radiant/ingest")>();
  return { ...actual, runningJobId: () => null, startIngest: (...a: unknown[]) => start.startIngest(...a) };
});

import { POST as ingestPOST } from "@/app/setup-api/prime-radiant/ingest/route";
import { IngestBusyError } from "@/lib/prime-radiant/ingest";
import { stageUpload, uploadsRoot } from "@/lib/prime-radiant/ingest-upload";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-ingest-race-"));
const prev = { dir: process.env.PRIME_RADIANT_DIR, files: process.env.FILES_ROOT };
let n = 0;

const ORIGIN = "http://clawbox.local";
const ingest = (body: unknown) =>
  ingestPOST(new Request(`${ORIGIN}/setup-api/prime-radiant/ingest`, { method: "POST", body: JSON.stringify(body), headers: { origin: ORIGIN, "content-type": "application/json" } }));
const batches = () => (fs.existsSync(uploadsRoot()) ? fs.readdirSync(uploadsRoot()) : []);

beforeEach(() => {
  start.startIngest.mockReset();
  const caseDir = path.join(base, `case-${++n}`);
  const filesRoot = path.join(caseDir, "home");
  fs.mkdirSync(path.join(filesRoot, "Documents"), { recursive: true });
  fs.writeFileSync(path.join(filesRoot, "Documents", "a.md"), "Acme Widgets Ltd sells blue widgets.");
  process.env.FILES_ROOT = filesRoot;
  process.env.PRIME_RADIANT_DIR = path.join(caseDir, "prime-radiant");
});

afterAll(() => {
  for (const [key, value] of [["PRIME_RADIANT_DIR", prev.dir], ["FILES_ROOT", prev.files]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe("a start that throws after named files were staged", () => {
  it("removes their batch when another job raced in, answering 409 busy", async () => {
    start.startIngest.mockRejectedValue(new IngestBusyError("ing-0123456789ab"));
    const res = await ingest({ files: ["Documents/a.md"] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "busy", runningId: "ing-0123456789ab" });
    expect(start.startIngest).toHaveBeenCalledTimes(1);
    expect(batches()).toEqual([]);
  });

  it("removes their batch when the start fails otherwise", async () => {
    start.startIngest.mockRejectedValue(new Error("the vault could not be opened"));
    const res = await ingest({ files: ["Documents/a.md"] });
    expect(res.status).toBe(500);
    expect(batches()).toEqual([]);
  });

  it("leaves a batch the owner dropped, which is theirs to ingest again", async () => {
    const dropped = await stageUpload(new Blob(["Dropped notes."]).stream(), "notes.md", null, null);
    if (!dropped.ok) throw new Error("expected the drop to stage");
    start.startIngest.mockRejectedValue(new IngestBusyError("ing-0123456789ab"));
    const res = await ingest({ upload: dropped.batch });
    expect(res.status).toBe(409);
    expect(batches()).toEqual([dropped.batch]);
  });
});
