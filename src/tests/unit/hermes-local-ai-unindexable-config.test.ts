import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveEnv } from "@/tests/helpers/env";

/**
 * TASK-545 — the removal over a config.yaml OUR line editor cannot index.
 *
 * The rest of the suite mocks `@/lib/hermes-config-yaml`, so it can only pin
 * what the removal does with an answer it is HANDED. This file hands it a real
 * file instead: a four-space `config.yaml`, which `readYamlPath` refuses to
 * descend (`YamlEditUnsupported`) and `hermes` itself reads without complaint.
 * That gap is the whole defect — a reader that reports "could not read the
 * file" and "the key is not there" as the same `null` decided whether the
 * device's SELECTION was cleared, so on this shape `model.provider: clawlocal`
 * survived a removal that answered `200 {success:true}`, and every chat turn
 * afterwards 502s with `Unknown provider 'clawlocal'`.
 *
 * Only `hermes` itself is simulated (faithfully: `config unset` rewrites the
 * document through PyYAML, which is what makes it two-space and indexable
 * again; `config get` exits 1 with "Config key not set" for a missing key).
 * Everything else — the reader, the writer, the CLI fallback, the read-back
 * proof — is the real module.
 */

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/local-ai-token", () => ({ getLocalAiToken: () => "local-token-xyz" }));
// Mirrors the real builders byte for byte; the point here is to keep
// `llamacpp-server` (and the whole runtime tree) out of this suite's graph.
vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyRootUrl: () => "http://127.0.0.1",
  getLocalAiOpenAiBaseUrl: (p: string) =>
    p === "llamacpp"
      ? "http://127.0.0.1/setup-api/local-ai/llamacpp/v1"
      : "http://127.0.0.1/setup-api/local-ai/ollama/v1",
}));
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(async () => undefined),
}));

import { HERMES_LOCAL_PROVIDER, removeLocalAiFromHermes } from "@/lib/hermes-local-ai";

type Node = { [key: string]: Node | string };

/** What `safe_dump` would write: block style, `indent` spaces per level. */
function render(node: Node, indent: number, depth = 0): string {
  const pad = " ".repeat(indent * depth);
  return Object.entries(node)
    .map(([key, value]) =>
      typeof value === "string"
        ? `${pad}${key}: ${value}\n`
        : `${pad}${key}:\n${render(value, indent, depth + 1)}`)
    .join("");
}

function lookup(node: Node, key: string): Node | string | undefined {
  return key.split(".").reduce<Node | string | undefined>(
    (at, part) => (at && typeof at === "object" ? at[part] : undefined),
    node,
  );
}

/** `hermes config unset`: drop the leaf, then the containers it emptied. */
function drop(node: Node, key: string): void {
  const parts = key.split(".");
  const chain: Node[] = [node];
  for (const part of parts.slice(0, -1)) {
    const next = chain[chain.length - 1][part];
    if (!next || typeof next === "string") return;
    chain.push(next);
  }
  delete chain[chain.length - 1][parts[parts.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length > 0) break;
    delete chain[i - 1][parts[i - 1]];
  }
}

let home: string;
let restoreEnv: () => void;
let config: Node;

/** The document on disk, as `safe_dump` at `indent` would have written it. */
function writeConfig(indent: number): void {
  fs.writeFileSync(path.join(home, "config.yaml"), render(config, indent), { mode: 0o600 });
}

function configText(): string {
  return fs.readFileSync(path.join(home, "config.yaml"), "utf8");
}

/** Every key `hermes config unset` was asked for. */
function cliUnsets(): string[] {
  return cliMock.mock.calls.filter((c) => c[0]?.[1] === "unset").map((c) => c[0]?.[2] as string);
}

beforeEach(() => {
  restoreEnv = saveEnv("HERMES_HOME");
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-unindexable-hermes-"));
  process.env.HERMES_HOME = home;
  config = {
    model: { provider: HERMES_LOCAL_PROVIDER, default: "gemma-4-e2b" },
    providers: {
      [HERMES_LOCAL_PROVIDER]: {
        base_url: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
        api_key: "local-token-xyz",
        api_mode: "openai",
        models: "gemma-4-e2b",
      },
    },
  };
  // FOUR spaces: a document `hermes` loads happily and `readYamlPath` refuses
  // to descend, which is the shape this file exists for.
  writeConfig(4);
  cliMock.mockReset();
  cliMock.mockImplementation(async (args: string[]) => {
    if (args?.[0] !== "config") return { code: 0, stdout: "", stderr: "" };
    if (args[1] === "unset") {
      drop(config, args[2]);
      // PyYAML round-trips the whole document, so the file comes back at the
      // dumper's own two-space indent — indexable again from here on.
      writeConfig(2);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "get") {
      const value = lookup(config, args[2]);
      return typeof value === "string"
        ? { code: 0, stdout: `${value}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: `Config key not set: ${args[2]}` };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("removing the local provider from a config.yaml our reader cannot index", () => {
  it("clears a selection that still points at the local model", async () => {
    // The state the module header names: providers block gone, selection left
    // behind, every chat turn 502s with "Unknown provider 'clawlocal'". It is
    // reached through a reader that answers "I could not read this file" and
    // "that key is not here" with the same `null`.
    const result = await removeLocalAiFromHermes();

    expect(result).toEqual({ wasDefault: true, model: "gemma-4-e2b" });
    expect(cliUnsets()).toContain("model.provider");
    expect(cliUnsets()).toContain("model.default");
    // ...and in the file itself, which is what the next chat turn reads.
    expect(configText()).not.toContain(HERMES_LOCAL_PROVIDER);
  });

  it("leaves another provider's selection alone", async () => {
    // The mirror mistake, and the destructive one: unsetting `model.provider`
    // because we could not read it would drop the owner's cloud provider on a
    // Local AI toggle-off.
    config.model = { provider: "openrouter", default: "anthropic/claude-sonnet-4" };
    writeConfig(4);

    const result = await removeLocalAiFromHermes();

    expect(result.wasDefault).toBe(false);
    expect(cliUnsets()).not.toContain("model.provider");
    expect(cliUnsets()).not.toContain("model.default");
    expect(configText()).toContain("provider: openrouter");
  });

  it("writes nothing and refuses when Hermes' own reader cannot answer either", async () => {
    // Neither reader can say what the selection is, so there is no safe unset
    // list to send: unsetting `model.provider` blind would evict a cloud
    // provider, and leaving it is the 502-per-turn state. Refuse BEFORE the
    // write, so the box keeps working and the retry has everything still to do.
    const before = configText();
    cliMock.mockRejectedValue(new Error("hermes: timed out"));

    await expect(removeLocalAiFromHermes()).rejects.toThrow(/was not attempted/);
    expect(configText()).toBe(before);
    expect(cliUnsets()).toEqual([]);
  });
});
