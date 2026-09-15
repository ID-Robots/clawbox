import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * /setup-api/llamacpp/models — the GGUF library.
 *
 * Real files for the library itself (a removal has to actually free the disk)
 * and a fake `hf download`, because the point of this route is what it does
 * around the download: who may ask, what the Hub says it weighs, whether that
 * fits, and what is left behind when it fails.
 */

let modelDir: string;
const owner = { value: true };
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: async () => owner.value }));
vi.mock("@/lib/route-auth", () => ({ requireSession: async () => null }));

const disk = { free: 100 * 1024 * 1024 * 1024 as number | null };
vi.mock("@/lib/project-import", () => ({ freeBytes: async () => disk.free }));

const spec = { hfBin: "" };
vi.mock("@/lib/llamacpp-server", () => ({
  getLlamaCppLaunchSpec: () => ({
    modelDir,
    hfRepo: "google/gemma-4-E2B-it-qat-q4_0-gguf",
    hfFile: "gemma-4-E2B_q4_0-it.gguf",
    hfBinPath: spec.hfBin,
  }),
}));

/** The `hf download` child. */
const child = { code: 0, stderr: "", writes: null as string | null, bytes: 32 };
vi.mock("child_process", () => ({
  spawn: () => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const errHandlers: ((chunk: string) => void)[] = [];
    const fake = {
      pid: 99,
      stdout: { setEncoding() {}, on() {} },
      stderr: { setEncoding() {}, on(_e: string, fn: (c: string) => void) { errHandlers.push(fn); } },
      on(event: string, fn: (...a: unknown[]) => void) { (handlers[event] ??= []).push(fn); return fake; },
    };
    // Everything in one tick, in the order a real child produces it: output,
    // then whatever the download left on disk, then the exit. Two timers of
    // equal delay would fire in registration order, which put `close` ahead of
    // the stderr the failure's reason comes from.
    setTimeout(() => {
      if (child.stderr) for (const fn of errHandlers) fn(child.stderr);
      if (child.writes) {
        fs.mkdirSync(path.dirname(path.join(modelDir, child.writes)), { recursive: true });
        fs.writeFileSync(path.join(modelDir, child.writes), "x".repeat(child.bytes));
      }
      for (const fn of handlers.close ?? []) fn(child.code);
    }, 1);
    return fake;
  },
}));

const hubTree = { entries: [] as unknown[], status: 200 };

async function load() {
  vi.resetModules();
  return import("@/app/setup-api/llamacpp/models/route");
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/setup-api/llamacpp/models", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readStream(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-gguf-"));
  spec.hfBin = path.join(modelDir, "hf");
  fs.writeFileSync(spec.hfBin, "#!/bin/sh\n", { mode: 0o755 });
  owner.value = true;
  disk.free = 100 * 1024 * 1024 * 1024;
  child.code = 0;
  child.stderr = "";
  child.writes = "other.gguf";
  child.bytes = 32;
  hubTree.status = 200;
  hubTree.entries = [{ path: "other.gguf", size: 135, lfs: { size: 4 * 1024 * 1024 * 1024 } }];
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: hubTree.status === 200,
    status: hubTree.status,
    json: async () => hubTree.entries,
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(modelDir, { recursive: true, force: true });
});

describe("GET /setup-api/llamacpp/models", () => {
  it("lists the library and marks the one the box answers with", async () => {
    fs.writeFileSync(path.join(modelDir, "gemma-4-E2B_q4_0-it.gguf"), "x".repeat(10));
    fs.writeFileSync(path.join(modelDir, "other.gguf"), "x".repeat(20));
    fs.writeFileSync(path.join(modelDir, "notes.txt"), "ignored");

    const { GET } = await load();
    const body = await (await GET(new Request("http://localhost/setup-api/llamacpp/models"))).json();

    const names = body.files.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(["gemma-4-E2B_q4_0-it.gguf", "other.gguf"]);
    expect(body.files.find((f: { name: string }) => f.name === "gemma-4-E2B_q4_0-it.gguf").inUse).toBe(true);
    expect(body.downloaderReady).toBe(true);
  });

  it("answers the size the Hub reports, taking the LFS size and not the pointer's", async () => {
    // The tree's plain `size` for an LFS object is the pointer file's few
    // hundred bytes — as a disk check that waves a 4 GB download straight
    // through.
    const { GET } = await load();
    const body = await (await GET(new Request(
      "http://localhost/setup-api/llamacpp/models?repo=owner/name&file=other.gguf",
    ))).json();

    expect(body.bytes).toBe(4 * 1024 * 1024 * 1024);
    expect(body.probe).toBe("ok");
    expect(body.fits).toBe(true);
  });

  it("says the download does not fit rather than guessing", async () => {
    disk.free = 2 * 1024 * 1024 * 1024;
    const { GET } = await load();
    const body = await (await GET(new Request(
      "http://localhost/setup-api/llamacpp/models?repo=owner/name&file=other.gguf",
    ))).json();
    expect(body.fits).toBe(false);
  });

  it("asks the Hub for the repository by its real path, not a percent-encoded one", async () => {
    // `/api/models/owner%2Fname/tree/main` is a different path and answers 404.
    const { GET } = await load();
    await GET(new Request("http://localhost/setup-api/llamacpp/models?repo=owner%2Fname&file=other.gguf"));

    const asked = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
    expect(asked).toBe("https://huggingface.co/api/models/owner/name/tree/main?recursive=1");
  });

  it("keeps the outbound size probe to the owner, while the listing stays open to the session", async () => {
    owner.value = false;
    const { GET } = await load();

    const probe = await GET(new Request("http://localhost/setup-api/llamacpp/models?repo=owner/name&file=other.gguf"));
    expect(probe.status).toBe(403);
    expect((await probe.json()).code).toBe("owner_only");
    // Nothing left this box.
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

    const listing = await GET(new Request("http://localhost/setup-api/llamacpp/models"));
    expect(listing.status).toBe(200);
  });

  it("refuses a reference that is not owner/name plus a .gguf", async () => {
    const { GET } = await load();
    for (const query of ["repo=owner&file=other.gguf", "repo=owner/name&file=README.md", "repo=owner/../x&file=a.gguf"]) {
      const res = await GET(new Request(`http://localhost/setup-api/llamacpp/models?${query}`));
      expect(res.status).toBe(400);
    }
  });

  it("reports a Hub that would not answer as a size it cannot show", async () => {
    hubTree.status = 503;
    const { GET } = await load();
    const body = await (await GET(new Request(
      "http://localhost/setup-api/llamacpp/models?repo=owner/name&file=other.gguf",
    ))).json();

    expect(body.probe).toBe("unreachable");
    expect(body.bytes).toBeNull();
    // Not a pass dressed up as a measurement.
    expect(body.fits).toBeNull();
  });
});

describe("POST /setup-api/llamacpp/models", () => {
  it("refuses the MCP bearer and another site's page", async () => {
    const { POST } = await load();

    owner.value = false;
    expect((await POST(post({ repo: "owner/name", file: "other.gguf" }))).status).toBe(403);

    owner.value = true;
    const elsewhere = await POST(post({ repo: "owner/name", file: "other.gguf" }, { Origin: "http://evil.example" }));
    expect(elsewhere.status).toBe(403);
  });

  it("refuses a download that would not fit, before a byte is fetched", async () => {
    disk.free = 2 * 1024 * 1024 * 1024;
    const { POST } = await load();
    const res = await POST(post({ repo: "owner/name", file: "other.gguf" }));

    expect(res.status).toBe(507);
    expect((await res.json()).code).toBe("disk_full");
    expect(fs.existsSync(path.join(modelDir, "other.gguf"))).toBe(false);
  });

  it("refuses when the repository or the file is not there", async () => {
    hubTree.status = 404;
    const { POST } = await load();
    expect((await POST(post({ repo: "owner/name", file: "other.gguf" }))).status).toBe(404);

    hubTree.status = 200;
    hubTree.entries = [{ path: "something-else.gguf", lfs: { size: 10 } }];
    const missing = await load();
    const res = await missing.POST(post({ repo: "owner/name", file: "other.gguf" }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("no_such_file");
  });

  it("refuses when the downloader is not on the box", async () => {
    fs.rmSync(spec.hfBin);
    const { POST } = await load();
    const res = await POST(post({ repo: "owner/name", file: "other.gguf" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("no_downloader");
  });

  it("refuses a file that is already in the library", async () => {
    fs.writeFileSync(path.join(modelDir, "other.gguf"), "x");
    const { POST } = await load();
    const res = await POST(post({ repo: "owner/name", file: "other.gguf" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("already_here");
  });

  it("streams the download and ends with the file's real size", async () => {
    child.bytes = 4096;
    const { POST } = await load();
    const lines = await readStream(await POST(post({ repo: "owner/name", file: "other.gguf" })));

    expect(lines[0]).toMatchObject({ total: 4 * 1024 * 1024 * 1024 });
    expect(lines.at(-1)).toMatchObject({ success: true, file: "other.gguf", bytes: 4096 });
    expect(fs.existsSync(path.join(modelDir, "other.gguf"))).toBe(true);
  });

  it("leaves nothing half-written behind when the download fails", async () => {
    // A truncated GGUF is a file llama-server would load and crash on.
    child.code = 1;
    child.stderr = "hf: connection reset\n";
    const { POST } = await load();
    const lines = await readStream(await POST(post({ repo: "owner/name", file: "other.gguf" })));

    expect(lines.at(-1)).toMatchObject({ error: "hf: connection reset" });
    expect(fs.existsSync(path.join(modelDir, "other.gguf"))).toBe(false);
  });

  it("does not call a download that left no file a success", async () => {
    child.writes = null;
    const { POST } = await load();
    const lines = await readStream(await POST(post({ repo: "owner/name", file: "other.gguf" })));
    expect(lines.at(-1)?.success).toBeUndefined();
    expect(String(lines.at(-1)?.error)).toContain("not in the library");
  });
});

describe("DELETE /setup-api/llamacpp/models", () => {
  function del(file: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://localhost/setup-api/llamacpp/models?file=${encodeURIComponent(file)}`, {
      method: "DELETE",
      headers,
    });
  }

  it("frees the disk and re-reads the library", async () => {
    fs.writeFileSync(path.join(modelDir, "other.gguf"), "x".repeat(2048));
    const { DELETE } = await load();
    const res = await DELETE(del("other.gguf"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.freedBytes).toBe(2048);
    expect(body.files).toEqual([]);
    expect(fs.existsSync(path.join(modelDir, "other.gguf"))).toBe(false);
  });

  it("refuses the model the box answers with", async () => {
    fs.writeFileSync(path.join(modelDir, "gemma-4-E2B_q4_0-it.gguf"), "x");
    const { DELETE } = await load();
    const res = await DELETE(del("gemma-4-E2B_q4_0-it.gguf"));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("in_use");
    expect(fs.existsSync(path.join(modelDir, "gemma-4-E2B_q4_0-it.gguf"))).toBe(true);
  });

  it("refuses a name with a directory in it before anything is touched", async () => {
    const { DELETE } = await load();
    for (const name of ["../escape.gguf", "sub/other.gguf", "notes.txt"]) {
      const res = await DELETE(del(name));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid");
    }
  });

  it("answers 404 for a model that is not there", async () => {
    const { DELETE } = await load();
    expect((await DELETE(del("gone.gguf"))).status).toBe(404);
  });

  it("refuses anyone but the owner on this box's own pages", async () => {
    owner.value = false;
    const { DELETE } = await load();
    expect((await DELETE(del("other.gguf"))).status).toBe(403);
  });
});
