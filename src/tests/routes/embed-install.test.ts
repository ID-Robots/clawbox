import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resetBackgroundTasksForTests } from "@/lib/background-tasks";

/**
 * /setup-api/embed/install — the memory-search model's own two verbs.
 *
 * The POST already existed for the Memory Shard wizard; what is pinned here is
 * what Settings → Local AI added: `{force}` (a box whose copy is truncated has
 * no other repair that is not a terminal job) and the DELETE that gives the
 * disk back — which has to stop the unit first, because llama-server holds the
 * weights open and unlinking underneath it frees nothing until it exits.
 */

let modelPath: string;
const owner = { value: true };
vi.mock("@/lib/owner-session", () => ({ hasPersonSession: async () => owner.value }));

const followed = vi.fn(async () => ({ ok: true as boolean, error: undefined as string | undefined }));
vi.mock("@/lib/root-step-follow", () => ({ followRootStep: (...a: unknown[]) => followed(...(a as [])) }));

const stopped = vi.fn(async () => {});
vi.mock("@/lib/local-ai-runtime", () => ({ stopLocalAiProvider: (...a: unknown[]) => stopped(...(a as [])) }));

vi.mock("@/lib/embed-server", () => ({
  getEmbedLaunchSpec: () => ({ modelPath }),
  getEmbedProvisioningStatus: async () => {
    const present = fs.existsSync(modelPath);
    return { installed: present, modelAvailable: present, binaryAvailable: true, modelBytes: present ? fs.statSync(modelPath).size : null };
  },
}));

async function load() {
  vi.resetModules();
  return import("@/app/setup-api/embed/install/route");
}

async function readStream(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-embed-"));
  modelPath = path.join(dir, "qwen3-embedding.gguf");
  owner.value = true;
  followed.mockReset().mockResolvedValue({ ok: true, error: undefined });
  stopped.mockClear();
  resetBackgroundTasksForTests();
});

afterEach(() => {
  resetBackgroundTasksForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (body?: unknown) => new Request("http://localhost/x", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
/** Where "Download again" keeps the old copy: beside the models directory. */
const aside = () => path.join(path.dirname(path.dirname(modelPath)), `${path.basename(modelPath)}.previous`);

describe("POST", () => {
  it("does not spend a root unit on a model that is already here", async () => {
    fs.writeFileSync(modelPath, "weights");
    const { POST } = await load();
    const lines = await readStream(await POST(new Request("http://localhost/x", { method: "POST" })));

    expect(followed).not.toHaveBeenCalled();
    expect(lines.at(-1)).toMatchObject({ success: true });
  });

  it("runs the step again when the owner asked for it", async () => {
    fs.writeFileSync(modelPath, "truncated");
    const { POST } = await load();
    const res = await POST(new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    }));
    await readStream(res);

    expect(followed).toHaveBeenCalledWith("embed_model", expect.anything());
  });

  it("fetches when the model is absent", async () => {
    const { POST } = await load();
    await readStream(await POST(new Request("http://localhost/x", { method: "POST" })));
    expect(followed).toHaveBeenCalledWith("embed_model", expect.anything());
  });

  it("does not call a step that left no model a success", async () => {
    // install.sh's step exits 0 when the Hugging Face CLI is missing; the
    // stream used to close {success} over a box with no model.
    const { POST } = await load();
    const lines = await readStream(await POST(post()));
    expect(lines.at(-1)).toMatchObject({ error: expect.stringContaining("not on this box") });
    expect(lines.at(-1)?.success).toBeUndefined();
  });

  it("closes {success} once the step has put the model on the box, and names the task first", async () => {
    followed.mockImplementation(async () => {
      fs.writeFileSync(modelPath, "weights");
      return { ok: true, error: undefined };
    });
    const { POST } = await load();
    const lines = await readStream(await POST(post()));
    expect(lines[0]).toMatchObject({ taskId: expect.any(String), kind: "embed-model-download" });
    expect(lines.at(-1)).toMatchObject({ success: true, status: "The memory-search model is on this box." });
  });

  it("moves the old copy aside for Download again, and puts it back when the new one never arrives", async () => {
    fs.writeFileSync(modelPath, "truncated");
    let sawAside = false;
    followed.mockImplementation(async () => {
      // The step answers "already cached" for any file at the path: it must not see one.
      sawAside = !fs.existsSync(modelPath) && fs.existsSync(aside());
      return { ok: false, error: "Error: failed to download the memory-search model" };
    });
    const { POST } = await load();
    const lines = await readStream(await POST(post({ force: true })));

    expect(sawAside).toBe(true);
    expect(lines.at(-1)).toMatchObject({ error: "Error: failed to download the memory-search model" });
    expect(fs.readFileSync(modelPath, "utf-8")).toBe("truncated");
    expect(fs.existsSync(aside())).toBe(false);
    expect(stopped).not.toHaveBeenCalled();
  });

  it("replaces the copy on Download again, drops the old one and stops the embedder holding it", async () => {
    fs.writeFileSync(modelPath, "truncated");
    followed.mockImplementation(async () => {
      fs.writeFileSync(modelPath, "fresh weights");
      return { ok: true, error: undefined };
    });
    const { POST } = await load();
    const lines = await readStream(await POST(post({ force: true })));

    expect(lines.at(-1)).toMatchObject({ success: true });
    expect(fs.readFileSync(modelPath, "utf-8")).toBe("fresh weights");
    expect(fs.existsSync(aside())).toBe(false);
    expect(stopped).toHaveBeenCalledWith("embed");
  });

  it("puts back a copy a download that died left aside, before deciding anything", async () => {
    fs.writeFileSync(aside(), "the old copy");
    followed.mockImplementation(async () => ({ ok: true, error: undefined }));
    const { POST } = await load();
    const lines = await readStream(await POST(post()));
    expect(fs.readFileSync(modelPath, "utf-8")).toBe("the old copy");
    expect(lines.at(-1)).toMatchObject({ success: true });
  });

  it("runs on when the stream that started it goes, and a second POST follows the same download", async () => {
    let release!: () => void;
    followed.mockImplementation(() => new Promise((resolve) => {
      release = () => {
        fs.writeFileSync(modelPath, "weights");
        resolve({ ok: true, error: undefined });
      };
    }));
    const { POST, DELETE } = await load();
    const first = await POST(post());
    const reader = first.body!.getReader();
    const firstLine = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("\n")[0]);
    await reader.cancel();
    await new Promise((r) => setImmediate(r));

    const busy = await DELETE(new Request("http://localhost/setup-api/embed/install", { method: "DELETE" }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "busy", taskId: firstLine.taskId });

    const second = await POST(post());
    await vi.waitFor(() => expect(followed).toHaveBeenCalled());
    release();
    const lines = await readStream(second);
    expect(lines[0].taskId).toBe(firstLine.taskId);
    expect(lines.at(-1)).toMatchObject({ success: true, taskId: firstLine.taskId });
    expect(followed).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE", () => {
  function del(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/setup-api/embed/install", { method: "DELETE", headers });
  }

  it("stops the engine before it unlinks, and says how much came back", async () => {
    fs.writeFileSync(modelPath, "x".repeat(4096));
    const { DELETE } = await load();
    const res = await DELETE(del());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.freedBytes).toBe(4096);
    expect(body.installed).toBe(false);
    expect(stopped).toHaveBeenCalledWith("embed");
    expect(fs.existsSync(modelPath)).toBe(false);
  });

  it("drops a copy a dead Download again left aside, so it is not put back later", async () => {
    fs.writeFileSync(modelPath, "weights");
    fs.writeFileSync(aside(), "old");
    const { DELETE } = await load();
    expect((await DELETE(del())).status).toBe(200);
    expect(fs.existsSync(aside())).toBe(false);
  });

  it("answers 404 when there is nothing to remove, and touches the engine either way not at all", async () => {
    const { DELETE } = await load();
    const res = await DELETE(del());

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
    expect(stopped).not.toHaveBeenCalled();
  });

  it("refuses the MCP bearer and another site's page", async () => {
    fs.writeFileSync(modelPath, "weights");
    const { DELETE } = await load();

    owner.value = false;
    expect((await DELETE(del())).status).toBe(403);

    owner.value = true;
    expect((await DELETE(del({ Origin: "http://evil.example" }))).status).toBe(403);
    expect(fs.existsSync(modelPath)).toBe(true);
  });
});
