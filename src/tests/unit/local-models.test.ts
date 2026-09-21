import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * TASK-435 — Settings → Local Models.
 *
 * The tab exists because `install.sh` announced "On-device TTS configured
 * (Kokoro GPU)" on boxes where Kokoro had never been installed,
 * and nothing in the UI could contradict it. So the cases that matter here are
 * the ones where the box LOOKS equipped and is not: weights on disk with no
 * runtime, a stamp with no service, a binary with no voice.
 */

type ExecCall = { cmd: string; args: string[] };

let calls: ExecCall[] = [];
let responses: { match: RegExp; stdout?: string; fail?: string }[] = [];
let tmpHome = "";

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push({ cmd, args });
    const line = `${cmd} ${args.join(" ")}`;
    const hit = responses.find(r => r.match.test(line));
    if (!hit) {
      const err = new Error(`Command failed: ${line}`) as Error & { stdout: string };
      err.stdout = "";
      cb(err, { stdout: "", stderr: "" });
      return;
    }
    if (hit.fail) {
      const err = new Error(hit.fail) as Error & { stdout: string };
      err.stdout = hit.stdout ?? "";
      cb(err, { stdout: hit.stdout ?? "", stderr: "" });
      return;
    }
    cb(null, { stdout: hit.stdout ?? "", stderr: "" });
  },
}));

beforeEach(async () => {
  calls = [];
  responses = [];
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "local-models-"));
  process.env.CLAWBOX_HOME = tmpHome;
  // CLAWBOX_HOME is read once at module load, so every test needs a fresh graph.
  vi.resetModules();
});

afterEach(async () => {
  // In afterEach rather than inline at the end of a test: an inline call is
  // skipped when an assertion above it fails, and the stubbed fetch then leaks
  // into the next test, turning one failure into several.
  vi.unstubAllGlobals();
  delete process.env.CLAWBOX_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function lib() {
  return await import("@/lib/local-models");
}

const NO_UNIT = "Failed to get unit file state for x.service: No such file or directory";

/** systemctl answers used by a box where nothing local is installed. */
function bareBox() {
  responses.push({ match: /is-enabled/, fail: "exit 1", stdout: NO_UNIT });
  responses.push({ match: /is-active/, fail: "exit 3", stdout: "inactive" });
  responses.push({ match: /pgrep/, fail: "no match", stdout: "" });
}

const NO_ENGINE = { installed: false, modelBytes: null };
const ENGINE = { installed: true, modelBytes: 639_000_000 };

const PROBES = {
  llamacpp: { installed: false, running: false, model: null, configured: false },
  embeddings: { supported: true, ready: true, available: false, provider: null, model: null, local: false, engine: NO_ENGINE },
};

/** OpenClaw pointed at the embedder on this box, as the boot script leaves it. */
const OURS = { supported: true, ready: true, available: true, provider: "openai-compatible", model: "qwen3-embedding-0.6b", local: true, engine: ENGINE };

/** The unit clawbox-embed.service, in one of its states. */
function embedUnit(state: "asleep" | "running" | "failed") {
  // No [Install] section: `is-enabled` answers "static", which is still a
  // present unit.
  responses.push({ match: /is-enabled clawbox-embed/, stdout: "static\n" });
  if (state === "running") responses.push({ match: /is-active clawbox-embed/, stdout: "active\n" });
  else responses.push({ match: /is-active clawbox-embed/, fail: "exit 3", stdout: state === "failed" ? "failed\n" : "inactive\n" });
}

function entry<T extends { id: string }>(models: T[], id: string): T {
  const found = models.find(m => m.id === id);
  if (!found) throw new Error(`no entry ${id}`);
  return found;
}

describe("local model inventory", () => {
  it("calls Kokoro not installed when only its weights are on disk", async () => {
    // The exact state of the loop's test box: the 82M weights sit in the
    // HuggingFace cache from an install that failed afterwards, with no stamp
    // and no unit. Reporting that as installed is the lie this tab removes.
    await fs.mkdir(path.join(tmpHome, ".cache/huggingface/hub/models--hexgrad--Kokoro-82M"), { recursive: true });
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory(PROBES);
    const kokoro = entry(models, "kokoro") as unknown as { installed: boolean; running: string; control: string; enabled: unknown; detail: string };
    expect(kokoro.installed).toBe(false);
    expect(kokoro.running).toBe("not-installed");
    expect(kokoro.control).toBe("none");
    expect(kokoro.enabled).toBeNull();
    expect(kokoro.detail).toMatch(/cloud voice/i);
  });

  it("calls Kokoro not installed when it is stamped but its service is gone", async () => {
    await fs.mkdir(path.join(tmpHome, ".cache/clawbox"), { recursive: true });
    await fs.writeFile(path.join(tmpHome, ".cache/clawbox/kokoro-installed"), "2\n");
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory(PROBES);
    const kokoro = entry(models, "kokoro") as unknown as { installed: boolean; detail: string };
    expect(kokoro.installed).toBe(false);
    expect(kokoro.detail).toMatch(/cannot speak/i);
  });

  it("reports Kokoro as running when both the stamp and an active unit exist", async () => {
    await fs.mkdir(path.join(tmpHome, ".cache/clawbox"), { recursive: true });
    await fs.writeFile(path.join(tmpHome, ".cache/clawbox/kokoro-installed"), "2\n");
    responses.push({ match: /--user is-enabled kokoro-server/, stdout: "enabled\n" });
    responses.push({ match: /--user is-active kokoro-server/, stdout: "active\n" });
    responses.push({ match: /pgrep/, fail: "no match", stdout: "" });
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory(PROBES);
    const kokoro = entry(models, "kokoro") as unknown as { installed: boolean; running: string; enabled: boolean; control: string };
    expect(kokoro.installed).toBe(true);
    expect(kokoro.running).toBe("running");
    expect(kokoro.enabled).toBe(true);
    expect(kokoro.control).toBe("user-unit");
  });

  it("separates an installed-but-stopped engine from a missing one", async () => {
    responses.push({ match: /--user is-enabled whisper-server/, stdout: "disabled\n" });
    responses.push({ match: /--user is-active whisper-server/, fail: "exit 3", stdout: "inactive\n" });
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory(PROBES);
    const whisper = entry(models, "whisper") as unknown as { installed: boolean; running: string; enabled: boolean; control: string };
    // "disabled" is a unit-file state, so the unit exists — installed and off.
    expect(whisper.installed).toBe(true);
    expect(whisper.running).toBe("idle");
    expect(whisper.enabled).toBe(false);
    expect(whisper.control).toBe("user-unit");
  });

  it("keeps the rest of the inventory when one engine cannot be read", async () => {
    // A subordinate row must not cost the customer the tab — the failure mode
    // a bad payload caused in the whole ClawKeep window on TASK-398.
    bareBox();
    const mod = await lib();
    const broken = {
      ...PROBES,
      embeddings: {
        supported: true,
        ready: true,
        get available(): boolean { throw new Error("probe exploded"); },
        provider: null, model: null, local: false, engine: NO_ENGINE,
      },
    } as unknown as Parameters<typeof mod.buildLocalModelInventory>[0];
    const { models, unavailable } = await mod.buildLocalModelInventory(broken);
    expect(unavailable).toContain("embeddings");
    expect(models.map(m => m.id)).toEqual(expect.arrayContaining(["kokoro", "whisper", "llamacpp"]));
  });

  it("has no Ollama row any more", async () => {
    // Nothing that ships needs it: the memory embedder runs on llama.cpp, and
    // Ollama was retired from the provider picker before that.
    bareBox();
    const { buildLocalModelInventory, ENGINE_IDS } = await lib();
    const { models } = await buildLocalModelInventory(PROBES);
    expect(models.find(m => m.id === "ollama")).toBeUndefined();
    expect(ENGINE_IDS.has("ollama")).toBe(false);
  });

  it("badges an installed llama.cpp by whether anything will wake it", async () => {
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const asleep = await buildLocalModelInventory({
      ...PROBES,
      llamacpp: { installed: true, running: false, model: "gemma4-e2b-it-q4_0", configured: true },
    });
    const gemma = entry(asleep.models, "llamacpp") as unknown as { name: string; running: string; detailCode: string };
    // The detail said "Ready. Sleeps until needed" under a badge that said
    // "Off" — the proxy wakes it, which is the existing "on-demand" state.
    expect(gemma.name).toBe("Gemma 4");
    expect(gemma.running).toBe("on-demand");
    expect(gemma.detailCode).toBe("llamacppReady");

    const unwired = await buildLocalModelInventory({
      ...PROBES,
      llamacpp: { installed: true, running: false, model: "gemma4-e2b-it-q4_0", configured: false },
    });
    const off = entry(unwired.models, "llamacpp") as unknown as { running: string; detailCode: string };
    // Nothing routes to it, so nothing will start it: that one really is off.
    expect(off.running).toBe("idle");
    expect(off.detailCode).toBe("llamacppOff");
  });
});

describe("turning an engine on and off", () => {
  it("stops it now AND keeps it off after a reboot", async () => {
    // TASK-435 asked whether disable means "stop now" or "do not start next
    // boot". `disable --now` is both, so neither reading is violated.
    responses.push({ match: /systemctl/, stdout: "" });
    const { setEngineEnabled } = await lib();
    const res = await setEngineEnabled("kokoro-server.service", "user", false);
    expect(res.ok).toBe(true);
    const call = calls.find(c => c.args.includes("disable"));
    expect(call?.args).toEqual(["--user", "disable", "--now", "kokoro-server.service"]);
  });

  it("drives a system unit through sudo with the exact granted argument list", async () => {
    // sudoers matches argument-for-argument; a reordered or extra argument
    // falls through to a password prompt nobody can answer.
    responses.push({ match: /sudo/, stdout: "" });
    const { setEngineEnabled } = await lib();
    const res = await setEngineEnabled("ollama.service", "system", true);
    expect(res.ok).toBe(true);
    expect(calls.at(-1)).toEqual({
      cmd: "/usr/bin/sudo",
      args: ["/usr/bin/systemctl", "enable", "--now", "ollama.service"],
    });
  });

  it("refuses a unit it was never meant to touch", async () => {
    const { setEngineEnabled } = await lib();
    const res = await setEngineEnabled("clawbox-gateway.service", "system", false);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("warms an engine up without deciding how the box boots", async () => {
    // The warm-up (the chat's microphone, the Voice tab's engine pick) starts
    // the model server so the next reply is spoken in two seconds instead of
    // fifteen. It must never reach `enable`: an engine the owner switched off
    // for good would come back at the next boot because a chat turn ran.
    responses.push({ match: /systemctl/, stdout: "" });
    const { startUserEngine } = await lib();
    const res = await startUserEngine("kokoro-server.service");
    expect(res.ok).toBe(true);
    expect(calls.at(-1)).toEqual({
      cmd: "/usr/bin/systemctl",
      args: ["--user", "start", "--no-block", "kokoro-server.service"],
    });
    expect(calls.some(c => c.args.includes("enable"))).toBe(false);
  });

  it("refuses to warm a unit that is not one of the engines", async () => {
    const { startUserEngine } = await lib();
    expect((await startUserEngine("clawbox-gateway.service")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never leaks the command line when sudo refuses", async () => {
    responses.push({ match: /sudo/, fail: "Command failed: /usr/bin/sudo /usr/bin/systemctl disable --now ollama.service\nsudo: a password is required" });
    const { setEngineEnabled } = await lib();
    const res = await setEngineEnabled("ollama.service", "system", false);
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain("/usr/bin");
    expect(res.error).toMatch(/does not allow/i);
  });
});

describe("whether the box can encode a voice note", () => {
  /** A PATH of exactly one directory, so the probe's answer is this test's own doing. */
  async function withPath(entries: string[], body: () => Promise<void>) {
    const before = process.env.PATH;
    process.env.PATH = entries.join(path.delimiter);
    try {
      await body();
    } finally {
      process.env.PATH = before;
    }
  }

  it("finds ffmpeg where the gateway would find it — on the PATH, and executable", async () => {
    const bin = path.join(tmpHome, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });
    const { ffmpegPresent } = await lib();
    await withPath([bin], async () => expect(await ffmpegPresent()).toBe(true));
  });

  it("says no when it is missing, and when it is there but not runnable", async () => {
    // Not runnable is the honest "no": OpenClaw execs ffmpeg to convert the
    // WAV, so a file without the bit set encodes exactly as many voice notes
    // as no file at all.
    const bin = path.join(tmpHome, "empty");
    await fs.mkdir(bin, { recursive: true });
    const { ffmpegPresent } = await lib();
    await withPath([bin], async () => expect(await ffmpegPresent()).toBe(false));
    await fs.writeFile(path.join(bin, "ffmpeg"), "", { mode: 0o644 });
    await withPath([bin], async () => expect(await ffmpegPresent()).toBe(false));
  });

  it("is not fooled by a DIRECTORY called ffmpeg", async () => {
    // A searchable directory answers X_OK on POSIX exactly as an executable
    // does, so the probe used to report an encoder the box cannot start — and
    // the Voice tab said voice notes were ready.
    const bin = path.join(tmpHome, "dir-on-path");
    await fs.mkdir(path.join(bin, "ffmpeg"), { recursive: true });
    const { ffmpegPresent } = await lib();
    await withPath([bin], async () => expect(await ffmpegPresent()).toBe(false));
  });
});

describe("unit lookup", () => {
  it("maps only the engines that really have a service", async () => {
    const { unitForEngine } = await lib();
    // ollama keeps its mapping for the chat-provider path an older box may
    // still be on; it is no longer an inventory row.
    expect(unitForEngine("ollama")).toEqual({ unit: "ollama.service", scope: "system" });
    expect(unitForEngine("kokoro")).toEqual({ unit: "kokoro-server.service", scope: "user" });
    expect(unitForEngine("whisper")).toEqual({ unit: "whisper-server.service", scope: "user" });
    // Piper is gone from the box (Kokoro-only voice), llama.cpp is owned by
    // Settings → Local AI, and the memory embedder by Memory Shard — the proxy
    // wakes it and puts it to sleep, so there is no switch to offer.
    expect(unitForEngine("piper")).toBeNull();
    expect(unitForEngine("llamacpp")).toBeNull();
    expect(unitForEngine("embeddings")).toBeNull();
  });
});

describe("the Memory search row is the embedder's own row", () => {
  // The embedder moved off ollama onto ClawBox's llama.cpp, run as
  // clawbox-embed.service and woken by the local-AI proxy. The row used to be
  // read against the Ollama row because a search did not wake a sleeping
  // ollama; a sleeping unit is now exactly what "starts when needed" means.
  it("reads as starting when needed while its unit is asleep", async () => {
    embedUnit("asleep");
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory({ ...PROBES, embeddings: OURS });
    const emb = entry(models, "embeddings") as unknown as {
      running: string; installed: boolean; detailCode: string; runtime: string; runtimeCode: string;
      params: Record<string, string>; control: string; enabled: unknown; managedBy: string; diskBytes: number; memoryBytes: unknown;
    };
    expect(emb.running).toBe("on-demand");
    expect(emb.installed).toBe(true);
    expect(emb.detailCode).toBe("embeddingsReady");
    expect(emb.runtime).toBe("Qwen 3 via llama.cpp");
    expect(emb.runtimeCode).toBe("modelVia");
    expect(emb.params).toEqual({ model: "Qwen 3", via: "llama.cpp" });
    // No switch: the proxy owns the lifecycle. "Manage in Memory Shard" stays.
    expect(emb.control).toBe("none");
    expect(emb.enabled).toBeNull();
    expect(emb.managedBy).toBe("clawkeep");
    expect(emb.diskBytes).toBe(639_000_000);
    expect(emb.memoryBytes).toBeNull();
  });

  it("reads as searching on this box while the unit is up, and probes its memory", async () => {
    embedUnit("running");
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory({ ...PROBES, embeddings: OURS });
    const emb = entry(models, "embeddings") as unknown as { running: string; detailCode: string; detail: string };
    expect(emb.running).toBe("running");
    expect(emb.detailCode).toBe("embeddingsLocal");
    expect(emb.detail).toMatch(/on this box/i);
    // The memory probe ran only for a unit that is up. The partition between
    // this row and the Gemma row — the `--embedding` flag on the same binary —
    // is pinned against a fake /proc in local-models-memory.test.ts.
    expect(calls.some(c => c.cmd === "/usr/bin/pgrep" && c.args.includes("llama-server"))).toBe(true);
  });

  it("keeps a unit that exited with an error apart from one that is asleep", async () => {
    embedUnit("failed");
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory({ ...PROBES, embeddings: OURS });
    const emb = entry(models, "embeddings") as unknown as { running: string; detailCode: string };
    // A crash reading as "starts when needed" is the lie the RunState comment forbids.
    expect(emb.running).toBe("idle");
    expect(emb.detailCode).toBe("embeddingsFailed");
  });

  it("calls the engine not installed when its GGUF or unit is missing, whatever the config says", async () => {
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory({ ...PROBES, embeddings: { ...OURS, engine: NO_ENGINE } });
    const emb = entry(models, "embeddings") as unknown as { running: string; installed: boolean; detailCode: string; detail: string };
    expect(emb.running).toBe("not-installed");
    expect(emb.installed).toBe(false);
    expect(emb.detailCode).toBe("embeddingsNotInstalled");
    expect(emb.detail).toMatch(/Memory Shard/);
  });

  it("says memory search is not pointed at an installed engine yet", async () => {
    // The GGUF and the unit are there but the core reports no provider: the
    // box was updated and the boot script has not run, or the owner has not
    // finished the wizard.
    embedUnit("asleep");
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory({ ...PROBES, embeddings: { ...PROBES.embeddings, engine: ENGINE } });
    const emb = entry(models, "embeddings") as unknown as { running: string; installed: boolean; detailCode: string };
    expect(emb.installed).toBe(true);
    expect(emb.running).toBe("on-demand");
    expect(emb.detailCode).toBe("embeddingsOff");
  });

  it("names a cloud embedder the owner chose, and measures nothing", async () => {
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory({
      ...PROBES,
      embeddings: { supported: true, ready: true, available: true, provider: "openai", model: "text-embedding-3-large", local: false, engine: ENGINE },
    });
    const emb = entry(models, "embeddings") as unknown as { running: string; detailCode: string; runtime: string; params: Record<string, string> };
    expect(emb.detailCode).toBe("embeddingsCloud");
    expect(emb.running).toBe("on-demand");
    expect(emb.runtime).toBe("Text via Openai");
    expect(emb.params).toEqual({ model: "Text", via: "Openai" });
    // The unit was never asked about: it is not what serves this box's search.
    expect(calls.some(c => c.args.join(" ").includes("clawbox-embed"))).toBe(false);
  });
});

describe("the embeddings row on an edition that has no memory index", () => {
  it("says so, rather than reporting a model that is failing to answer", async () => {
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory({
      ...PROBES,
      embeddings: { supported: false, ready: true, available: false, provider: null, model: null, local: false, engine: NO_ENGINE },
    });
    const emb = entry(models, "embeddings") as unknown as {
      running: string;
      detail: string;
      managedBy?: string;
    };
    // "Not installed" invites the customer to install something. There is
    // nothing to install on this SKU, and the amber tone that state carries
    // asks them to look at a row they cannot act on.
    expect(emb.running).toBe("not-on-this-edition");
    expect(emb.detail).toMatch(/does not include it/i);
    // ClawKeep is absent on the same edition, so pointing at it would be a
    // second dead end inside the first.
    expect(emb.managedBy).toBeUndefined();
  });
});

describe("the memory row waits for nobody", () => {
  /**
   * Reading it costs an OpenClaw process boot (~8 s on a Jetson) and Settings
   * → Local AI polls this inventory every five seconds. The first open after a
   * restart used to sit on a skeleton for the length of that boot, because the
   * whole page was built behind the one row that needed it.
   */
  it("leaves the row out until the box has actually been asked", async () => {
    bareBox();
    const { buildLocalModelInventory } = await import("@/lib/local-models");
    const { models, unavailable } = await buildLocalModelInventory({
      ...PROBES,
      embeddings: { ...PROBES.embeddings, ready: false },
    });
    expect(models.find(m => m.id === "embeddings")).toBeUndefined();
    // Not a failure either — nothing broke, the answer is simply not in yet.
    expect(unavailable).not.toContain("embeddings");
    // Every other engine is there, which is the whole point.
    expect(models.map(m => m.id)).toEqual(["llamacpp", "kokoro", "whisper"]);
  });

  it("still says so on an edition that has no memory index at all", async () => {
    bareBox();
    const { buildLocalModelInventory } = await import("@/lib/local-models");
    const { models } = await buildLocalModelInventory({
      ...PROBES,
      embeddings: { ...PROBES.embeddings, supported: false, ready: false },
    });
    expect(entry(models, "embeddings").running).toBe("not-on-this-edition");
  });
});

describe("the name a model is shown under", () => {
  it("is the family and version, never the file-name recipe", async () => {
    const { friendlyModelName } = await import("@/lib/local-models");
    // The owner asked for "Gemma 4", not "gemma4-e2b-it-q4_0": size, tuning
    // and quantisation are the installer's choices, not the owner's.
    expect(friendlyModelName("gemma4-e2b-it-q4_0")).toBe("Gemma 4");
    expect(friendlyModelName("qwen3-embedding:0.6b")).toBe("Qwen 3");
    expect(friendlyModelName("qwen3-embedding-0.6b")).toBe("Qwen 3");
    expect(friendlyModelName("Llama-3.1-8B-Instruct")).toBe("Llama 3.1");
    expect(friendlyModelName("nomic-embed-text")).toBe("Nomic");
    // An unknown family is still named, not blanked.
    expect(friendlyModelName("smollm2-360m")).toBe("Smollm 2");
    expect(friendlyModelName("")).toBeNull();
    expect(friendlyModelName(null)).toBeNull();
  });
});
