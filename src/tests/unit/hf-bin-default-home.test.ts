import { readFileSync } from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Where the Hugging Face CLI is looked for when HF_BIN is unset.
 *
 * Both launch specs defaulted to `/home/clawbox/.local/bin/hf`, the Jetson
 * appliance's user. On a PC installed by install-x64.sh — a DGX Spark, an x64
 * desktop — the install user is whoever owns the machine, pipx puts `hf` in
 * THAT user's ~/.local/bin, and nothing sets HF_BIN. So whenever a model had to
 * be fetched at start (a model switched in .env, a cache cleared), the
 * launcher reported a missing CLI that was installed one home over.
 */
describe("the Hugging Face CLI default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const OWNER_HOME = "/home/someone-else";

  it("is the running user's own, for the local model", async () => {
    vi.resetModules();
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "");
    const mod = await import("@/lib/llamacpp-server");
    expect(mod.getLlamaCppLaunchSpec("local-model").hfBinPath).toBe(path.join(OWNER_HOME, ".local", "bin", "hf"));
  });

  it("is the running user's own, for the memory embedder", async () => {
    vi.resetModules();
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "");
    const mod = await import("@/lib/embed-server");
    expect(mod.getEmbedLaunchSpec().hfBinPath).toBe(path.join(OWNER_HOME, ".local", "bin", "hf"));
  });

  it("still yields to HF_BIN when it is set", async () => {
    vi.resetModules();
    vi.stubEnv("HOME", OWNER_HOME);
    vi.stubEnv("HF_BIN", "/opt/hf/bin/hf");
    const mod = await import("@/lib/llamacpp-server");
    expect(mod.getLlamaCppLaunchSpec("local-model").hfBinPath).toBe("/opt/hf/bin/hf");
  });
});

describe("the shell launchers' Hugging Face CLI default", () => {
  // The same default in the two scripts that fetch the embedder's GGUF.
  // start-embed-server.sh already followed $HOME; ensure-local-embeddings.sh
  // named the appliance user's home outright.
  it.each(["scripts/start-embed-server.sh", "scripts/ensure-local-embeddings.sh"])("%s follows $HOME", (script) => {
    const src = readFileSync(path.join(process.cwd(), script), "utf8");
    const line = src.split("\n").find((l) => l.startsWith("HF_BIN="));
    expect(line).toBe('HF_BIN="${HF_BIN:-${HOME:-/home/clawbox}/.local/bin/hf}"');
  });
});
