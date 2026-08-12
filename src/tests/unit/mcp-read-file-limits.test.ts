import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import fs from "fs";
import os from "os";
import path from "path";
import { registerCodingTools } from "../../../mcp/tools/coding";
import type { Registrar, RegisteredToolInfo, ToolHandler, ToolResult } from "../../../mcp/lib/register";
import type { Shape } from "../../../mcp/lib/schema";

// read_file's size check has to run BEFORE the image / PDF / notebook branches.
// When it ran after, a large .png was read into memory and base64-encoded in
// full before anything looked at how big it was — the encode alone is 4/3 of the
// file, so a big enough image took the whole stdio process down and with it
// every tool the agent had.
//
// These tests drive the real registered handler through the real schema, so they
// fail if the ordering is reversed, if the caps move, or if the schema bounds
// are dropped.

interface Captured {
  shape: Shape;
  handler: ToolHandler;
}

function captureTools(): Map<string, Captured> {
  const tools = new Map<string, Captured>();
  const reg: Registrar = {
    tool(name: string, _description: string, shape: Shape, _opts, handler: ToolHandler) {
      tools.set(name, { shape, handler });
    },
    list(): RegisteredToolInfo[] {
      return [];
    },
    finalize() {},
  };
  registerCodingTools(reg);
  return tools;
}

/** Call a tool the way mcp/lib/register.ts does: parse through the schema first. */
async function call(tools: Map<string, Captured>, name: string, args: Record<string, unknown>) {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool ${name} was not registered`);
  const parsed = z.object(entry.shape).parse(args);
  return (await entry.handler(parsed)) as ToolResult;
}

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

/** A file of exactly `size` bytes, created sparsely so the test stays fast. */
function makeFile(dir: string, name: string, size: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "");
  fs.truncateSync(p, size);
  return p;
}

const MAX_IMAGE_BYTES = 700_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

let dir: string;
let tools: Map<string, Captured>;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-readfile-"));
  tools = captureTools();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("read_file — size is checked before the image branch", () => {
  it("refuses an oversized image instead of encoding it", async () => {
    const big = makeFile(dir, "big.png", MAX_IMAGE_BYTES + 50_000);
    let thrown: unknown;
    try {
      await call(tools, "read_file", { file_path: big });
    } catch (err) {
      thrown = err;
    }
    // If the image branch still ran first this would have resolved with an
    // image content part instead of throwing.
    expect(codeOf(thrown)).toBe("TOO_LARGE");
  });

  it("still returns a small image as an image part", async () => {
    const small = path.join(dir, "small.png");
    fs.writeFileSync(small, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const result = await call(tools, "read_file", { file_path: small });
    expect(result.content.some((p) => p.type === "image")).toBe(true);
  });

  it("applies the image cap, not the much larger text cap, to an image", async () => {
    // Between the two caps: allowed as text, refused as an image.
    const between = makeFile(dir, "between.png", MAX_IMAGE_BYTES + 1);
    let thrown: unknown;
    try {
      await call(tools, "read_file", { file_path: between });
    } catch (err) {
      thrown = err;
    }
    expect(codeOf(thrown)).toBe("TOO_LARGE");

    const sameSizeText = makeFile(dir, "between.txt", MAX_IMAGE_BYTES + 1);
    const ok = await call(tools, "read_file", { file_path: sameSizeText, limit: 1 });
    expect(ok.content[0].type).toBe("text");
  });
});

describe("read_file — size is checked before the notebook and PDF branches", () => {
  it("refuses an oversized notebook without parsing it", async () => {
    const nb = makeFile(dir, "big.ipynb", MAX_FILE_BYTES + 1);
    let thrown: unknown;
    try {
      await call(tools, "read_file", { file_path: nb });
    } catch (err) {
      thrown = err;
    }
    // A notebook that reached JSON.parse would fail as BAD_ARGUMENT instead.
    expect(codeOf(thrown)).toBe("TOO_LARGE");
  });

  it("refuses an oversized PDF without shelling out to extract it", async () => {
    const pdf = makeFile(dir, "big.pdf", MAX_FILE_BYTES + 1);
    let thrown: unknown;
    try {
      await call(tools, "read_file", { file_path: pdf });
    } catch (err) {
      thrown = err;
    }
    expect(codeOf(thrown)).toBe("TOO_LARGE");
  });
});

describe("read_file — bounded numeric arguments", () => {
  it("rejects a negative offset at the schema rather than mis-slicing the file", () => {
    const entry = tools.get("read_file")!;
    expect(() => z.object(entry.shape).parse({ file_path: "/tmp/x", offset: -1 })).toThrow();
  });

  it("rejects a non-integer offset", () => {
    const entry = tools.get("read_file")!;
    expect(() => z.object(entry.shape).parse({ file_path: "/tmp/x", offset: 1.5 })).toThrow();
  });

  it("rejects a limit above the ceiling", () => {
    const entry = tools.get("read_file")!;
    expect(() => z.object(entry.shape).parse({ file_path: "/tmp/x", limit: 100_000 })).toThrow();
  });

  it("supplies defaults when offset and limit are omitted", () => {
    const entry = tools.get("read_file")!;
    const parsed = z.object(entry.shape).parse({ file_path: "/tmp/x" });
    expect(parsed.offset).toBe(0);
    expect(parsed.limit).toBeGreaterThan(0);
  });
});

describe("read_file — the path guard applies here too", () => {
  it("refuses a credential store before it touches the filesystem", async () => {
    let thrown: unknown;
    try {
      await call(tools, "read_file", { file_path: "/home/clawbox/.hermes/.env" });
    } catch (err) {
      thrown = err;
    }
    expect(codeOf(thrown)).toBe("BLOCKED_PATH");
  });

  it("refuses the install's own environment file", async () => {
    let thrown: unknown;
    try {
      await call(tools, "read_file", { file_path: "/home/clawbox/clawbox/.env" });
    } catch (err) {
      thrown = err;
    }
    expect(codeOf(thrown)).toBe("BLOCKED_PATH");
  });
});
