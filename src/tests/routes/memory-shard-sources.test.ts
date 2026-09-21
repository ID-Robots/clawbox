/**
 * Memory Shard's new owner-only routes.
 *
 * The property that matters: the ASSISTANT must not be able to switch the index
 * on, widen what it reads, or move where the owner's memories are embedded.
 * Middleware admits the MCP bearer on every /setup-api path and the agent holds
 * it, so each of these routes refuses in-handler with hasOwnerSession — the same
 * rule as coding-agent/enable. (The three memory routes that existed before this
 * have no such check at all, which is how the agent can start a full reindex
 * today; that is noted for a separate change.)
 *
 * The provider switch also has to be OUR PAGE's: the owner's browser attaches
 * the session cookie to a POST any other site fires at the box, and this route
 * and embed/install are one wizard flow, so a page refused the download must
 * not be able to move the index onto a model that is not there.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { hasOwnerSession } from "@/lib/owner-session";

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => false) }));

/**
 * The OpenClaw config as the CLI would hold it, in memory: `readConfig` and
 * `readConfigStrict` answer it — the strict one throwing while a test says
 * the file is unreadable, the way the real one does for an EACCES or a file
 * caught half-written — and `runOpenclawConfigSetBatch` writes the extraPaths
 * key into it, slowly when a test asks for the ~5 s the real spawn costs, and
 * failing once when a test asks for that. Nothing here reads the box's own
 * ~/.openclaw.
 */
const cli = vi.hoisted(() => ({
  extraPaths: [] as string[],
  writes: [] as string[][],
  delayMs: 0,
  failNext: false,
  unreadable: false,
  /** The config turns unreadable the moment the next write has landed. */
  unreadableAfterWrite: false,
  reset() {
    this.extraPaths = []; this.writes = []; this.delayMs = 0;
    this.failNext = false; this.unreadable = false; this.unreadableAfterWrite = false;
  },
}));
vi.mock("@/lib/openclaw-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openclaw-config")>("@/lib/openclaw-config");
  const held = () => ({ memory: { search: { extraPaths: [...cli.extraPaths] } } });
  return {
    ...actual,
    readConfig: vi.fn(async () => (cli.unreadable ? {} : held())),
    readConfigStrict: vi.fn(async () => {
      if (cli.unreadable) throw new Error("EACCES: permission denied, open 'openclaw.json'");
      return held();
    }),
    runOpenclawConfigSetBatch: vi.fn(async (batch: readonly (readonly string[])[]) => {
      if (cli.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, cli.delayMs));
      if (cli.failNext) {
        cli.failNext = false;
        throw new Error("openclaw config set timed out");
      }
      for (const [key, value] of batch) {
        if (key !== "memory.search.extraPaths") continue;
        const next = JSON.parse(value) as string[];
        cli.writes.push(next);
        cli.extraPaths = next;
      }
      if (cli.unreadableAfterWrite) {
        cli.unreadableAfterWrite = false;
        cli.unreadable = true;
      }
    }),
  };
});

const switchToLocalEmbeddings = vi.hoisted(() => vi.fn(async () => {}));
const invalidateMemoryStatusCache = vi.hoisted(() => vi.fn(() => {}));
vi.mock("@/lib/clawkeep-memory", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clawkeep-memory")>("@/lib/clawkeep-memory");
  return { ...actual, invalidateMemoryStatusCache };
});
vi.mock("@/lib/memory-shard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/memory-shard")>("@/lib/memory-shard");
  return { ...actual, switchToLocalEmbeddings };
});

afterEach(() => {
  vi.mocked(hasOwnerSession).mockReset().mockResolvedValue(false);
  switchToLocalEmbeddings.mockClear();
  invalidateMemoryStatusCache.mockClear();
  cli.reset();
});

const url = (p: string) => `http://localhost/setup-api/clawkeep/memory/${p}`;

describe("owner-only gates", () => {
  it("refuses the switch without an owner session", async () => {
    const { POST } = await import("@/app/setup-api/clawkeep/memory/enable/route");
    const res = await POST(new Request(url("enable"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
  });

  it("refuses the embedding-provider switch without an owner session", async () => {
    const { POST } = await import("@/app/setup-api/clawkeep/memory/provider/route");
    const res = await POST(new Request(url("provider"), { method: "POST" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(switchToLocalEmbeddings).not.toHaveBeenCalled();
  });

  it("refuses reading or changing the indexed folders without an owner session", async () => {
    const { NextRequest } = await import("next/server");
    const mod = await import("@/app/setup-api/clawkeep/memory/sources/route");
    for (const [method, call] of [
      ["GET", () => mod.GET(new NextRequest(url("sources")))],
      ["POST", () => mod.POST(new NextRequest(url("sources"), { method: "POST", body: JSON.stringify({ path: "/home/clawbox/Documents" }) }))],
      ["DELETE", () => mod.DELETE(new NextRequest(url("sources"), { method: "DELETE", body: JSON.stringify({ path: "/home/clawbox/Documents" }) }))],
    ] as const) {
      const res = await call();
      expect(res.status, method).toBe(403);
    }
  });
});

describe("the provider switch's origin guard", () => {
  const post = (headers: Record<string, string>) =>
    new Request(url("provider"), { method: "POST", headers: { host: "localhost", ...headers } });

  it("refuses a cross-site POST that carries the owner's session, before anything is written", async () => {
    vi.mocked(hasOwnerSession).mockResolvedValue(true);
    const { POST } = await import("@/app/setup-api/clawkeep/memory/provider/route");
    const res = await POST(post({ origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "cross_origin" });
    expect(switchToLocalEmbeddings).not.toHaveBeenCalled();
  });

  it("refuses a browser that says cross-site even without an Origin", async () => {
    vi.mocked(hasOwnerSession).mockResolvedValue(true);
    const { POST } = await import("@/app/setup-api/clawkeep/memory/provider/route");
    const res = await POST(post({ "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "cross_origin" });
    expect(switchToLocalEmbeddings).not.toHaveBeenCalled();
  });

  it("lets the box's own page through — the guard must not refuse the wizard", async () => {
    vi.mocked(hasOwnerSession).mockResolvedValue(true);
    const { POST } = await import("@/app/setup-api/clawkeep/memory/provider/route");
    const res = await POST(post({ origin: "http://localhost" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: expect.any(String), model: expect.any(String) });
    expect(switchToLocalEmbeddings).toHaveBeenCalledTimes(1);
  });
});

describe("the state module stays client-safe", () => {
  it("carries the constants without importing the CLI driver", async () => {
    // A client component importing a VALUE from a module that spawns processes
    // pulls child_process into the browser bundle and fails the build — that
    // exact mistake took the desktop down earlier in this session.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/memory-shard-state.ts"), "utf8");
    // IMPORTS only — the file's own comment names child_process to explain why
    // this split exists, and matching the prose would fail on the explanation
    // rather than on the hazard.
    const imports = src.match(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?$/gm) ?? [];
    expect(imports.join("\n")).not.toMatch(/child_process|openclaw-config|config-store|clawkeep-memory/);
    const state = await import("@/lib/memory-shard-state");
    // llama-server's --alias, sent as `model` — not an ollama tag any more.
    expect(state.LOCAL_EMBEDDING_MODEL).toBe("qwen3-embedding-0.6b");
    expect(state.EXTRA_PATHS_CONFIG_PATH).toBe("memory.search.extraPaths");
    // PDFs are extracted BY CLAWBOX; OpenClaw's indexer reads .md and nothing
    // else, so these two lists must not be confused.
    expect([...state.INDEXABLE_EXTENSIONS]).toEqual([".md"]);
    expect([...state.EXTRACTABLE_EXTENSIONS]).toContain(".pdf");
  });
});

describe("folder writes are serialised (ms-findings F-A)", () => {
  // The queue is module state, so every test here shares it; each one drains
  // its own turns before it ends, and the afterEach resets the CLI side.
  it("runs an add and a remove that overlap one after the other, each on the other's result, one write each, in order", async () => {
    const { mutateExtraPaths } = await import("@/lib/memory-shard");
    cli.extraPaths = ["/home/owner/a"];
    cli.delayMs = 20;

    const add = mutateExtraPaths((current) => [...current, "/home/owner/b"]);
    const remove = mutateExtraPaths((current) => current.filter((p) => p !== "/home/owner/a"));
    const [afterAdd, afterRemove] = await Promise.all([add, remove]);

    // Unserialised, both read ["/a"] before either write and the remove's
    // write lands last — `[]`, the folder the add answered with gone.
    expect(cli.writes).toEqual([["/home/owner/a", "/home/owner/b"], ["/home/owner/b"]]);
    expect(afterAdd).toEqual(["/home/owner/a", "/home/owner/b"]);
    expect(afterRemove).toEqual(["/home/owner/b"]);
    expect(cli.extraPaths).toEqual(["/home/owner/b"]);
  });

  it("writes nothing when the mutation leaves the list as it was, and answers the list it read", async () => {
    const { mutateExtraPaths } = await import("@/lib/memory-shard");
    cli.extraPaths = ["/home/owner/a"];
    // An idempotent add: the folder is already there.
    expect(await mutateExtraPaths((current) => (current.includes("/home/owner/a") ? current : [...current, "/home/owner/a"])))
      .toEqual(["/home/owner/a"]);
    expect(cli.writes).toEqual([]);
  });

  it("refuses to mutate a list it could not read, rather than reading it as empty", async () => {
    // `readExtraPaths` forgives an unreadable config as `[]` for the wizard's
    // first paint. Inside a mutation that `[]` would be WRITTEN: an add would
    // save a one-entry list over every folder the owner had chosen, a remove
    // would answer "no folders" over a list still on disk.
    const { mutateExtraPaths, ExtraPathsUnreadableError } = await import("@/lib/memory-shard");
    cli.extraPaths = ["/home/owner/a"];
    cli.unreadable = true;

    await expect(mutateExtraPaths((current) => [...current, "/home/owner/b"])).rejects.toBeInstanceOf(ExtraPathsUnreadableError);
    await expect(mutateExtraPaths((current) => current.filter((p) => p !== "/home/owner/a"))).rejects.toBeInstanceOf(ExtraPathsUnreadableError);
    expect(cli.writes).toEqual([]);

    // Readable again: the queue is free and the list is what it always was.
    cli.unreadable = false;
    expect(await mutateExtraPaths((current) => [...current, "/home/owner/b"])).toEqual(["/home/owner/a", "/home/owner/b"]);
  });

  it("answers the written list when only the read-back after a landed write fails", async () => {
    // The pre-write read failing means nothing was touched; the read-back
    // failing means the CLI has already saved the list. The two must not
    // share an answer: reported as `read_failed`, a folder that IS on disk
    // would be shown as not added (CodeRabbit on PR #758).
    const { mutateExtraPaths, ExtraPathsUnreadableError } = await import("@/lib/memory-shard");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cli.extraPaths = ["/home/owner/a"];
    cli.unreadableAfterWrite = true;

    const answered = mutateExtraPaths((current) => [...current, "/home/owner/b"]);
    await expect(answered).resolves.toEqual(["/home/owner/a", "/home/owner/b"]);
    expect(cli.writes).toEqual([["/home/owner/a", "/home/owner/b"]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be read back"), expect.any(Error));

    // Still unreadable for the NEXT mutation, whose pre-write read is the
    // one that must refuse.
    await expect(mutateExtraPaths((current) => [...current, "/home/owner/c"])).rejects.toBeInstanceOf(ExtraPathsUnreadableError);
    expect(cli.writes).toHaveLength(1);
    warn.mockRestore();
  });

  it("does not let a mutation whose write threw block the next one", async () => {
    const { mutateExtraPaths } = await import("@/lib/memory-shard");
    cli.extraPaths = [];
    cli.failNext = true;

    const failed = mutateExtraPaths((current) => [...current, "/home/owner/a"]);
    const next = mutateExtraPaths((current) => [...current, "/home/owner/b"]);

    await expect(failed).rejects.toThrow("timed out");
    // The failed turn wrote nothing, so the next one starts from the list as
    // it was — and it runs at all, which is the point.
    expect(await next).toEqual(["/home/owner/b"]);
    expect(cli.writes).toEqual([["/home/owner/b"]]);
  });

  describe("through the route", () => {
    // A scratch browse root, so the route's containment check has a real
    // folder to accept without the test reading the owner's home.
    let root: string;
    let docs: string;
    let previousRoot: string | undefined;
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-memory-sources-"));
      docs = path.join(root, "docs");
      fs.mkdirSync(docs);
      previousRoot = process.env.FILES_ROOT;
      process.env.FILES_ROOT = root;
    });
    afterAll(() => {
      if (previousRoot === undefined) delete process.env.FILES_ROOT;
      else process.env.FILES_ROOT = previousRoot;
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("ends with the state the last call asked for when POST and DELETE overlap", async () => {
      vi.mocked(hasOwnerSession).mockResolvedValue(true);
      const { NextRequest } = await import("next/server");
      const { POST, DELETE } = await import("@/app/setup-api/clawkeep/memory/sources/route");
      cli.extraPaths = ["/home/owner/old"];
      cli.delayMs = 20;

      const add = POST(new NextRequest(url("sources"), { method: "POST", body: JSON.stringify({ path: docs }) }));
      const remove = DELETE(new NextRequest(url("sources"), { method: "DELETE", body: JSON.stringify({ path: "/home/owner/old" }) }));
      const [addRes, removeRes] = await Promise.all([add, remove]);

      expect(addRes.status).toBe(200);
      expect(removeRes.status).toBe(200);
      // Exactly one write each, and the list on disk is what both asked for
      // together: the new folder in, the old one out. On the box the same two
      // requests ended with `extraPaths: []`.
      expect(cli.writes).toHaveLength(2);
      const real = fs.realpathSync(docs);
      expect(cli.extraPaths).toEqual([real]);
      // Whichever answered last carries the settled list.
      const last = cli.writes[1];
      expect(last).toEqual([real]);
    });

    it("answers a stable kind when the write itself fails, rather than a bare 500", async () => {
      vi.mocked(hasOwnerSession).mockResolvedValue(true);
      const { NextRequest } = await import("next/server");
      const { POST, DELETE } = await import("@/app/setup-api/clawkeep/memory/sources/route");
      cli.extraPaths = ["/home/owner/old"];

      cli.failNext = true;
      const add = await POST(new NextRequest(url("sources"), { method: "POST", body: JSON.stringify({ path: docs }) }));
      expect(add.status).toBe(500);
      expect(await add.json()).toMatchObject({ kind: "write_failed", error: expect.any(String) });

      cli.failNext = true;
      const remove = await DELETE(new NextRequest(url("sources"), { method: "DELETE", body: JSON.stringify({ path: "/home/owner/old" }) }));
      expect(remove.status).toBe(500);
      expect(await remove.json()).toMatchObject({ kind: "write_failed" });
      // Nothing landed, and the queue is free for the next request.
      expect(cli.extraPaths).toEqual(["/home/owner/old"]);
      const ok = await DELETE(new NextRequest(url("sources"), { method: "DELETE", body: JSON.stringify({ path: "/home/owner/old" }) }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ paths: [] });
    });

    it("answers success, with the folder in the list, when the write landed and only the read-back failed", async () => {
      vi.mocked(hasOwnerSession).mockResolvedValue(true);
      const { NextRequest } = await import("next/server");
      const { POST } = await import("@/app/setup-api/clawkeep/memory/sources/route");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      cli.extraPaths = ["/home/owner/old"];
      cli.unreadableAfterWrite = true;

      const add = await POST(new NextRequest(url("sources"), { method: "POST", body: JSON.stringify({ path: docs }) }));
      expect(add.status).toBe(200);
      const real = fs.realpathSync(docs);
      expect(await add.json()).toEqual({ paths: ["/home/owner/old", real] });
      // The list changed, so the status reading it feeds is stale.
      expect(invalidateMemoryStatusCache).toHaveBeenCalledTimes(1);
      expect(cli.extraPaths).toEqual(["/home/owner/old", real]);
      warn.mockRestore();
    });

    it("answers read_failed and writes nothing while openclaw.json cannot be read", async () => {
      vi.mocked(hasOwnerSession).mockResolvedValue(true);
      const { NextRequest } = await import("next/server");
      const { GET, POST, DELETE } = await import("@/app/setup-api/clawkeep/memory/sources/route");
      cli.extraPaths = ["/home/owner/old"];
      cli.unreadable = true;

      const add = await POST(new NextRequest(url("sources"), { method: "POST", body: JSON.stringify({ path: docs }) }));
      expect(add.status).toBe(500);
      expect(await add.json()).toMatchObject({ kind: "read_failed", error: expect.any(String) });

      const remove = await DELETE(new NextRequest(url("sources"), { method: "DELETE", body: JSON.stringify({ path: "/home/owner/old" }) }));
      expect(remove.status).toBe(500);
      expect(await remove.json()).toMatchObject({ kind: "read_failed" });

      // The owner's list is untouched — the whole point — and the lenient
      // GET still answers rather than failing the page.
      expect(cli.writes).toEqual([]);
      expect(cli.extraPaths).toEqual(["/home/owner/old"]);
      expect((await GET(new NextRequest(url("sources")))).status).toBe(200);
    });
  });
});
