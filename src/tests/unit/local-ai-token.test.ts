import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The legacy sentinels `ollama-local` / `llamacpp-local` are public string
 * constants. They used to authenticate until `data/.local-ai-token-migrated`
 * existed — a flag only a re-save of a local provider ever wrote — so a box
 * that never did that (every cloud-default box) accepted them from anyone on
 * the LAN, through the session-exempt proxy. They may only be honoured while
 * openclaw's own config still carries them, i.e. on a genuine in-place upgrade
 * that has not been re-saved yet.
 */

let root = "";
let openclawHome = "";
const savedEnv = { CLAWBOX_ROOT: process.env.CLAWBOX_ROOT, OPENCLAW_HOME: process.env.OPENCLAW_HOME, LOCAL_AI_TOKEN: process.env.LOCAL_AI_TOKEN };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "local-ai-token-"));
  openclawHome = path.join(root, ".openclaw");
  process.env.CLAWBOX_ROOT = root;
  process.env.OPENCLAW_HOME = openclawHome;
  delete process.env.LOCAL_AI_TOKEN;
  // Paths are read once at module load, so every test needs a fresh graph.
  vi.resetModules();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function lib() {
  return await import("@/lib/local-ai-token");
}

async function writeOpenclawConfig(apiKey: string) {
  await fs.mkdir(openclawHome, { recursive: true });
  await fs.writeFile(
    path.join(openclawHome, "openclaw.json"),
    JSON.stringify({ models: { providers: { ollama: { baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama", apiKey } } } }),
  );
}

async function writeAuthProfiles(key: string) {
  const dir = path.join(openclawHome, "agents", "main", "agent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "auth-profiles.json"),
    JSON.stringify({ version: 1, profiles: { "llamacpp:default": { type: "api_key", provider: "llamacpp", key } } }),
  );
}

describe("verifyLocalAiBearer", () => {
  it("accepts only the per-install token on a fresh install", async () => {
    const { getLocalAiToken, verifyLocalAiBearer } = await lib();
    expect(verifyLocalAiBearer(`Bearer ${getLocalAiToken()}`)).toBe(true);
    // No openclaw config at all — the state of a box that never configured a
    // local provider. The public constants must open nothing here.
    expect(verifyLocalAiBearer("Bearer ollama-local")).toBe(false);
    expect(verifyLocalAiBearer("Bearer llamacpp-local")).toBe(false);
    expect(verifyLocalAiBearer(null)).toBe(false);
    expect(verifyLocalAiBearer("Bearer nope")).toBe(false);
  });

  it("rejects a sentinel when openclaw already holds the per-install token", async () => {
    const { getLocalAiToken, verifyLocalAiBearer } = await lib();
    await writeOpenclawConfig(getLocalAiToken());
    await writeAuthProfiles(getLocalAiToken());
    expect(verifyLocalAiBearer("Bearer ollama-local")).toBe(false);
    expect(verifyLocalAiBearer("Bearer llamacpp-local")).toBe(false);
  });

  it("honours a sentinel only while openclaw's config still sends it", async () => {
    const { verifyLocalAiBearer, markLocalAiTokenMigrated, _resetLocalAiTokenCacheForTests } = await lib();
    // An in-place upgrade from a pre-b0c6e452 build: the provider block still
    // carries the sentinel, so openclaw presents it on every chat turn.
    await writeOpenclawConfig("ollama-local");
    expect(verifyLocalAiBearer("Bearer ollama-local")).toBe(true);
    // Evidence for one provider is not evidence for the other.
    expect(verifyLocalAiBearer("Bearer llamacpp-local")).toBe(false);

    // The configure route's re-save rewrites the credential and stamps the
    // flag; from then on the sentinel is dead even if some copy of it lingers.
    markLocalAiTokenMigrated();
    expect(verifyLocalAiBearer("Bearer ollama-local")).toBe(false);
    _resetLocalAiTokenCacheForTests();
    expect(verifyLocalAiBearer("Bearer ollama-local")).toBe(false);
  });

  it("reads the auth profile too, and follows a rewrite without the flag", async () => {
    const { getLocalAiToken, verifyLocalAiBearer } = await lib();
    await writeAuthProfiles("llamacpp-local");
    expect(verifyLocalAiBearer("Bearer llamacpp-local")).toBe(true);
    // Rewritten by any path (a config repair, a manual edit): no sentinel in
    // the config means nothing to honour, flag or no flag. The mtime moves
    // forward so the cached reading is dropped.
    await new Promise((r) => setTimeout(r, 20));
    await writeAuthProfiles(getLocalAiToken());
    expect(verifyLocalAiBearer("Bearer llamacpp-local")).toBe(false);
  });
});
