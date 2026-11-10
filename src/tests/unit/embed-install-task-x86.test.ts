import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { BackgroundTaskContext } from "@/lib/background-tasks";

/**
 * The memory-search model's DEFAULT slot (Qwen3-Embedding-0.6B) on an x86 PC
 * (TASK-2418).
 *
 * Memory Shard → "On this box" failed on an x86 PC with "could not start its
 * root step embed_model … run sudo bash install-x64.sh --step
 * root_step_contract": the task asked the root launcher for `embed_model`,
 * which only install.sh (the appliance) implements. install-x64.sh does not
 * dispatch it and its root helper refuses it; the desktop integration refuses
 * it too. What is pinned here: on either x86 install the default slot is
 * fetched as the web server's own user, through the 4B's verified path, and
 * never through a root step — and the appliance still runs install.sh's
 * `embed_model`, exactly as before.
 */

const x64 = { install: false, desktop: false, broken: false };
const recordReads = vi.fn();
vi.mock("@/lib/x64-integration", () => ({
  hasX64Install: (dir: string) => {
    recordReads("install", dir);
    if (x64.broken) throw new Error("The x64 install record must be a small, root-owned file without group or other write access.");
    return x64.install;
  },
  hasX64DesktopIntegration: (dir: string) => {
    recordReads("desktop", dir);
    return x64.desktop;
  },
}));

let dir: string;
let modelsDir: string;
/** What .env names for the default slot; the shipped values unless a case moves them. */
const slot = { repo: "Qwen/Qwen3-Embedding-0.6B-GGUF", file: "Qwen3-Embedding-0.6B-Q8_0.gguf" };
const modelPath = () => path.join(modelsDir, slot.file);
vi.mock("@/lib/embed-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-server")>();
  return {
    ...actual,
    getEmbedLaunchSpec: () => ({
      modelId: "qwen3-embedding-0.6b",
      hfRepo: slot.repo,
      hfFile: slot.file,
      modelDir: modelsDir,
      modelPath: modelPath(),
    }),
    getEmbedModelDir: () => modelsDir,
    readActiveLocalEmbeddingModel: async () => ({ id: "qwen3-embedding-0.6b", quant: "Q8_0" }),
    getEmbedProvisioningStatus: async (spec: { modelPath: string }) => {
      const present = fs.existsSync(spec.modelPath);
      return { installed: present, modelAvailable: present, binaryAvailable: true, modelBytes: present ? fs.statSync(spec.modelPath).size : null };
    },
  };
});

const fetched = vi.fn();
const hashed = vi.fn();
vi.mock("@/lib/embed-model-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-model-fetch")>();
  return {
    ...actual,
    fetchVerifiedGguf: (...a: unknown[]) => fetched(...a),
    sha256OfFile: (...a: unknown[]) => hashed(...a),
  };
});

const stopped = vi.fn(async () => {});
vi.mock("@/lib/local-ai-runtime", () => ({ stopLocalAiProvider: (...a: unknown[]) => stopped(...(a as [])) }));

const CATALOG_SHA = "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439";
const CATALOG_BYTES = 639_150_592;

async function load() {
  vi.resetModules();
  return import("@/lib/embed-install-task");
}

/** The task's view of the world: every call it makes, and a rootStep that must not be asked on x86. */
function context() {
  const rootStep = vi.fn(async () => {
    fs.writeFileSync(modelPath(), "weights from install.sh");
    return { ok: true };
  });
  const statuses: string[] = [];
  const ctx = {
    id: "t1",
    signal: new AbortController().signal,
    waited: false,
    step: vi.fn(),
    status: (line: string) => statuses.push(line),
    log: vi.fn(),
    progress: vi.fn(),
    cancellable: vi.fn(),
    rootStep,
  };
  return { ctx: ctx as unknown as BackgroundTaskContext, rootStep, statuses };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-embed-x86-"));
  modelsDir = path.join(dir, "data", "embed", "models");
  fs.mkdirSync(modelsDir, { recursive: true });
  Object.assign(x64, { install: false, desktop: false, broken: false });
  Object.assign(slot, { repo: "Qwen/Qwen3-Embedding-0.6B-GGUF", file: "Qwen3-Embedding-0.6B-Q8_0.gguf" });
  recordReads.mockClear();
  stopped.mockClear();
  hashed.mockReset();
  fetched.mockReset().mockImplementation(async (opts: { dir: string; variant: { file: string } }) => {
    const dest = path.join(opts.dir, opts.variant.file);
    fs.writeFileSync(dest, "verified weights");
    return dest;
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the default slot on an x86 PC (TASK-2418)", () => {
  it.each([
    ["install-x64.sh", { install: true }],
    ["the desktop integration", { desktop: true }],
  ])("fetches the 0.6B as the web server's user on %s, verified, and asks no root step", async (_name, flags) => {
    Object.assign(x64, flags);
    const { embedModelDownloadTask } = await load();
    const task = embedModelDownloadTask({ force: false });
    const { ctx, rootStep } = context();

    const outcome = await task.run(ctx);

    expect(rootStep).not.toHaveBeenCalled();
    expect(fetched).toHaveBeenCalledTimes(1);
    const opts = fetched.mock.calls[0][0] as { repo: string; dir: string; variant: { file: string; sha256: string; bytes: number; quant: string } };
    expect(opts.repo).toBe("Qwen/Qwen3-Embedding-0.6B-GGUF");
    expect(opts.dir).toBe(modelsDir);
    // The catalog's own file and checksum: the fetch verifies against it
    // before the file is renamed into place.
    expect(opts.variant).toMatchObject({ quant: "Q8_0", file: "Qwen3-Embedding-0.6B-Q8_0.gguf", sha256: CATALOG_SHA, bytes: CATALOG_BYTES });
    expect(fs.readFileSync(modelPath(), "utf-8")).toBe("verified weights");
    expect(outcome).toEqual({ status: "The memory-search model is on this box." });
    // Resumable, so Cancel is offered; disk measured for the whole file plus the margin.
    expect(ctx.cancellable).toHaveBeenCalledWith(true);
    expect(task.needs?.diskBytes).toBe(CATALOG_BYTES + 512 * 1024 * 1024);
  });

  it("reads the records for THIS checkout", async () => {
    const before = process.env.CLAWBOX_ROOT;
    process.env.CLAWBOX_ROOT = "/home/clawbox/clawbox";
    try {
      x64.install = true;
      const { isX86PcInstall } = await load();
      expect(isX86PcInstall()).toBe(true);
      expect(recordReads).toHaveBeenCalledWith("install", "/home/clawbox/clawbox");
    } finally {
      if (before === undefined) delete process.env.CLAWBOX_ROOT;
      else process.env.CLAWBOX_ROOT = before;
    }
  });

  it("takes a record that cannot be judged as an x86 install's — install.sh never writes one", async () => {
    x64.broken = true;
    const { embedModelDownloadTask } = await load();
    const { ctx, rootStep } = context();
    await embedModelDownloadTask({ force: false }).run(ctx);
    expect(rootStep).not.toHaveBeenCalled();
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("fails with the fetch's own reason when the download does not verify, and leaves nothing in place", async () => {
    x64.install = true;
    fetched.mockRejectedValueOnce(new Error("Qwen3-Embedding-0.6B-Q8_0.gguf did not verify (its sha256 is not the one the Hub lists), so it was deleted. Try again."));
    const { embedModelDownloadTask } = await load();
    const { ctx, rootStep } = context();

    const err = await embedModelDownloadTask({ force: false }).run(ctx).catch((e: unknown) => e);

    // A failure the task reports in its own words (not a crash of the run).
    const { BackgroundTaskFailure } = await import("@/lib/background-tasks");
    expect(err).toBeInstanceOf(BackgroundTaskFailure);
    expect((err as Error).message).toMatch(/did not verify/);
    expect((err as Error).message).not.toMatch(/root_step_contract|install-x64\.sh/);
    expect(rootStep).not.toHaveBeenCalled();
    expect(fs.existsSync(modelPath())).toBe(false);
  });

  it("answers at once for a copy that is here", async () => {
    x64.install = true;
    fs.writeFileSync(modelPath(), "weights");
    const { embedModelDownloadTask } = await load();
    const { ctx, rootStep } = context();
    expect(await embedModelDownloadTask({ force: false }).run(ctx)).toEqual({ status: "The memory-search model is on this box." });
    expect(fetched).not.toHaveBeenCalled();
    expect(rootStep).not.toHaveBeenCalled();
  });

  it("Download again re-verifies a copy that is fine and fetches nothing", async () => {
    x64.install = true;
    fs.writeFileSync(modelPath(), "weights");
    hashed.mockResolvedValueOnce(CATALOG_SHA);
    const { embedModelDownloadTask } = await load();
    const { ctx } = context();
    const outcome = await embedModelDownloadTask({ force: true }).run(ctx);
    expect(outcome).toEqual({ status: "The memory-search model is on this box. Its copy verified." });
    expect(fetched).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    expect(fs.readFileSync(modelPath(), "utf-8")).toBe("weights");
  });

  it("Download again replaces a damaged copy, stopping the embedder that holds it first", async () => {
    x64.install = true;
    fs.writeFileSync(modelPath(), "truncated");
    hashed.mockResolvedValueOnce("0".repeat(64));
    let sawOld = true;
    fetched.mockImplementationOnce(async (opts: { dir: string; variant: { file: string } }) => {
      sawOld = fs.existsSync(modelPath());
      const dest = path.join(opts.dir, opts.variant.file);
      fs.writeFileSync(dest, "verified weights");
      return dest;
    });
    const { embedModelDownloadTask } = await load();
    const { ctx, rootStep } = context();
    await embedModelDownloadTask({ force: true }).run(ctx);
    expect(stopped).toHaveBeenCalledWith("embed");
    expect(sawOld).toBe(false);
    expect(fs.readFileSync(modelPath(), "utf-8")).toBe("verified weights");
    expect(rootStep).not.toHaveBeenCalled();
  });

  it("refuses a .env that points the slot at a file with no known checksum, and says what to do", async () => {
    x64.install = true;
    Object.assign(slot, { repo: "someone/other-GGUF", file: "other.gguf" });
    const { embedModelDownloadTask } = await load();
    const { ctx, rootStep } = context();
    const err = await embedModelDownloadTask({ force: false }).run(ctx).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/EMBED_HF_REPO and EMBED_HF_FILE/);
    expect(fetched).not.toHaveBeenCalled();
    expect(rootStep).not.toHaveBeenCalled();
  });

  it("is rebuilt the same way by a restarted server", async () => {
    x64.install = true;
    const { embedModelDownloadTask, embedModelDownloadRequest } = await load();
    const { ctx, rootStep } = context();
    await embedModelDownloadTask(embedModelDownloadRequest({ force: false })).run(ctx);
    expect(rootStep).not.toHaveBeenCalled();
    expect(fetched).toHaveBeenCalledTimes(1);
  });
});

describe("the default slot on the appliance (unchanged)", () => {
  it("still runs install.sh's embed_model as root, and fetches nothing itself", async () => {
    const { embedModelDownloadTask } = await load();
    const { ctx, rootStep } = context();
    const outcome = await embedModelDownloadTask({ force: false }).run(ctx);
    expect(rootStep).toHaveBeenCalledWith("embed_model", expect.objectContaining({ label: "the memory model download" }));
    expect(fetched).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "The memory-search model is on this box." });
  });

  it("does not take the appliance for an x86 PC", async () => {
    const { isX86PcInstall } = await load();
    expect(isX86PcInstall("/home/clawbox/clawbox")).toBe(false);
  });
});
