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
const PREVIOUS_ROOT = process.env.CLAWBOX_ROOT;
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
  // Restore rather than delete: a run that already had CLAWBOX_ROOT set must
  // not be handed a different one by this file.
  if (PREVIOUS_ROOT === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = PREVIOUS_ROOT;
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

// ── The sinks open what the guard vetted ────────────────────────────────────
//
// mcp-path-guard.test.ts pins the PREDICATE; this pins the SINK. A guard that
// judged a link's target and then opened the link would be refuted by the
// bytes, so the assertions here are about the bytes: nothing of the secret in
// the tool's answer, nothing changed on disk behind a refused write.
describe("MCP file tools open the vetted target, not the link", () => {
  const SECRET = "GOOGLE_OAUTH_CLIENT_SECRET=hunter2-do-not-print";
  let env: string;
  let notes: string;

  async function failure(name: string, args: Record<string, unknown>): Promise<{ code?: string; message?: string }> {
    try {
      await call(name, args);
    } catch (err) {
      return err as { code?: string; message?: string };
    }
    throw new Error(`${name} answered instead of refusing`);
  }

  beforeAll(() => {
    env = path.join(ROOT, "secrets", ".env");
    fs.mkdirSync(path.dirname(env), { recursive: true });
    fs.writeFileSync(env, `${SECRET}\n`);
    notes = path.join(ROOT, "proj", "notes.txt");
    fs.mkdirSync(path.dirname(notes), { recursive: true });
    fs.symlinkSync(env, notes);
  });

  it("read_file of a link to a dotenv file answers BLOCKED_PATH and none of the bytes", async () => {
    const err = await failure("read_file", { file_path: notes, offset: 0, limit: 2000 });
    expect(err.code).toBe("BLOCKED_PATH");
    expect(JSON.stringify(err)).not.toContain("hunter2");
  });

  it("write_file through a leaf link to that file refuses and leaves it untouched", async () => {
    const before = fs.statSync(env);
    const err = await failure("write_file", { file_path: notes, content: "overwritten\n" });
    expect(err.code).toBe("BLOCKED_PATH");
    expect(fs.readFileSync(env, "utf-8")).toBe(`${SECRET}\n`);
    expect(fs.statSync(env).mtimeMs).toBe(before.mtimeMs);
  });

  it("edit_file through a leaf link to that file refuses and leaves it untouched", async () => {
    const before = fs.statSync(env);
    const err = await failure("edit_file", {
      file_path: notes,
      old_text: "hunter2",
      new_text: "x",
      replace_all: false,
    });
    expect(err.code).toBe("BLOCKED_PATH");
    expect(fs.readFileSync(env, "utf-8")).toBe(`${SECRET}\n`);
    expect(fs.statSync(env).mtimeMs).toBe(before.mtimeMs);
  });

  it("grep with an explicit path that is a link to that file refuses", async () => {
    const err = await failure("grep", {
      pattern: "hunter",
      path: notes,
      output_mode: "content",
      context: 0,
      case_sensitive: true,
      max_results: 50,
      offset: 0,
    });
    expect(err.code).toBe("BLOCKED_PATH");
    expect(JSON.stringify(err)).not.toContain("hunter2");
  });

  it("still reads and writes a link to an ordinary file, naming the typed path", async () => {
    const real = path.join(ROOT, "proj", "real.txt");
    fs.writeFileSync(real, "one\ntwo\n");
    const alias = path.join(ROOT, "proj", "alias.txt");
    fs.symlinkSync(real, alias);

    const read = await call("read_file", { file_path: alias, offset: 0, limit: 2000 });
    expect(firstText(read)).toContain(alias);
    expect(firstText(read)).toContain("two");

    const edited = await call("edit_file", { file_path: alias, old_text: "two", new_text: "three", replace_all: false });
    expect(firstText(edited)).toContain(alias);
    // The bytes landed in the TARGET, and the link is still a link.
    expect(fs.readFileSync(real, "utf-8")).toBe("one\nthree\n");
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);

    const written = await call("write_file", { file_path: alias, content: "four\n" });
    expect(firstText(written)).toContain(alias);
    expect(fs.readFileSync(real, "utf-8")).toBe("four\n");
  });

  it("creates a new file under a link into an ordinary folder where it would land", async () => {
    const realDir = path.join(ROOT, "proj", "scratch");
    fs.mkdirSync(realDir, { recursive: true });
    const via = path.join(ROOT, "proj", "via");
    fs.symlinkSync(realDir, via);
    await call("write_file", { file_path: path.join(via, "new", "deep.txt"), content: "deep\n" });
    expect(fs.readFileSync(path.join(realDir, "new", "deep.txt"), "utf-8")).toBe("deep\n");
  });

  it("refuses a write through a dangling link into a credential directory, creating nothing", async () => {
    // With the target absent, the old `writeFile(abs)` followed the link and
    // CREATED ~/.ssh/authorized_keys. Now the predicate follows the link to
    // where the kernel would create it and refuses there — as BLOCKED_PATH
    // with the credential wording, not as a swapped link.
    const ssh = path.join(ROOT, ".ssh");
    fs.mkdirSync(ssh, { recursive: true });
    const keys = path.join(ROOT, "proj", "keys.txt");
    fs.symlinkSync(path.join(ssh, "authorized_keys"), keys);
    const err = await failure("write_file", { file_path: keys, content: "ssh-ed25519 AAAA…\n" });
    expect(err.code).toBe("BLOCKED_PATH");
    expect(err.message).toContain("device credentials");
    expect(fs.existsSync(path.join(ssh, "authorized_keys"))).toBe(false);
  });

  it("creates the target of a dangling link into an ordinary place, as open(2) would", async () => {
    // `latest.log -> logs/today.log` before the first line: the sink is handed
    // the target name and the file appears THERE, the behaviour the plain
    // writeFile had before O_NOFOLLOW — through the predicate now, not around it.
    const logs = path.join(ROOT, "proj", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const latest = path.join(ROOT, "proj", "latest.log");
    fs.symlinkSync(path.join(logs, "today.log"), latest);
    await call("write_file", { file_path: latest, content: "first line\n" });
    expect(fs.readFileSync(path.join(logs, "today.log"), "utf-8")).toBe("first line\n");
    expect(fs.lstatSync(latest).isSymbolicLink()).toBe(true);
  });

  it("refuses a cycle of links at the sink, with words that do not claim a race", async () => {
    // `canonicalPath` answers null for a cycle, so the sinks are handed the
    // name as typed and O_NOFOLLOW refuses it. A READ stats first and there
    // is nothing at the end of the chain to read, so that side is NOT_FOUND;
    // a WRITE reaches the open, and its refusal must not say the link was
    // swapped in under the check when it was there all along.
    const loop = path.join(ROOT, "proj", "loop.txt");
    fs.symlinkSync(loop, loop);
    const read = await failure("read_file", { file_path: loop, offset: 0, limit: 2000 });
    expect(read.code).toBe("NOT_FOUND");
    const write = await failure("write_file", { file_path: loop, content: "x\n" });
    expect(write.code).toBe("BLOCKED_PATH");
    expect(write.message).toContain("chain of links");
    expect(write.message).not.toContain("changed into a link");
    expect(fs.lstatSync(loop).isSymbolicLink()).toBe(true);
  });

  it("opens with an O_NOFOLLOW the runtime actually honours", async () => {
    // The sinks close the check-to-open window by opening the CANONICAL path
    // with O_NOFOLLOW, passed as a numeric flag to fs.promises. That only
    // closes anything if this runtime treats the flag as a flag; pin it, so
    // a runtime that silently ignored it would be caught here rather than by
    // a swapped link on a box.
    const { O_RDONLY, O_NOFOLLOW, O_WRONLY, O_CREAT, O_TRUNC } = fs.constants;
    const real = path.join(ROOT, "proj", "nofollow-target.txt");
    fs.writeFileSync(real, "keep\n");
    const swapped = path.join(ROOT, "proj", "nofollow-swapped.txt");
    fs.symlinkSync(real, swapped);
    await expect(fs.promises.readFile(swapped, { flag: O_RDONLY | O_NOFOLLOW }))
      .rejects.toMatchObject({ code: "ELOOP" });
    await expect(fs.promises.writeFile(swapped, "x", { encoding: "utf-8", flag: O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW }))
      .rejects.toMatchObject({ code: "ELOOP" });
    expect(fs.readFileSync(real, "utf-8")).toBe("keep\n");
  });

  it("keeps the staleness check keyed on the file it opened", async () => {
    // A read recorded under one spelling and checked under another would
    // never meet, and CONFLICT would be silently off. Read through the link,
    // change the target behind the tool's back, edit through the link.
    const real = path.join(ROOT, "proj", "stale.txt");
    fs.writeFileSync(real, "a\n");
    const alias = path.join(ROOT, "proj", "stale-link.txt");
    fs.symlinkSync(real, alias);
    await call("read_file", { file_path: alias, offset: 0, limit: 2000 });
    const past = new Date(Date.now() - 60_000);
    fs.writeFileSync(real, "b\n");
    fs.utimesSync(real, past, past);
    const err = await failure("edit_file", { file_path: alias, old_text: "b", new_text: "c", replace_all: false });
    expect(err.code).toBe("CONFLICT");
  });
});
