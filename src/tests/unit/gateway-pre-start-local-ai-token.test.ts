import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { sliceScript } from "../helpers/gateway-pre-start";

// Starts a real python3: vitest's 5 s test default is not enough on a loaded
// CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * The local-AI apiKey reconciliation, pulled out of the .sh verbatim (TASK-1076).
 *
 * Its own region rather than a slice of the llamacpp repair above it: the two
 * answer different questions — that one completes an entry OpenClaw's schema
 * would reject, this one re-points a bearer on an entry that is already valid.
 */
const REGION = hasPython3
  ? sliceScript(
      "# Reconciliation: models.providers.{llamacpp,ollama}.apiKey vs data/.local-ai-token.",
      "# Model migration: legacy ChatGPT-subscription devices",
    )
  : "";

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "local-ai-token-"));
  root = path.join(dir, "clawbox");
  mkdirSync(path.join(root, "data"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Config = Record<string, unknown>;
type ProviderDef = { baseUrl?: string; api?: string; apiKey?: string; models?: unknown };

/** 64 hex chars, the shape crypto.randomBytes(32).toString("hex") writes. */
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const STALE = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** Only this one is read by the region; a developer's export must not decide a case. */
const AMBIENT_KEYS = ["CLAWBOX_LOCAL_AI_PROXY_BASE_URL"] as const;

function writeToken(value: string | null): void {
  if (value === null) return;
  writeFileSync(path.join(root, "data", ".local-ai-token"), value);
}

function writeEnvFile(body: string): void {
  writeFileSync(path.join(root, ".env"), body);
}

/**
 * Run the extracted region over a whole openclaw.json.
 *
 * The preamble reproduces only the names the region reads from its surrounding
 * scope, exactly as the real script binds them upstream (`cfg`, `changed`,
 * `_clawbox_root`) — mock at that boundary and nothing else, so the logic under
 * test is 100% the shipped bytes.
 */
function reconcile(cfg: Config, env: Record<string, string> = {}): {
  cfg: Config;
  changed: boolean;
  log: string;
} {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, os, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    '_clawbox_root = os.environ.get("CLAWBOX_ROOT", "/home/clawbox/clawbox")',
    REGION,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const inherited = { ...process.env };
  for (const key of AMBIENT_KEYS) delete inherited[key];
  const lines = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    env: { ...inherited, CLAWBOX_ROOT: root, ...env },
  })
    .trim()
    .split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

function providerOf(cfg: Config, id: string): ProviderDef {
  const models = (cfg.models ?? {}) as { providers?: Record<string, ProviderDef> };
  return models.providers?.[id] ?? {};
}

/** An entry in the exact shape ai-models/configure writes for each provider. */
function llamacpp(apiKey: string | null, extra: ProviderDef = {}): ProviderDef {
  return {
    baseUrl: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
    api: "openai-completions",
    ...(apiKey === null ? {} : { apiKey }),
    models: [{ id: "gemma4-e2b-it-q4_0", name: "gemma4-e2b-it-q4_0" }],
    ...extra,
  };
}

function ollama(apiKey: string | null, extra: ProviderDef = {}): ProviderDef {
  return {
    baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama",
    api: "ollama",
    ...(apiKey === null ? {} : { apiKey }),
    models: [{ id: "qwen3-1.7b", name: "qwen3-1.7b" }],
    ...extra,
  };
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh — local-AI apiKey reconciliation", () => {
  // --- the reported failure ---------------------------------------------

  it("re-points a llamacpp key left behind by a rebuilt image", () => {
    // The board this was found on: .local-ai-token minted at first boot, the
    // provider entry restored beside it still carrying the previous token, and
    // every agent turn 401ing before the model ran.
    writeToken(TOKEN);
    const { cfg, changed, log } = reconcile({
      models: { providers: { llamacpp: llamacpp(STALE) } },
    });

    expect(changed).toBe(true);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(TOKEN);
    expect(log).toContain("Reconciled models.providers.llamacpp.apiKey");
  });

  it("re-points ollama too — its proxy path carries no /v1 suffix", () => {
    writeToken(TOKEN);
    const { cfg, changed } = reconcile({
      models: { providers: { ollama: ollama(STALE) } },
    });

    expect(changed).toBe(true);
    expect(providerOf(cfg, "ollama").apiKey).toBe(TOKEN);
  });

  it("re-points both providers in one pass", () => {
    writeToken(TOKEN);
    const { cfg, changed } = reconcile({
      models: { providers: { llamacpp: llamacpp(STALE), ollama: ollama(STALE) } },
    });

    expect(changed).toBe(true);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(TOKEN);
    expect(providerOf(cfg, "ollama").apiKey).toBe(TOKEN);
  });

  it("gives the bearer to an entry on our proxy that has none at all", () => {
    writeToken(TOKEN);
    const { cfg, changed } = reconcile({
      models: { providers: { llamacpp: llamacpp(null) } },
    });

    expect(changed).toBe(true);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(TOKEN);
  });

  it("replaces a legacy sentinel key with the per-install token", () => {
    // "llamacpp-local" is honoured by the proxy only while the config still
    // carries it and the migration flag is unstamped; the real token always is.
    writeToken(TOKEN);
    const { cfg, changed } = reconcile({
      models: { providers: { llamacpp: llamacpp("llamacpp-local") } },
    });

    expect(changed).toBe(true);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(TOKEN);
  });

  it("never writes the token into the journal", () => {
    writeToken(TOKEN);
    const { log } = reconcile({
      models: { providers: { llamacpp: llamacpp(STALE) } },
    });

    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(STALE);
  });

  // --- idempotence -------------------------------------------------------

  it("is silent and writes nothing when the key is already current", () => {
    writeToken(TOKEN);
    const entry = llamacpp(TOKEN);
    const { cfg, changed, log } = reconcile({
      models: { providers: { llamacpp: entry } },
    });

    expect(changed).toBe(false);
    expect(providerOf(cfg, "llamacpp")).toEqual(entry);
    expect(log).toBe("");
  });

  it("compares against the trimmed file, so a trailing newline is not a drift", () => {
    // Every writer of this file ends it with a newline or does not; a boot that
    // rewrote the key each time would churn the config forever.
    writeToken(`${TOKEN}\n`);
    const { changed } = reconcile({
      models: { providers: { llamacpp: llamacpp(TOKEN) } },
    });

    expect(changed).toBe(false);
  });

  // --- entries that are not ours ----------------------------------------

  it("leaves an operator's own llama-server on loopback alone", () => {
    // Loopback, but not our proxy path: their server takes their key.
    writeToken(TOKEN);
    const entry = { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "an-operators-own-key" };
    const { cfg, changed } = reconcile({
      models: { providers: { llamacpp: entry } },
    });

    expect(changed).toBe(false);
    expect(providerOf(cfg, "llamacpp")).toEqual(entry);
  });

  it("leaves an operator's own ollama on its native port alone", () => {
    writeToken(TOKEN);
    const entry = { baseUrl: "http://127.0.0.1:11434", apiKey: "an-operators-own-key" };
    const { cfg, changed } = reconcile({
      models: { providers: { ollama: entry } },
    });

    expect(changed).toBe(false);
    expect(providerOf(cfg, "ollama")).toEqual(entry);
  });

  it("refuses our proxy path on somebody else's host", () => {
    // The path alone must never be the test: a remote host that happens to
    // mount the same route would be mailed this box's bearer.
    writeToken(TOKEN);
    const entry = {
      baseUrl: "http://elsewhere.example/setup-api/local-ai/llamacpp/v1",
      apiKey: STALE,
    };
    const { cfg, changed } = reconcile({
      models: { providers: { llamacpp: entry } },
    });

    expect(changed).toBe(false);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(STALE);
  });

  it("matches the provider segment whole, not as a prefix", () => {
    writeToken(TOKEN);
    const entry = {
      baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama-of-theirs",
      apiKey: "an-operators-own-key",
    };
    const { cfg, changed } = reconcile({
      models: { providers: { ollama: entry } },
    });

    expect(changed).toBe(false);
    expect(providerOf(cfg, "ollama").apiKey).toBe("an-operators-own-key");
  });

  it("does not take a llamacpp entry pointing at the ollama route", () => {
    writeToken(TOKEN);
    const entry = { baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama", apiKey: STALE };
    const { changed } = reconcile({
      models: { providers: { llamacpp: entry } },
    });

    expect(changed).toBe(false);
  });

  // --- the configured proxy root ----------------------------------------

  it("accepts a proxy root configured in the process environment", () => {
    writeToken(TOKEN);
    const { cfg, changed } = reconcile(
      { models: { providers: { llamacpp: { baseUrl: "http://box.local/setup-api/local-ai/llamacpp/v1", apiKey: STALE } } } },
      { CLAWBOX_LOCAL_AI_PROXY_BASE_URL: "http://box.local" },
    );

    expect(changed).toBe(true);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(TOKEN);
  });

  it("reads the proxy root out of .env, which no gateway unit loads", () => {
    // The whole reason the repair above grew its own .env reader: the gateway
    // units take network.env / Environment= lines, never $CLAWBOX_ROOT/.env, so
    // a box with a custom root would drift on with nothing said.
    writeToken(TOKEN);
    writeEnvFile('# tuning\nexport CLAWBOX_LOCAL_AI_PROXY_BASE_URL="http://box.local:8443"\n');
    const { cfg, changed } = reconcile({
      models: {
        providers: {
          llamacpp: { baseUrl: "http://box.local:8443/setup-api/local-ai/llamacpp/v1", apiKey: STALE },
        },
      },
    });

    expect(changed).toBe(true);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(TOKEN);
  });

  it("still reconciles a loopback entry on a non-default UI port", () => {
    writeToken(TOKEN);
    const { changed } = reconcile({
      models: {
        providers: {
          llamacpp: { baseUrl: "http://127.0.0.1:3005/setup-api/local-ai/llamacpp/v1", apiKey: STALE },
        },
      },
    });

    expect(changed).toBe(true);
  });

  // --- refusals that must stay refusals ---------------------------------

  it("never writes an absent token over a key that may still be working", () => {
    writeToken(null);
    const { cfg, changed, log } = reconcile({
      models: { providers: { llamacpp: llamacpp(STALE) } },
    });

    expect(changed).toBe(false);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(STALE);
    expect(log).toContain("WARN");
    expect(log).toContain(".local-ai-token");
  });

  it("treats a too-short token file the same way", () => {
    writeToken("deadbeef");
    const { cfg, changed, log } = reconcile({
      models: { providers: { llamacpp: llamacpp(STALE) } },
    });

    expect(changed).toBe(false);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(STALE);
    expect(log).toContain("too short");
  });

  it("treats an undecodable token file as unreadable rather than failing pre-start", () => {
    // `open()` decodes by the boot locale, and LANG is unset under systemd —
    // so ascii. UnicodeDecodeError is not an OSError: it would come straight
    // out of the heredoc and ExecStartPre would die under `set -euo pipefail`,
    // costing the box its whole gateway over a credential this block could
    // simply have declined to use. It must never be repaired into a different
    // string either, because this block would then write that string.
    writeFileSync(path.join(root, "data", ".local-ai-token"), Buffer.from([0xff, 0xfe, 0xff, 0xfe]));
    const { cfg, changed, log } = reconcile({
      models: { providers: { llamacpp: llamacpp(STALE) } },
    });

    expect(changed).toBe(false);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(STALE);
    expect(log).toContain("WARN");
  });

  it("says nothing at all when no entry points at the proxy", () => {
    // A box with an operator's own server and no token file is not a fault.
    writeToken(null);
    const { changed, log } = reconcile({
      models: { providers: { llamacpp: { baseUrl: "http://127.0.0.1:8080/v1" } } },
    });

    expect(changed).toBe(false);
    expect(log).toBe("");
  });

  it("refuses an entry carrying a model row on another host, and says why", () => {
    // apiKey is provider-wide: OpenClaw resolves a row as
    // `model.baseUrl ?? provider.baseUrl`, so that row would be handed this
    // box's bearer on every turn.
    writeToken(TOKEN);
    const { cfg, changed, log } = reconcile({
      models: {
        providers: {
          llamacpp: llamacpp(STALE, {
            models: [
              { id: "gemma4-e2b-it-q4_0", name: "gemma4-e2b-it-q4_0" },
              { id: "remote", name: "remote", baseUrl: "http://elsewhere.example/v1" },
            ],
          }),
        },
      },
    });

    expect(changed).toBe(false);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(STALE);
    expect(log).toContain("another host");
    expect(log).not.toContain("elsewhere.example");
  });

  it("ignores a row OpenClaw's own schema rejects when deciding that", () => {
    // A row with no id can never route a turn, so its baseUrl can never
    // receive the bearer — refusing over it would strand a box for nothing.
    writeToken(TOKEN);
    const { changed } = reconcile({
      models: {
        providers: {
          llamacpp: llamacpp(STALE, {
            models: [
              { id: "gemma4-e2b-it-q4_0", name: "gemma4-e2b-it-q4_0" },
              { name: "no id", baseUrl: "http://elsewhere.example/v1" },
            ],
          }),
        },
      },
    });

    expect(changed).toBe(true);
  });

  it("counts a row baseUrl that will not parse as foreign", () => {
    writeToken(TOKEN);
    const { changed } = reconcile({
      models: {
        providers: {
          llamacpp: llamacpp(STALE, {
            models: [{ id: "weird", name: "weird", baseUrl: "not a url at all" }],
          }),
        },
      },
    });

    expect(changed).toBe(false);
  });

  it("reconciles when every row's own baseUrl is on this box", () => {
    writeToken(TOKEN);
    const { changed } = reconcile({
      models: {
        providers: {
          llamacpp: llamacpp(STALE, {
            models: [{ id: "gemma4-e2b-it-q4_0", name: "gemma4-e2b-it-q4_0", baseUrl: "http://localhost:8080/v1" }],
          }),
        },
      },
    });

    expect(changed).toBe(true);
  });

  // --- configs that must not abort ExecStartPre -------------------------

  it("invents no models container on a config that has none", () => {
    writeToken(TOKEN);
    const { cfg, changed } = reconcile({ agents: { defaults: {} } });

    expect(changed).toBe(false);
    expect(cfg).not.toHaveProperty("models");
  });

  it("survives models and models.providers being scalars", () => {
    writeToken(TOKEN);
    expect(reconcile({ models: "operator-owned-scalar" }).changed).toBe(false);
    expect(reconcile({ models: { providers: "operator-owned-scalar" } }).changed).toBe(false);
  });

  it("survives a provider entry that is not an object", () => {
    writeToken(TOKEN);
    const { changed } = reconcile({
      models: { providers: { llamacpp: ["not", "an", "entry"], ollama: 7 } },
    });

    expect(changed).toBe(false);
  });

  it("survives a models list that is not a list", () => {
    writeToken(TOKEN);
    const { cfg, changed } = reconcile({
      models: { providers: { llamacpp: llamacpp(STALE, { models: "broken" }) } },
    });

    expect(changed).toBe(true);
    expect(providerOf(cfg, "llamacpp").apiKey).toBe(TOKEN);
  });

  it("survives a baseUrl that is not a string, and one that will not parse", () => {
    writeToken(TOKEN);
    expect(reconcile({ models: { providers: { llamacpp: { baseUrl: 42 } } } }).changed).toBe(false);
    expect(reconcile({ models: { providers: { llamacpp: { baseUrl: "http://[oops" } } } }).changed).toBe(false);
  });

  it("survives an undecodable byte in .env instead of failing pre-start", () => {
    writeFileSync(
      path.join(root, ".env"),
      Buffer.concat([Buffer.from("CLAWBOX_LOCAL_AI_PROXY_BASE_URL=http://box.local\nX="), Buffer.from([0xff])]),
    );
    writeToken(TOKEN);
    const { changed } = reconcile({
      models: { providers: { llamacpp: llamacpp(STALE) } },
    });

    expect(changed).toBe(true);
  });
});
