import fsp from "fs/promises";
import path from "@/lib/runtime-path";

/**
 * How a staged document is put in front of a Hermes agent.
 *
 * Every document is NAMED, as `[Attached file: /abs/path]` — the line the
 * OpenClaw adapter writes — and the agent can open it with its `file` tools.
 * That alone is not enough on the box's own small model: Gemma 4 E2B was
 * handed the path, never called a tool, and answered from imagination
 * (measured on a lab board, 2026-10-13). So a SMALL TEXT file is also quoted
 * under its line, where no tool call is needed to read it.
 *
 * Bounded on purpose. The local model's window is small and a turn that
 * quotes a megabyte of CSV answers nothing; past the budget the file is named
 * and the agent is told it was not quoted, which is exactly what it needs to
 * know to go and open it.
 */

/** Largest single file quoted into the prompt. */
export const INLINE_DOCUMENT_MAX_BYTES = 16 * 1024;
/** Budget for all quoted files in one turn. */
export const INLINE_DOCUMENTS_TOTAL_BYTES = 32 * 1024;

/** Extensions quoted as text. The picker's own document list, plus plain logs and config. */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".py", ".js", ".ts", ".html", ".css",
  ".log", ".yaml", ".yml", ".xml", ".ini", ".toml", ".sh", ".tsv",
]);

/** Text only: valid UTF-8 with no NUL. A binary file renamed `.txt` is named, not quoted. */
function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The whole file when it is no larger than `limit`, else null. ONE open and a
 * bounded read from that handle — never a size check followed by a read of
 * the path, which a file swapped in between would walk straight past.
 */
async function readAtMost(file: string, limit: number): Promise<Buffer | null> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file, "r");
    const buffer = Buffer.alloc(limit + 1);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return read > limit ? null : buffer.subarray(0, read);
  } catch {
    // Aged out of staging, or unreadable: named, like any other.
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The lines that go ahead of the owner's message for `documentPaths`, which
 * the caller has ALREADY resolved against the staging root. Never throws: a
 * file that cannot be read is still named.
 */
export async function hermesDocumentPrompt(documentPaths: readonly string[]): Promise<string> {
  const blocks: string[] = [];
  let budget = INLINE_DOCUMENTS_TOTAL_BYTES;
  for (const file of documentPaths) {
    const line = `[Attached file: ${file}]`;
    const name = path.basename(file);
    let quoted: string | null = null;
    if (TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      const limit = Math.min(INLINE_DOCUMENT_MAX_BYTES, budget);
      const bytes = limit > 0 ? await readAtMost(file, limit) : null;
      if (bytes && bytes.length > 0) {
        quoted = decodeText(bytes);
        if (quoted !== null) budget -= bytes.length;
      }
    }
    blocks.push(
      quoted === null
        ? `${line}\n(Contents not shown here. Open the file at that path to read it.)`
        : `${line}\n----- contents of ${name} -----\n${quoted.replace(/\s+$/, "")}\n----- end of ${name} -----`,
    );
  }
  return blocks.join("\n\n");
}
