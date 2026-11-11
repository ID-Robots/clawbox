import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

// POST /setup-api/chat/attachments with an office document (TASK-2435): the
// route takes its text out once, beside the staged file, on both runtimes —
// and refuses a file whose text cannot be had, leaving nothing behind.

let harness: "openclaw" | "hermes" = "openclaw";
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => harness,
}));

const FIXTURES = path.join(process.cwd(), "src", "tests", "fixtures", "office");
const BOUNDARY = "----clawboxofficeboundary";

function request(filename: string, content: Buffer): NextRequest {
  const body = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
        + "Content-Type: application/octet-stream\r\n\r\n",
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return new NextRequest("http://localhost/setup-api/chat/attachments", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: new Uint8Array(body),
    duplex: "half",
  } as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

let tmpHome: string;
let saved: Record<string, string | undefined>;
let POST: (req: NextRequest) => Promise<Response>;

beforeEach(async () => {
  harness = "openclaw";
  saved = { HOME: process.env.HOME, OPENCLAW_HOME: process.env.OPENCLAW_HOME, CLAWBOX_ROOT: process.env.CLAWBOX_ROOT };
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-attach-office-"));
  fs.mkdirSync(path.join(tmpHome, ".openclaw"), { recursive: true });
  process.env.HOME = tmpHome;
  process.env.OPENCLAW_HOME = path.join(tmpHome, ".openclaw");
  process.env.CLAWBOX_ROOT = tmpHome;
  vi.resetModules();
  POST = (await import("@/app/setup-api/chat/attachments/route")).POST;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Every file under the box's two staging roots. */
function stagedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(path.join(tmpHome, ".openclaw", "media"));
  walk(path.join(tmpHome, "data"));
  return out.filter((f) => !f.endsWith("config.json"));
}

describe.each(["openclaw", "hermes"] as const)("on %s", (runtime) => {
  beforeEach(() => {
    harness = runtime;
  });

  it.each([
    ["report.docx", "Revenue grew by 12 % & costs fell."],
    ["budget.xlsx", "=== Sheet: Costs ===\nItem,Amount\nRent,1500"],
    ["deck.pptx", "=== Slide 1 ===\nAcme roadmap"],
    ["notes.odt", "Meeting notes"],
    ["sales.ods", "Month,Units\nJan,12"],
  ])("stages %s with its text beside it", async (name, expected) => {
    const res = await POST(request(name, fs.readFileSync(path.join(FIXTURES, name))));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(name);
    expect(body.textPath).toBe(`${body.path}.txt`);
    expect(fs.readFileSync(body.path)).toEqual(fs.readFileSync(path.join(FIXTURES, name)));
    expect(fs.readFileSync(body.textPath, "utf-8")).toContain(expected);
  });

  it("refuses a password-protected file with a sentence that says so, and keeps nothing", async () => {
    const res = await POST(request("protected.docx", fs.readFileSync(path.join(FIXTURES, "protected.docx"))));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("unreadable_document");
    expect(body.error).toMatch(/password-protected/);
    expect(stagedFiles()).toEqual([]);
  });

  it("refuses a damaged file, and keeps nothing", async () => {
    const res = await POST(request("broken.xlsx", fs.readFileSync(path.join(FIXTURES, "broken.xlsx"))));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "unreadable_document" });
    expect(stagedFiles()).toEqual([]);
  });

  it("leaves every other document as it was: no text file beside it", async () => {
    const res = await POST(request("notes.txt", Buffer.from("plain notes")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.textPath).toBeUndefined();
    expect(fs.existsSync(`${body.path}.txt`)).toBe(false);
  });
});
