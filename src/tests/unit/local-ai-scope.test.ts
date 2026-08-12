import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Settings → Local AI configures the model that runs ON the device (llama.cpp /
 * Ollama) through the local-ai routes, which are identical on both harnesses.
 * On a Hermes box, AIModelsStep used to hand the whole step to
 * HermesProviderConfig purely on edition, which replaced that one local row
 * with the cloud provider list — Anthropic, OpenAI, DeepSeek, ClawBox AI — in a
 * section named "Local AI".
 *
 * A render test would need the entire step's dependency tree (i18n, the Ollama
 * and llama.cpp hooks, provider icons) stood up, so this guards the two
 * decisions in source instead: the section asks for the local scope, and the
 * Hermes takeover respects it.
 */
const SRC = path.join(process.cwd(), "src", "components");

function read(file: string): string {
  return fs.readFileSync(path.join(SRC, file), "utf8");
}

describe("Settings → Local AI stays local", () => {
  it("scopes the Local AI section to on-device providers", () => {
    const settings = read("SettingsApp.tsx");
    const step = settings.slice(settings.indexOf('testId="settings-local-ai-step"') - 1200);
    expect(step).toContain('configureScope="local"');
    expect(step).toContain('providerIds={["llamacpp"]}');
  });

  it("does not hand the local scope to the Hermes provider panel", () => {
    const source = read("AIModelsStep.tsx");
    const branch = /if \(edition === "hermes"([^)]*)\) \{\s*return <HermesProviderConfig/.exec(source);
    expect(branch, "Hermes short-circuit not found — was it renamed?").not.toBeNull();
    expect(branch![1]).toContain('configureScope !== "local"');
  });
});
