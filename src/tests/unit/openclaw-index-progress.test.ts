import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  countIndexChunks,
  createIndexProgressReader,
  openclawAgentDbPath,
  parseIndexProgressSegment,
  ptyHostArgs,
} from "@/lib/openclaw-index-progress";

/**
 * How far `openclaw memory index` has got, read off the CLI's own reporter.
 *
 * The transcript is CAPTURED, not written by hand: the bytes a real OpenClaw
 * 2026.8.1 printed for `memory index --force --verbose` under `script`, over a
 * throwaway workspace of 601 files (trimmed to the header, a few segments from
 * the middle and the end). 2026.9.3 builds the label the same way —
 * `createSyncProgress` appends `<done>/<total>`, `runMemoryIndex` appends
 * `· elapsed m:ss` — so this is the shape the parser must keep reading.
 */
const TRANSCRIPT = await fs.readFile(
  new URL("../fixtures/openclaw-memory-index-pty.ansi", import.meta.url),
);

describe("reading a segment of the line reporter", () => {
  it("takes done and total from the label the memory manager builds", () => {
    expect(parseIndexProgressSegment("Indexing memory files… 65/601 · elapsed 0:00 · eta 0:06 11%"))
      .toEqual({ filesDone: 65, filesTotal: 601 });
    expect(parseIndexProgressSegment("Indexing session files… 601/601 · elapsed 0:05 · eta 0:00 100%"))
      .toEqual({ filesDone: 601, filesTotal: 601 });
  });

  it("reads a scan that has found files but finished none", () => {
    expect(parseIndexProgressSegment("Indexing memory files… 0/31 · elapsed 0:00 0%"))
      .toEqual({ filesDone: 0, filesTotal: 31 });
  });

  it("says nothing for a phase with no counts, or for anything that is not the reporter", () => {
    expect(parseIndexProgressSegment("Loading vector extension… · elapsed 0:00 0%")).toBeNull();
    expect(parseIndexProgressSegment("Indexing memory… 0%")).toBeNull();
    expect(parseIndexProgressSegment("Memory index updated (main): 601 files indexed.")).toBeNull();
    expect(parseIndexProgressSegment("Sources: memory (MEMORY.md + /tmp/2024/10/*.md)")).toBeNull();
  });

  it("refuses a count that would draw a bar past its end", () => {
    expect(parseIndexProgressSegment("Indexing memory files… 7/3 · elapsed 0:01 100%")).toBeNull();
    expect(parseIndexProgressSegment("Indexing memory files… 0/0 · elapsed 0:01 0%")).toBeNull();
  });
});

describe("the reader over the PTY stream", () => {
  it("follows the captured transcript to its last count", () => {
    const reader = createIndexProgressReader();
    reader.push(TRANSCRIPT.toString("utf8"));
    expect(reader.latest()).toEqual({ filesDone: 601, filesTotal: 601 });
  });

  it("moves as the transcript arrives, whatever the chunk boundaries", () => {
    const reader = createIndexProgressReader();
    const seen: string[] = [];
    // One byte at a time is the harshest split there is: it cuts every
    // multibyte "…" and "·" and every count in half.
    const decoder = new TextDecoder("utf-8");
    for (const byte of TRANSCRIPT) {
      reader.push(decoder.decode(Uint8Array.of(byte), { stream: true }));
      const now = reader.latest();
      const label = now ? `${now.filesDone}/${now.filesTotal}` : "none";
      if (seen[seen.length - 1] !== label) seen.push(label);
    }
    expect(seen).toEqual(["none", "0/601", "65/601", "66/601", "601/601"]);
  });

  it("keeps a tail of what the CLI said, with the terminal's control bytes gone", () => {
    const reader = createIndexProgressReader();
    reader.push(TRANSCRIPT.toString("utf8"));
    const tail = reader.tail();
    expect(tail).not.toMatch(/\x1b/);
    expect(tail).not.toContain("\r");
    const lines = tail.split("\n").map((line) => line.trim()).filter(Boolean);
    expect(lines[lines.length - 1]).toBe("Memory index updated (main): 601 files indexed.");
  });

  it("bounds the tail however much the CLI prints", () => {
    const reader = createIndexProgressReader();
    for (let i = 0; i < 2_000; i += 1) reader.push(`line ${i} of a very chatty run\n`);
    expect(reader.tail().length).toBeLessThanOrEqual(4_000);
    expect(reader.tail()).toContain("line 1999");
  });
});

describe("the PTY host", () => {
  it("runs the command through sh with every argument quoted, and returns its exit code", () => {
    const args = ptyHostArgs(["flock", "--no-fork", "/tmp/a lock", "/opt/it's/openclaw", "memory", "index"]);
    expect(args.slice(0, 3)).toEqual(["-q", "-e", "-c"]);
    expect(args[3]).toBe(`exec 'flock' '--no-fork' '/tmp/a lock' '/opt/it'\\''s/openclaw' 'memory' 'index'`);
    // The typescript file: nothing is kept.
    expect(args[4]).toBe("/dev/null");
  });
});

describe("counting the chunks the pass has written", () => {
  let dir = "";
  let db = "";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-index-progress-"));
    db = path.join(dir, "openclaw-agent.sqlite");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeIndex(file: string, chunks: number) {
    const handle = new DatabaseSync(file);
    handle.exec("PRAGMA journal_mode = WAL");
    handle.exec("CREATE TABLE memory_index_chunks (id TEXT PRIMARY KEY, path TEXT, text TEXT)");
    const insert = handle.prepare("INSERT INTO memory_index_chunks VALUES (?, ?, ?)");
    // One transaction: a commit per row is an fsync per row, and on a loaded
    // CI disk nine hundred of them outlasted the test's own time budget.
    handle.exec("BEGIN");
    for (let i = 0; i < chunks; i += 1) insert.run(`c${i}`, "memory/a.md", "text");
    handle.exec("COMMIT");
    return handle;
  }

  it("reads the live index while an incremental pass writes it", () => {
    const handle = makeIndex(db, 12);
    try {
      expect(countIndexChunks(db, Date.now() - 1_000)).toBe(12);
    } finally {
      handle.close();
    }
  });

  it("reads the scratch copy a full reindex builds, not the index it will replace", async () => {
    const live = makeIndex(db, 38);
    // An earlier pass's scratch file that was never cleaned up must not be
    // mistaken for this one's.
    const stale = `${db}.memory-reindex-00000000-0000-4000-8000-000000000000`;
    const staleHandle = makeIndex(stale, 900);
    staleHandle.close();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(stale, old, old);
    const startedAtMs = Date.now() - 500;
    const scratch = makeIndex(`${db}.memory-reindex-6f1c2c1e-9d5b-4b58-a1ef-3f1d3a9b2c10`, 5);
    try {
      expect(countIndexChunks(db, startedAtMs)).toBe(5);
    } finally {
      scratch.close();
      live.close();
    }
  });

  it("counts nothing of a rebuild's until its scratch copy exists — not the index it will replace", () => {
    const live = makeIndex(db, 38);
    try {
      expect(countIndexChunks(db, Date.now() - 500, { rebuild: true })).toBeNull();
      expect(countIndexChunks(db, Date.now() - 500)).toBe(38);
    } finally {
      live.close();
    }
  });

  it("answers null, never a guess, when there is nothing it can read", async () => {
    expect(countIndexChunks(db, Date.now())).toBeNull();
    await fs.writeFile(db, "not a database");
    expect(countIndexChunks(db, Date.now())).toBeNull();
  });
});

describe("where the agent's index lives", () => {
  it("follows OpenClaw's own state directory, and a test's override first", () => {
    expect(openclawAgentDbPath({ OPENCLAW_STATE_DIR: "/srv/oc" }))
      .toBe("/srv/oc/agents/main/agent/openclaw-agent.sqlite");
    expect(openclawAgentDbPath({ CLAWKEEP_MEMORY_AGENT_DB: "/x/y.sqlite", OPENCLAW_STATE_DIR: "/srv/oc" }))
      .toBe("/x/y.sqlite");
    expect(openclawAgentDbPath({}))
      .toBe(path.join(os.homedir(), ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite"));
  });
});
