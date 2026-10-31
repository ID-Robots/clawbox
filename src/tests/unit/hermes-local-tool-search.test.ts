import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The merge path writes the file itself; the CLI fallback must never run here.
const { runHermesCliMock } = vi.hoisted(() => ({
  runHermesCliMock: vi.fn(async () => {
    throw new Error("the hermes CLI is not available in this suite");
  }),
}));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));

import { HERMES_LOCAL_PROVIDER } from "@/lib/hermes-local-ai";
import { HERMES_LOCAL_REASONING_PROVIDER } from "@/lib/hermes-reasoning";
import { resolveHermesConfigValue } from "@/lib/hermes-config-yaml";
import {
  HERMES_LOCAL_TOOL_SEARCH_PROVIDER,
  hermesToolSearchAction,
  isOnDeviceLlamaCppDefault,
  syncHermesToolSearchWithDefault,
} from "@/lib/hermes-local-tool-search";

// Hermes' Tool Search follows its default model: off while the default is the
// box's own llama.cpp model, Hermes' own default otherwise — and only the
// legacy scalar ClawBox writes is ever removed.

const LLAMACPP = "http://127.0.0.1/setup-api/local-ai/llamacpp/v1";
const OLLAMA = "http://127.0.0.1/setup-api/local-ai/ollama/v1";

describe("hermesToolSearchAction", () => {
  it("writes ClawBox's value only where nothing is set, on the on-device default", () => {
    expect(hermesToolSearchAction(true, { state: "absent" })).toBe("off");
    expect(hermesToolSearchAction(true, { state: "value", value: "false" })).toBeNull();
    expect(hermesToolSearchAction(true, { state: "value", value: "true" })).toBeNull();
    expect(hermesToolSearchAction(true, { state: "present" })).toBeNull();
    expect(hermesToolSearchAction(true, { state: "unreadable" })).toBeNull();
  });

  it("takes back only ClawBox's own value when the default is anything else", () => {
    expect(hermesToolSearchAction(false, { state: "value", value: "false" })).toBe("restore");
    // PyYAML's other spellings of false, which the boot pass reads as the same value.
    expect(hermesToolSearchAction(false, { state: "value", value: "off" })).toBe("restore");
    expect(hermesToolSearchAction(false, { state: "value", value: "true" })).toBeNull();
    // An owner's `{enabled: off}` block.
    expect(hermesToolSearchAction(false, { state: "present" })).toBeNull();
    expect(hermesToolSearchAction(false, { state: "absent" })).toBeNull();
    expect(hermesToolSearchAction(false, { state: "unreadable" })).toBeNull();
  });

  it("calls only the llama.cpp-backed local model on-device", () => {
    expect(isOnDeviceLlamaCppDefault("clawlocal", LLAMACPP)).toBe(true);
    // The lean plugin does not narrow an Ollama model's tools.
    expect(isOnDeviceLlamaCppDefault("clawlocal", OLLAMA)).toBe(false);
    expect(isOnDeviceLlamaCppDefault("clawai", LLAMACPP)).toBe(false);
    expect(isOnDeviceLlamaCppDefault(null, LLAMACPP)).toBe(false);
    expect(isOnDeviceLlamaCppDefault("clawlocal", null)).toBe(false);
  });

  it("names the provider hermes-local-ai.ts registers", () => {
    expect(HERMES_LOCAL_TOOL_SEARCH_PROVIDER).toBe(HERMES_LOCAL_PROVIDER);
    expect(HERMES_LOCAL_TOOL_SEARCH_PROVIDER).toBe(HERMES_LOCAL_REASONING_PROVIDER);
  });
});

describe("syncHermesToolSearchWithDefault on a real config.yaml", () => {
  let home: string;
  let file: string;
  const original = process.env.HERMES_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hermes-tool-search-"));
    file = path.join(home, "config.yaml");
    process.env.HERMES_HOME = home;
    runHermesCliMock.mockClear();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = original;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const config = (provider: string, localUrl: string, extra = "") =>
    [
      "# owner's note — must survive",
      "model:",
      "  default: gemma4-e2b-it-q4_0",
      `  provider: ${provider}`,
      "providers:",
      "  clawlocal:",
      `    base_url: ${localUrl}`,
      "    api_mode: openai",
      extra,
    ].join("\n") + "\n";

  it("turns Tool Search off when the default becomes the local model, and back when it moves on", async () => {
    fs.writeFileSync(file, config("clawlocal", LLAMACPP));
    await syncHermesToolSearchWithDefault("test");
    expect(await resolveHermesConfigValue("tools.tool_search")).toEqual({ state: "value", value: "false" });
    expect(fs.readFileSync(file, "utf-8")).toContain("# owner's note — must survive");

    fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace("provider: clawlocal", "provider: clawai"));
    await syncHermesToolSearchWithDefault("test");
    expect(await resolveHermesConfigValue("tools.tool_search")).toEqual({ state: "absent" });
    // The block it emptied goes with it.
    expect(await resolveHermesConfigValue("tools")).toEqual({ state: "absent" });
    expect(runHermesCliMock).not.toHaveBeenCalled();
  });

  it("leaves an owner's Tool Search block alone either way", async () => {
    const owners = "tools:\n  tool_search:\n    enabled: auto\n    listing: on\n";
    fs.writeFileSync(file, config("clawlocal", LLAMACPP, owners));
    await syncHermesToolSearchWithDefault("test");
    expect(fs.readFileSync(file, "utf-8")).toContain(owners);

    fs.writeFileSync(file, config("clawai", LLAMACPP, owners));
    await syncHermesToolSearchWithDefault("test");
    expect(fs.readFileSync(file, "utf-8")).toContain(owners);
  });

  it("does nothing for an Ollama-backed local default, or a cloud one with nothing set", async () => {
    for (const text of [config("clawlocal", OLLAMA), config("clawai", LLAMACPP)]) {
      fs.writeFileSync(file, text);
      await syncHermesToolSearchWithDefault("test");
      expect(fs.readFileSync(file, "utf-8")).toBe(text);
    }
  });

  it("never throws: a write that fails is logged and left to the next boot", async () => {
    fs.writeFileSync(file, config("clawlocal", LLAMACPP));
    fs.chmodSync(home, 0o500);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(syncHermesToolSearchWithDefault("test")).resolves.toBeUndefined();
    } finally {
      fs.chmodSync(home, 0o700);
    }
    // Root ignores the mode bits; the assertion that matters is that it resolved.
    if (process.getuid?.() !== 0) {
      expect(errors.mock.calls.some((c) => String(c[0]).includes("Tool Search follow the default"))).toBe(true);
    }
  });
});
