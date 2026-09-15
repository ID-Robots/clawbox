import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

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
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: async () => owner.value }));

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
  followed.mockClear().mockResolvedValue({ ok: true, error: undefined });
  stopped.mockClear();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
