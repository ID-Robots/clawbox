import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * TASK-435 — Settings → Local Models.
 *
 * The tab exists because `install.sh` announced "On-device TTS configured
 * (Kokoro GPU, Piper fallback)" on boxes where Kokoro had never been installed,
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

const PROBES = {
  ollamaBaseUrl: "http://127.0.0.1:11434",
  llamacpp: { installed: false, running: false, model: null },
  embeddings: { available: false, provider: null, model: null, local: false },
};

function entry(models: { id: string }[], id: string) {
  const found = models.find(m => m.id === id);
  if (!found) throw new Error(`no entry ${id}`);
  return found as never;
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
    expect(kokoro.detail).toMatch(/falls back to Piper/i);
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

  it("does not call Piper installed when the binary has no voice", async () => {
    const piper = path.join(tmpHome, ".local/share/piper");
    await fs.mkdir(piper, { recursive: true });
    await fs.writeFile(path.join(piper, "piper"), "#!/bin/sh\n");
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory(PROBES);
    const entryPiper = entry(models, "piper") as unknown as { installed: boolean; detail: string };
    expect(entryPiper.installed).toBe(false);
    expect(entryPiper.detail).toMatch(/no voice/i);
  });

  it("names the installed Piper voices and reports it as on demand, not idle", async () => {
    const piper = path.join(tmpHome, ".local/share/piper");
    await fs.mkdir(path.join(piper, "voices"), { recursive: true });
    await fs.writeFile(path.join(piper, "piper"), "#!/bin/sh\n");
    await fs.writeFile(path.join(piper, "voices/en_US-lessac-medium.onnx"), "x".repeat(1024));
    await fs.writeFile(path.join(piper, "voices/en_US-lessac-medium.onnx.json"), "{}");
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory(PROBES);
    const entryPiper = entry(models, "piper") as unknown as { installed: boolean; running: string; detail: string; diskBytes: number };
    expect(entryPiper.installed).toBe(true);
    // A per-utterance binary is never "stopped"; calling it idle would invite
    // the customer to look for a switch that does not exist.
    expect(entryPiper.running).toBe("on-demand");
    expect(entryPiper.detail).toContain("en_US-lessac-medium");
    expect(entryPiper.diskBytes).toBeGreaterThan(1000);
  });

  it("keeps the rest of the inventory when one engine cannot be read", async () => {
    // A subordinate row must not cost the customer the tab — the failure mode
    // a bad payload caused in the whole ClawKeep window on TASK-398.
    bareBox();
    const mod = await lib();
    const broken = {
      ...PROBES,
      embeddings: {
        get available(): boolean { throw new Error("probe exploded"); },
        provider: null, model: null, local: false,
      },
    } as unknown as Parameters<typeof mod.buildLocalModelInventory>[0];
    const { models, unavailable } = await mod.buildLocalModelInventory(broken);
    expect(unavailable).toContain("embeddings");
    expect(models.map(m => m.id)).toEqual(expect.arrayContaining(["piper", "kokoro", "whisper", "ollama"]));
  });

  it("sums the pulled Ollama models into a disk figure", async () => {
    responses.push({ match: /is-enabled ollama/, stdout: "enabled\n" });
    responses.push({ match: /is-active ollama/, stdout: "active\n" });
    responses.push({ match: /pgrep/, fail: "no match", stdout: "" });
    bareBox();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "qwen3-embedding:0.6b", size: 639_000_000 }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory(PROBES);
    const ollama = entry(models, "ollama") as unknown as { running: string; diskBytes: number; detail: string; control: string };
    expect(ollama.running).toBe("running");
    expect(ollama.diskBytes).toBe(639_000_000);
    expect(ollama.detail).toContain("qwen3-embedding:0.6b");
    expect(ollama.control).toBe("system-unit");
    vi.unstubAllGlobals();
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

  it("never leaks the command line when sudo refuses", async () => {
    responses.push({ match: /sudo/, fail: "Command failed: /usr/bin/sudo /usr/bin/systemctl disable --now ollama.service\nsudo: a password is required" });
    const { setEngineEnabled } = await lib();
    const res = await setEngineEnabled("ollama.service", "system", false);
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain("/usr/bin");
    expect(res.error).toMatch(/does not allow/i);
  });
});

describe("unit lookup", () => {
  it("maps only the engines that really have a service", async () => {
    const { unitForEngine } = await lib();
    expect(unitForEngine("ollama")).toEqual({ unit: "ollama.service", scope: "system" });
    expect(unitForEngine("kokoro")).toEqual({ unit: "kokoro-server.service", scope: "user" });
    expect(unitForEngine("whisper")).toEqual({ unit: "whisper-server.service", scope: "user" });
    // Piper is a binary and llama.cpp is owned by Settings → Local AI.
    expect(unitForEngine("piper")).toBeNull();
    expect(unitForEngine("llamacpp")).toBeNull();
  });
});

describe("embeddings are checked against the engine that serves them", () => {
  it("does not call memory embedding healthy while its engine is stopped", async () => {
    // Found by driving a real box, not by reading the code: ClawKeep's memory
    // status answers available/healthy from the index and the CONFIGURED
    // provider, never from a live embed call. With Ollama stopped it still
    // said healthy, so the tab printed "Embedding your memory on the box" one
    // row under "Ollama — Stopped". Acceptance 4 of this task forbids exactly
    // that: a model that is not actually able to run must not read as available.
    responses.push({ match: /is-enabled ollama/, stdout: "disabled\n" });
    responses.push({ match: /is-active ollama/, fail: "exit 3", stdout: "inactive\n" });
    bareBox();
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory({
      ...PROBES,
      embeddings: { available: true, provider: "ollama", model: "qwen3-embedding:0.6b", local: true },
    });
    const emb = entry(models, "embeddings") as unknown as { running: string; detail: string };
    expect(emb.running).toBe("idle");
    expect(emb.detail).toMatch(/Ollama is stopped/i);
  });

  it("still reports embedding as running when its engine is up", async () => {
    responses.push({ match: /is-enabled ollama/, stdout: "enabled\n" });
    responses.push({ match: /is-active ollama/, stdout: "active\n" });
    bareBox();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }));
    const { buildLocalModelInventory } = await lib();
    const { models } = await buildLocalModelInventory({
      ...PROBES,
      embeddings: { available: true, provider: "ollama", model: "qwen3-embedding:0.6b", local: true },
    });
    const emb = entry(models, "embeddings") as unknown as { running: string; detail: string };
    expect(emb.running).toBe("running");
    expect(emb.detail).toMatch(/on the box/i);
    vi.unstubAllGlobals();
  });
});
