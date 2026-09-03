import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enableProviderPluginOps, providerPluginSwitchedOnBy } from "@/lib/provider-plugin-ops";

/**
 * The anthropic plugin toggle is two halves around the primary write: the
 * enable rides IN the primary's batch, ahead of it (OpenClaw 2 resolves an
 * `anthropic/...` reference only while the plugin is enabled, and validates
 * the batch as a whole), and `setProviderPlugins` runs AFTER it and switches
 * the plugin off only when nothing on the box could use it — no Anthropic
 * primary and no usable Anthropic credential. The one-way door (M-01 / F-02)
 * was a single call that did both halves, on the wrong side of the write.
 */

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: vi.fn(),
}));

/** A CLI child that exits with `code` on the next tick, `stderr` first when given. */
function exitingChild(code = 0, stderr = "") {
  const child = Object.assign(new EventEmitter(), {
    stdout: null,
    stderr: new EventEmitter(),
    stdin: null,
    kill: vi.fn(),
  });
  setImmediate(() => {
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

const originalHome = process.env.CLAWBOX_OPENCLAW_HOME;
const originalRoot = process.env.CLAWBOX_ROOT;
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-provider-plugins-"));
  process.env.CLAWBOX_OPENCLAW_HOME = home;
  // The owner's provider switch lives in ClawBox's own config store.
  process.env.CLAWBOX_ROOT = home;
  vi.resetModules();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => exitingChild());
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.CLAWBOX_OPENCLAW_HOME;
  else process.env.CLAWBOX_OPENCLAW_HOME = originalHome;
  if (originalRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = originalRoot;
  await fs.rm(home, { recursive: true, force: true });
});

/** A box whose anthropic plugin is `enabled`, and the module read against it. */
async function withAnthropicPlugin(enabled: boolean) {
  await fs.writeFile(
    path.join(home, "openclaw.json"),
    JSON.stringify({ plugins: { entries: { anthropic: { enabled } } } }),
  );
  return import("@/lib/openclaw-config");
}

/** The `plugins.entries.anthropic.enabled` value the CLI was asked to set, if any. */
function writtenValue(): string | null {
  const call = spawnMock.mock.calls.find(([, args]) =>
    (args as string[]).includes("plugins.entries.anthropic.enabled"));
  if (!call) return null;
  const args = call[1] as string[];
  return args[args.indexOf("plugins.entries.anthropic.enabled") + 1];
}

describe("enableProviderPluginOps — the ops that ride in the primary batch, ahead of it", () => {
  // Pure: OpenClaw 2 validates every model reference a batch touches against
  // the enabled plugins' catalogs after applying the WHOLE batch to one
  // snapshot, so the enable belongs in the same batch as the reference —
  // one spawn, and a refused batch leaves the flag as it was.
  it("switches the plugin on for an Anthropic reference", () => {
    expect(enableProviderPluginOps(["anthropic/claude-sonnet-5"])).toEqual([
      ["plugins.entries.anthropic.enabled", "true", "--json"],
    ]);
  });

  it("emits nothing for any other provider, and never a switch-off", () => {
    expect(enableProviderPluginOps(["deepseek/deepseek-v4-pro", "openai/gpt-5.5", "llamacpp/gemma"])).toEqual([]);
    expect(enableProviderPluginOps([])).toEqual([]);
    expect(enableProviderPluginOps([null, undefined, "no-slash"])).toEqual([]);
  });

  it("covers a fallback that names Anthropic, once, whatever the primary", () => {
    // `agents.defaults.model.fallbacks.N` is validated the same way the
    // primary is; a restore of primary + fallbacks needs one enable for both.
    expect(enableProviderPluginOps(["openai/gpt-5.5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5"])).toEqual([
      ["plugins.entries.anthropic.enabled", "true", "--json"],
    ]);
  });
});

// A plugin that is off enumerates NOTHING: `openclaw models list --provider
// anthropic` is empty until it is switched back on. So the ON half is a
// provider-set change exactly as the OFF half is, and the catalogue has to
// count it — an empty enumeration is recorded as a failed refresh, and that
// wait doubles up to the six-hour refresh interval, so a provider whose plugin
// has been off for a while would not be re-asked for six hours after the very
// pick that made it listable. Nothing could see that transition: the enable
// rides in the batch, so by the time `setProviderPlugins` re-reads the config
// the flag is already true and it correctly reports no flip.
describe("providerPluginSwitchedOnBy — which provider the batch actually switches ON", () => {
  const OFF = { plugins: { entries: { anthropic: { enabled: false } } } } as never;
  const ON = { plugins: { entries: { anthropic: { enabled: true } } } } as never;

  it("names the provider when the flag was off", () => {
    expect(providerPluginSwitchedOnBy(["anthropic/claude-sonnet-5"], OFF)).toBe("anthropic");
    // A fallback names it too, and is validated exactly like the primary.
    expect(providerPluginSwitchedOnBy(["llamacpp/gemma", "anthropic/claude-haiku-4-5"], OFF)).toBe("anthropic");
  });

  it("stays silent when the flag was already on, however it was spelled", () => {
    // The ops are emitted whether or not the flag is already true — that is
    // deliberate, because the enable is also what makes the core validate the
    // reference. Their presence is not a state change, and announcing one per
    // Claude pick would spend a ~3-minute `openclaw models list` on a Jetson.
    expect(providerPluginSwitchedOnBy(["anthropic/claude-sonnet-5"], ON)).toBeNull();
    // An ABSENT flag is enabled: the plugin declares `enabledByDefault: true`.
    expect(providerPluginSwitchedOnBy(["anthropic/claude-sonnet-5"], {})).toBeNull();
    // And a config that could not be read must not be reported as a change.
    expect(providerPluginSwitchedOnBy(["anthropic/claude-sonnet-5"], null)).toBeNull();
  });

  it("stays silent when the batch names no gated provider at all", () => {
    expect(providerPluginSwitchedOnBy(["openai/gpt-5.5", "llamacpp/gemma"], OFF)).toBeNull();
    expect(providerPluginSwitchedOnBy([], OFF)).toBeNull();
    expect(providerPluginSwitchedOnBy([null, undefined, "no-slash"], OFF)).toBeNull();
  });
});

describe("setProviderPlugins — the half AFTER the primary write", () => {
  it("switches the plugin off once the primary has left Anthropic and nothing could use it", async () => {
    const { setProviderPlugins } = await withAnthropicPlugin(true);
    await setProviderPlugins("deepseek");
    expect(writtenValue()).toBe("false");
  });

  it("keeps the plugin on after a switch away while an Anthropic credential exists", async () => {
    // Measured on a 2026.8.1 box: with the plugin disabled, `models list
    // --provider anthropic --all --json` answers ONE row against eleven with
    // it enabled — the three-model Claude picker. A provider the owner can
    // still pick keeps its catalog.
    await fs.writeFile(
      path.join(home, "openclaw.json"),
      JSON.stringify({
        plugins: { entries: { anthropic: { enabled: true } } },
        auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "api_key" } } },
      }),
    );
    const { setProviderPlugins } = await import("@/lib/openclaw-config");
    await setProviderPlugins("deepseek");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps the plugin on while a configured FALLBACK still names Anthropic, credential or not", async () => {
    // The gateway will route there when the primary fails, and only the plugin
    // resolves the reference. The core does not protect this itself: a batch
    // whose only operation is the plugin flag touches no model ref, so nothing
    // is validated and the disable lands.
    await fs.writeFile(
      path.join(home, "openclaw.json"),
      JSON.stringify({
        plugins: { entries: { anthropic: { enabled: true } } },
        agents: { defaults: { model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-5"] } } },
      }),
    );
    const { setProviderPlugins } = await import("@/lib/openclaw-config");
    await setProviderPlugins("openai");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("switches the plugin off despite a credential the owner switched off in Settings", async () => {
    // The switch takes the provider out of every place the box picks a model,
    // so a credential behind it is one nothing can route to — and its plugin
    // is pure prep cost.
    await fs.writeFile(
      path.join(home, "openclaw.json"),
      JSON.stringify({
        plugins: { entries: { anthropic: { enabled: true } } },
        auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "api_key" } } },
      }),
    );
    await fs.mkdir(path.join(home, "data"), { recursive: true });
    await fs.writeFile(path.join(home, "data", "config.json"), JSON.stringify({ ai_disabled_providers: ["anthropic"] }));
    const { setProviderPlugins } = await import("@/lib/openclaw-config");
    await setProviderPlugins("deepseek");
    expect(writtenValue()).toBe("false");
  });

  it("treats an absent flag as enabled — the plugin declares enabledByDefault", async () => {
    await fs.writeFile(path.join(home, "openclaw.json"), JSON.stringify({}));
    const { setProviderPlugins } = await import("@/lib/openclaw-config");
    await setProviderPlugins("anthropic");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("leaves the plugin alone when the config cannot be read — unreadable is not 'no credential'", async () => {
    // `readConfig` answers `{}` to a half-written or unreadable file; deciding
    // "nothing could use the plugin" from that would switch it off on a box
    // that holds a credential.
    await fs.writeFile(path.join(home, "openclaw.json"), "{ not json");
    const { setProviderPlugins } = await import("@/lib/openclaw-config");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setProviderPlugins("deepseek");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("switches the plugin back on after a switch away when a credential exists and an older gate left it off", async () => {
    await fs.writeFile(
      path.join(home, "openclaw.json"),
      JSON.stringify({
        plugins: { entries: { anthropic: { enabled: false } } },
        auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
      }),
    );
    const { setProviderPlugins } = await import("@/lib/openclaw-config");
    await setProviderPlugins("deepseek");
    expect(writtenValue()).toBe("true");
  });

  it("leaves an already-enabled plugin alone for an Anthropic primary", async () => {
    const { setProviderPlugins } = await withAnthropicPlugin(true);
    await setProviderPlugins("anthropic");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still switches the plugin on for an Anthropic primary if the BEFORE half was skipped", async () => {
    // Idempotent both ways, so a caller that only has the after-write call
    // (or whose enable failed and was retried by the CLI later) converges.
    const { setProviderPlugins } = await withAnthropicPlugin(false);
    await setProviderPlugins("anthropic");
    expect(writtenValue()).toBe("true");
  });
});
