import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Registrar, RegisteredToolInfo, ToolHandler, ToolResult } from "../../../mcp/lib/register";
import type { Shape } from "../../../mcp/lib/schema";

/**
 * TASK-453 round 2 — the file tools echoed a bare basename.
 *
 * A relative `file_path` resolves against CLAWBOX_ROOT, which is NOT the
 * working directory the harness spawned this server from. Live on the QA box:
 *
 *   write_file file_path="tmp/qa-t453a-rel.txt" -> "Created qa-t453a-rel.txt"
 *   $ ls /home/clawbox/tmp/qa-t453a-rel.txt          -> No such file
 *   $ ls /home/clawbox/clawbox/tmp/qa-t453a-rel.txt  -> exists
 *
 * `list_directory` already discloses the root it resolved against; read_file,
 * write_file and edit_file did not, which is the same ambiguity the
 * code_project path fixes were about. The agent has to be able to read the path
 * it just wrote back out of the tool's own answer.
 *
 * OpenClaw-only family — not registered on a Hermes device — so this is a
 * correctness fix, not a live defect on the QA box.
 */

// Set BEFORE the module under test loads: guard.ts reads CLAWBOX_ROOT once, at
// import time, into DEFAULT_CWD.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mcp-paths-"));
process.env.CLAWBOX_ROOT = ROOT;

interface Captured {
  shape: Shape;
  handler: ToolHandler;
}

let tools: Map<string, Captured>;

async function captureTools(): Promise<Map<string, Captured>> {
  const out = new Map<string, Captured>();
  const reg: Registrar = {
    tool(name: string, _description: string, shape: Shape, _opts, handler: ToolHandler) {
      out.set(name, { shape, handler });
    },
    list(): RegisteredToolInfo[] {
      return [];
    },
    finalize() {},
  };
  const { registerCodingTools } = await import("../../../mcp/tools/coding");
  registerCodingTools(reg);
  return out;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool ${name} was not registered`);
  return (await entry.handler(z.object(entry.shape).parse(args))) as ToolResult;
}

function firstText(result: ToolResult): string {
  const part = result.content.find((p) => p.type === "text");
  return part && "text" in part ? String(part.text) : "";
}

beforeAll(async () => {
  tools = await captureTools();
});

afterAll(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("MCP file tools name the path they actually resolved", () => {
  it("write_file echoes the absolute path a relative argument landed on", async () => {
    const out = await call("write_file", { file_path: "tmp/qa-t453a-rel.txt", content: "hello\n" });
    const said = firstText(out);
    const abs = path.join(ROOT, "tmp", "qa-t453a-rel.txt");

    expect(fs.existsSync(abs)).toBe(true);
    expect(said).toContain(abs);
    // The old answer was "Created qa-t453a-rel.txt (1 lines)." — a name that
    // exists under two plausible roots and identifies neither.
    expect(said).not.toMatch(/Created qa-t453a-rel\.txt/);
  });

  it("read_file's header is the same absolute path, so the round trip closes", async () => {
    await call("write_file", { file_path: "tmp/roundtrip.txt", content: "a\nb\nc\n" });
    const out = await call("read_file", { file_path: "tmp/roundtrip.txt" });
    expect(firstText(out)).toContain(path.join(ROOT, "tmp", "roundtrip.txt"));
  });

  it("edit_file echoes the absolute path too", async () => {
    await call("write_file", { file_path: "tmp/edit-me.txt", content: "before\n" });
    const out = await call("edit_file", {
      file_path: "tmp/edit-me.txt",
      old_text: "before",
      new_text: "after",
    });
    expect(firstText(out)).toContain(path.join(ROOT, "tmp", "edit-me.txt"));
  });

  it("says binary-file of an absolute path, not of a basename", async () => {
    const bin = path.join(ROOT, "tmp", "blob.bin");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    const out = await call("read_file", { file_path: "tmp/blob.bin" });
    expect(firstText(out)).toContain(bin);
  });
});
