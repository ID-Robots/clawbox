import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-701 — `plugins.enabled` was written on an exit code and read back never.
 *
 * `hermes config set k '["a"]'` exits 0 whether or not its coercion yielded a
 * list. When it does not, it prints "…storing as string." to stderr and stores
 * the LITERAL TEXT (hermes_cli/config.py:5514-5527, read on the pinned 0.20.5
 * build). What that costs here is not one plugin:
 *
 *     _get_enabled_set()  ->  set(enabled) if isinstance(enabled, list) else set()
 *     (hermes_cli/plugins_cmd.py:1309-1324)
 *
 * A string is not a list, so the allow-list reads EMPTY and Hermes loads NO
 * user plugin at all — the customer's included. And the box could not heal
 * itself, because ClawBox read the key back through a YAML-text parser that
 * decodes the residue `["clawai"]` as a real one-element list: the merge then
 * answered "already there, nothing to do" for a key that was disabling
 * everything. Meanwhile `image_gen.provider` was written regardless, so
 * `/setup-api/chat/capabilities` reported a box that can draw through a plugin
 * Hermes never loaded.
 *
 * Harness-first note for the reader: Hermes owns `hermes plugins enable <name>`,
 * which does this read-modify-write itself and cannot store a string. It is not
 * used here — see the PR body — because `_resolve_plugin_key("clawai")` answers
 * `image_gen/clawai` on the pinned build, a different string from the one the
 * loader already accepts on every field box, and swapping them is a link-path
 * change that wants a device test rather than a unit one.
 */

const cliMock = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(() => vi.fn());
const installMock = vi.hoisted(() => vi.fn());
const drawsMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/harness/hermes-features", () => ({ hermesAgentDrawsImages: drawsMock }));
vi.mock("@/lib/hermes-image-refresh", () => ({ refreshHermesImageTools: refreshMock }));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn(async () => ({ ready: false })) }));
vi.mock("@/lib/coding-agent-mcp-refresh", () => ({
  refreshCodingAgentToolsIfReadinessChanged: vi.fn(),
}));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/config-store", () => ({ setMany: vi.fn() }));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: envMock }));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: installMock,
}));

import { applyClawaiToHermes } from "@/lib/hermes-clawai";
import { HERMES_IMAGE_PLUGIN_NAME } from "@/lib/hermes-image-plugin";

/** Every `config set`, as "key=value", in the order they were issued. */
function sets(): string[] {
  return cliMock.mock.calls
    .map((c) => c[0] as string[])
    .filter((a) => a[1] === "set")
    .map((a) => `${a[2]}=${a[3]}`);
}

function wrotePluginsEnabled(): boolean {
  return sets().some((s) => s.startsWith("plugins.enabled="));
}

function claimedItCanDraw(): boolean {
  return sets().some((s) => s.startsWith("image_gen.provider="));
}

/** The CLI's own warning when a JSON literal did not coerce to a structure. */
const STORING_AS_STRING =
  "Warning: value for 'plugins.enabled' looks like a list/mapping but parsed as str; storing as string.";

interface Reply { code: number; stdout: string; stderr: string }

/** `hermes config get <key>` with no flag: a YAML block list, or raw text. */
function renderPlain(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => `- ${v}`).join("\n") + "\n" : String(value);
}

/**
 * A box whose `plugins.enabled` HOLDS `value`, rendered the way the CLI renders
 * it: `--json` prints `json.dumps(value)` (hermes_cli/config.py:5769), a plain
 * get prints YAML. That difference is the whole subject of this file — a stored
 * STRING and a stored LIST are the same characters in the plain rendering — so
 * the stub has to reproduce it rather than answer one shape to both.
 *
 * `value: undefined` is an unset key, which the CLI reports as a non-zero exit.
 */
function box(opts: { value: unknown; onSet?: Reply }): void {
  cliMock.mockImplementation(async (args: string[]) => {
    if (args[1] === "get" && args[2] === "plugins.enabled") {
      if (opts.value === undefined) {
        return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
      }
      return args.includes("--json")
        ? { code: 0, stdout: JSON.stringify(opts.value), stderr: "" }
        : { code: 0, stdout: renderPlain(opts.value), stderr: "" };
    }
    if (args[1] === "set" && args[2] === "plugins.enabled") {
      return opts.onSet ?? { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cliMock.mockReset();
  envMock.mockReset();
  installMock.mockReset();
  drawsMock.mockReset();
  refreshMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  drawsMock.mockResolvedValueOnce(false).mockResolvedValue(true);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("plugins.enabled is written on a read-back, not on an exit code", () => {
  it("repairs a key whose previous write was stored as text", async () => {
    // The residue of an earlier `config set`: a STRING that happens to spell a
    // list. Hermes loads nothing at all from it. Read through YAML this looks
    // like a one-element list already containing us, which is why the box could
    // never heal itself.
    box({ value: `["${HERMES_IMAGE_PLUGIN_NAME}"]` });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(wrotePluginsEnabled(), "a string residue must be rewritten as a list").toBe(true);
  });

  it("does not claim the agent can draw when the CLI stored the list as text", async () => {
    box({ value: undefined, onSet: { code: 0, stdout: "", stderr: STORING_AS_STRING } });

    await applyClawaiToHermes("claw_token_abc", "flash");

    // The write exited 0. Nothing else about it was true.
    expect(claimedItCanDraw()).toBe(false);
  });

  it("does not claim the agent can draw when the key reads back as something else", async () => {
    // No warning on stderr — an older CLI stores the literal silently — so the
    // read-back is the only witness. It answers with the string it stored.
    let written = false;
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "set" && args[2] === "plugins.enabled") {
        written = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        if (!written) return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
        const residue = `["${HERMES_IMAGE_PLUGIN_NAME}"]`;
        return args.includes("--json")
          ? { code: 0, stdout: JSON.stringify(residue), stderr: "" }
          : { code: 0, stdout: residue, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
  });

  it("asks for the machine-readable rendering, so a string is not read as a list", async () => {
    box({ value: [HERMES_IMAGE_PLUGIN_NAME] });

    await applyClawaiToHermes("claw_token_abc", "flash");

    const reads = cliMock.mock.calls
      .map((c) => c[0] as string[])
      .filter((a) => a[1] === "get" && a[2] === "plugins.enabled");
    expect(reads.length).toBeGreaterThan(0);
    for (const args of reads) expect(args).toContain("--json");
  });

  it("still links, and still draws, on a box where the key lands as a list", async () => {
    box({ value: ["weather", HERMES_IMAGE_PLUGIN_NAME] });

    await applyClawaiToHermes("claw_token_abc", "flash");

    // Already listed as a real list: nothing to write, and the backend is named.
    expect(wrotePluginsEnabled()).toBe(false);
    expect(claimedItCanDraw()).toBe(true);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("plugins.enabled"),
      expect.anything(),
    );
  });

  it("keeps the customer's plugins when it adds itself", async () => {
    box({ value: ["weather", "spotify"] });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(sets()).toContain(
      `plugins.enabled=${JSON.stringify(["weather", "spotify", HERMES_IMAGE_PLUGIN_NAME])}`,
    );
  });
});
