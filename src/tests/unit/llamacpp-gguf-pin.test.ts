import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLAMACPP_HF_FILE,
  DEFAULT_LLAMACPP_HF_REPO,
  SUPERSEDED_LLAMACPP_HF_FILE,
  SUPERSEDED_LLAMACPP_HF_REPO,
  getDefaultLlamaCppFile,
  getDefaultLlamaCppModel,
  getDefaultLlamaCppRepo,
} from "@/lib/llamacpp";

/**
 * The Gemma 4 GGUF is named in three places that no compiler links together:
 * src/lib/llamacpp.ts (what the running app asks llama-server for), install.sh
 * (what the Jetson installer downloads and pins into .env) and install-x64.sh
 * (the same for the desktop installer). A device whose .env says one filename
 * while the app expects another does not fail loudly - llama-server just never
 * finds a model and local AI is silently dead.
 *
 * These tests read the shell scripts as text and assert the three agree, so
 * editing one file without the others fails here rather than on a device.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readInstaller(name: string): string {
  return readFileSync(path.join(REPO_ROOT, name), "utf8");
}

const INSTALLERS = ["install.sh", "install-x64.sh"] as const;

// The measured winner of the on-device bake-off. Spelled out literally rather
// than imported so that changing the constant alone cannot make this test
// vacuously agree with itself - a GGUF swap has to be a deliberate edit here.
const EXPECTED_REPO = "google/gemma-4-E2B-it-qat-q4_0-gguf";
const EXPECTED_FILE = "gemma-4-E2B_q4_0-it.gguf";
const EXPECTED_MODEL_ID = "gemma4-e2b-it-q4_0";

describe("llama.cpp GGUF pin", () => {
  it("pins the measured repo, file and model id", () => {
    expect(DEFAULT_LLAMACPP_HF_REPO).toBe(EXPECTED_REPO);
    expect(DEFAULT_LLAMACPP_HF_FILE).toBe(EXPECTED_FILE);
    expect(getDefaultLlamaCppModel()).toBe(EXPECTED_MODEL_ID);
  });

  it("keeps the model id stable across the GGUF change", () => {
    // The id is only llama-server's --alias. The gateway config, the Hermes
    // model options and every saved user selection already refer to it, so it
    // must not move when the weights do.
    expect(EXPECTED_MODEL_ID).not.toContain("qat");
    expect(getDefaultLlamaCppModel()).not.toBe(EXPECTED_FILE);
  });

  it("does not still point at the superseded GGUF", () => {
    expect(SUPERSEDED_LLAMACPP_HF_REPO).not.toBe(DEFAULT_LLAMACPP_HF_REPO);
    expect(SUPERSEDED_LLAMACPP_HF_FILE).not.toBe(DEFAULT_LLAMACPP_HF_FILE);
    expect(getDefaultLlamaCppRepo()).not.toBe(SUPERSEDED_LLAMACPP_HF_REPO);
    expect(getDefaultLlamaCppFile()).not.toBe(SUPERSEDED_LLAMACPP_HF_FILE);
  });

  it.each(INSTALLERS)("%s downloads the same repo and file the app asks for", (installer) => {
    const source = readInstaller(installer);

    expect(source).toContain(`"LLAMACPP_HF_REPO" "${DEFAULT_LLAMACPP_HF_REPO}"`);
    expect(source).toContain(`"LLAMACPP_HF_FILE" "${DEFAULT_LLAMACPP_HF_FILE}"`);
    expect(source).toContain(`"LLAMACPP_MODEL" "${EXPECTED_MODEL_ID}"`);

    // ensure_llamacpp_model_cached's fallbacks, used when .env has no pin yet.
    expect(source).toContain(`"LLAMACPP_HF_REPO" "${DEFAULT_LLAMACPP_HF_REPO}")`);
    expect(source).toContain(`"LLAMACPP_HF_FILE" "${DEFAULT_LLAMACPP_HF_FILE}")`);
  });

  it.each(INSTALLERS)("%s no longer defaults to the superseded GGUF", (installer) => {
    const source = readInstaller(installer);

    // The old strings may only survive as migration arguments and as the prune
    // target - never as a default. Every surviving mention must sit on a
    // migrate_env_setting line or a `stale=` assignment.
    const offending = source
      .split("\n")
      .filter(
        (line) =>
          (line.includes(SUPERSEDED_LLAMACPP_HF_REPO) ||
            line.includes(SUPERSEDED_LLAMACPP_HF_FILE)) &&
          !line.includes("migrate_env_setting") &&
          !line.trimStart().startsWith("local stale=") &&
          !line.trimStart().startsWith("#"),
      );

    expect(offending).toEqual([]);
  });

  it.each(INSTALLERS)("%s migrates a device that is pinned to the old GGUF", (installer) => {
    const source = readInstaller(installer);

    // ensure_env_setting only ever ADDS a key, so without these two lines an
    // already-installed device keeps the old GGUF forever.
    expect(source).toContain(
      `migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_REPO" "${SUPERSEDED_LLAMACPP_HF_REPO}" "${DEFAULT_LLAMACPP_HF_REPO}"`,
    );
    expect(source).toContain(
      `migrate_env_setting "$ENV_FILE" "LLAMACPP_HF_FILE" "${SUPERSEDED_LLAMACPP_HF_FILE}" "${DEFAULT_LLAMACPP_HF_FILE}"`,
    );
    expect(source).toContain("migrate_env_setting() {");
  });

  it.each(INSTALLERS)("%s reclaims the superseded GGUF", (installer) => {
    const source = readInstaller(installer);

    expect(source).toContain("prune_superseded_llamacpp_model() {");
    expect(source).toContain(`local stale="${SUPERSEDED_LLAMACPP_HF_FILE}"`);
  });
});
