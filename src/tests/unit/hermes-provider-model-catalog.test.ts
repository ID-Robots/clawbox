import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What HERMES itself knows about the models a ClawBox-owned provider serves.
 *
 * The chat dropdown in our dashboard is not the only picker on the box. Hermes
 * builds its own — the Telegram/Discord `/model` inline keyboard and the Hermes
 * dashboard's Models page — from `list_authenticated_providers`
 * (hermes_cli/model_switch.py:2571, Hermes 0.20.5 on a Hermes-edition box), and
 * BOTH of those surfaces read the `providers:` block of ~/.hermes/config.yaml,
 * never anything ClawBox serves. `/api/model/options` (hermes_cli/web_server.py:6998)
 * goes through `build_model_options_payload(load_picker_context())`, i.e. the
 * same substrate, so config.yaml is the single source both surfaces share.
 *
 * For a custom OpenAI-compatible provider (which is what ClawBox AI and the
 * on-device model both are) that block is read like this, per section 3 of
 * `list_authenticated_providers`:
 *
 *   - the row's models are `default_model`/`model` plus `_declared_model_ids`
 *     of `models:` (model_switch.py:61);
 *   - the endpoint is then probed at `<base_url>/models`, and the probe's
 *     answer REPLACES the declared list unless the declared list is an
 *     allowlist shape and the probe came back empty (model_switch.py:3423-3431,
 *     `_models_config_is_allowlist` at model_switch.py:136).
 *
 * The ClawBox AI proxy answers that probe `200 {"status":"ok","models":[…]}` —
 * not the OpenAI `{"data":[{"id":…}]}` envelope Hermes parses
 * (`probe_api_models`, hermes_cli/models.py:5592) — so the probe yields an
 * EMPTY list, and a provider block that declares nothing renders as
 * "clawai (0)": no ClawBox AI model to pick, on the box's own bot.
 *
 * Declaring the ids in `providers.<slug>.models` is Hermes' own mechanism for
 * exactly this ("custom endpoints … where the user may supply their own model
 * set through config", `list_picker_providers`, model_switch.py:3926), and it
 * never narrows a working endpoint: a NON-empty probe still wins.
 */

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/config-store", () => ({ setMany: vi.fn() }));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn() }));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn(async () => ({ ready: false })) }));
vi.mock("@/lib/coding-agent-mcp-refresh", () => ({
  refreshCodingAgentToolsIfReadinessChanged: vi.fn(),
}));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: vi.fn(),
}));
const resolveVisionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  resolveVisionModelId: resolveVisionMock,
}));

import {
  CLAWAI_PROVIDER,
  applyClawaiToHermes,
  reconcileClawaiModelsWithHermes,
  _resetClawaiModelsReconcileForTests,
} from "@/lib/hermes-clawai";
import { hermesPickerModels } from "@/tests/helpers/hermes-picker-catalogue";
import {
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_PRO_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL_ID,
} from "@/lib/clawbox-ai-models";

/**
 * The `providers.<slug>` block the writer left behind, decoded the way
 * `hermes config set` decodes a value (hermes_cli/config.py:5515: a list or
 * mapping literal is parsed, everything else stays a string).
 */
function providerEntry(slug: string): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const call of cliMock.mock.calls) {
    const args = call[0] as string[];
    if (args[0] !== "config") continue;
    const prefix = `providers.${slug}.`;
    if (!args[2]?.startsWith(prefix)) continue;
    const leaf = args[2].slice(prefix.length);
    if (args[1] === "unset") delete entry[leaf];
    if (args[1] !== "set") continue;
    const raw = args[3];
    let value: unknown = raw;
    if (/^\s*[[{]/.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        /* stored as a string, exactly as the CLI would */
      }
    }
    entry[leaf] = value;
  }
  return entry;
}

describe("what Hermes' own /model picker knows about ClawBox AI", () => {
  beforeEach(() => {
    cliMock.mockReset();
    cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    resolveVisionMock.mockReset();
    resolveVisionMock.mockResolvedValue({
      id: CLAWBOX_AI_VISION_MODEL_ID,
      verified: true,
      reason: "proxy-allows",
    });
  });

  it("offers both tier models even though the proxy's /models is unreadable", async () => {
    await applyClawaiToHermes("claw_token_abc", "flash");
    // `[]` is not a guess: the live proxy answers 200 with
    // {"status":"ok","service":"ClawBox AI Proxy","models":[…]} and Hermes reads
    // `data[].id`, so its probe comes back empty on every box.
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("still defers to the endpoint when it does answer", async () => {
    await applyClawaiToHermes("claw_token_abc", "flash");
    // A declared list is a floor, never a ceiling: the day the proxy speaks the
    // OpenAI envelope, its answer is the one the picker shows.
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), ["deepseek-v5"])).toEqual(["deepseek-v5"]);
  });

  it("would lose the declaration to a discovered-catalogue flag beside it", async () => {
    // The mirror's own boundary, and a hazard for any future writer of a
    // `providers.<slug>` block: with `models_discovered: true` beside
    // `models:`, `_models_config_is_allowlist` (model_switch.py:136) returns
    // False WHATEVER the shape, the empty probe wins and the row is empty
    // again. Not reachable for `providers.clawai` today — Hermes writes that
    // flag only into `custom_providers` entries
    // (`_save_discovered_models_to_config`, model_switch.py:244) — so a writer
    // that ever meets it has to CLEAR it, not just declare beside it.
    const declared = { models: [CLAWBOX_AI_FLASH_MODEL_ID, CLAWBOX_AI_PRO_MODEL_ID] };
    expect(hermesPickerModels(declared, [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
    expect(hermesPickerModels({ ...declared, models_discovered: true }, [])).toEqual([]);
  });

  it("does not offer the vision model as something to chat with", async () => {
    await applyClawaiToHermes("claw_token_abc", "pro");
    // It exists so an attached picture gets looked at (`auxiliary.vision`), and
    // it is not a chat tier. Declaring it here would put it in the keyboard.
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).not.toContain(
      CLAWBOX_AI_VISION_MODEL_ID,
    );
  });

});

describe("repairing a ClawBox AI box that was linked earlier", () => {
  beforeEach(() => {
    _resetClawaiModelsReconcileForTests();
    cliMock.mockReset();
    cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  });

  it("backfills a box that was linked before the catalogue was declared", async () => {
    // Every box in the field is in this state: `providers.clawai` has the URL,
    // the key and the mode, and no `models:` at all. Nothing re-links it, so
    // without a repair the bot keeps saying "clawai (0)" forever.
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === `providers.${CLAWAI_PROVIDER}.base_url`) {
        return { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" };
      }
      if (args[1] === "get" && args[2] === `providers.${CLAWAI_PROVIDER}.models`) {
        return { code: 1, stdout: "", stderr: "config key not set" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("leaves a catalogue that is already there alone", async () => {
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === `providers.${CLAWAI_PROVIDER}.base_url`) {
        return { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" };
      }
      if (args[1] === "get" && args[2] === `providers.${CLAWAI_PROVIDER}.models`) {
        return { code: 0, stdout: '["deepseek-v4-flash", "deepseek-v4-pro"]\n', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.some((c) => (c[0] as string[])[1] === "set")).toBe(false);
  });

  it("writes nothing on a box that has no ClawBox AI provider block", async () => {
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "config key not set" });
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.some((c) => (c[0] as string[])[1] === "set")).toBe(false);
  });

  it("writes nothing when the catalogue key could not be read", async () => {
    // An unreadable config is not an unconfigured one — the same rule the
    // plugins.enabled read-modify-write follows. The provider block is
    // deliberately readable here, so this can only pass through the gate it is
    // named after rather than through the "no clawai block" one above.
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${CLAWAI_PROVIDER}.models`
        ? { code: 1, stdout: "", stderr: "permission denied" }
        : { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.some((c) => (c[0] as string[])[1] === "set")).toBe(false);
  });

  it("tries again after a catalogue read that FAILED rather than answered", async () => {
    // A non-zero exit whose message is not "config key not set" is not the
    // answer "no key here" — it is an unreadable config: an EACCES on
    // config.yaml, Hermes' own filelock held by an interactive CLI, a parse
    // error. Leaving the file alone is right; latching is not, and it is the
    // same probe-once trap the branch above already fixed. `localCatalogueState`
    // maps this identical result to "unknown" and retries; so must this.
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${CLAWAI_PROVIDER}.models`
        ? { code: 1, stdout: "", stderr: "permission denied" }
        : { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.some((c) => (c[0] as string[])[1] === "set")).toBe(false);

    cliMock.mockReset();
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${CLAWAI_PROVIDER}.models`
        ? { code: 1, stdout: "", stderr: "config key not set" }
        : { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("declares the catalogue over a value Hermes does not read as an allowlist", async () => {
    // `providers.clawai.models` present as a MAPPING — the per-model metadata
    // shape Hermes' own model wizard writes. `_models_config_is_allowlist`
    // (model_switch.py:136) returns False for a mapping, so `has_explicit_models`
    // stays false, the empty probe REPLACES it (model_switch.py:3423-3431) and
    // the keyboard says "clawai (0)". A key that exists is not a key Hermes
    // reads: the repair has to look at the value.
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${CLAWAI_PROVIDER}.models`
        ? { code: 0, stdout: '{"deepseek-v4-flash": {"context_length": 65536}}\n', stderr: "" }
        : { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("declares the catalogue over an empty list", async () => {
    // Same rule, the other unusable shape: `_models_config_is_allowlist`
    // requires at least one id, so `models: []` leaves the probe free to win
    // with nothing.
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${CLAWAI_PROVIDER}.models`
        ? { code: 0, stdout: "[]\n", stderr: "" }
        : { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("leaves a single id the owner pinned by hand alone", async () => {
    // A bare string IS an allowlist as far as Hermes is concerned, so this box
    // offers exactly what its owner asked for. Widening it back to both tiers
    // would be this repair overruling a deliberate configuration.
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${CLAWAI_PROVIDER}.models`
        ? { code: 0, stdout: '"deepseek-v4-flash"\n', stderr: "" }
        : { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.some((c) => (c[0] as string[])[1] === "set")).toBe(false);
  });

  it("asks the CLI for the catalogue as JSON", async () => {
    // Not a style choice. Plain `hermes config get` renders a list or a mapping
    // through `yaml.safe_dump` (hermes_cli/config.py:1203,
    // `_format_config_get_value`), so `- deepseek-v4-flash` and
    // `deepseek-v4-flash:\n  context_length: 65536` arrive as two blocks of text
    // that only a YAML reader can tell apart — and telling them apart is the
    // whole of the check above. `--json` is the CLI's own machine-readable mode
    // (`hermes config get <key> [--json]`, config.py:5769), verified on the
    // pinned Hermes build every box runs.
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${CLAWAI_PROVIDER}.models`
        ? { code: 1, stdout: "", stderr: "config key not set" }
        : { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    const read = cliMock.mock.calls
      .map((c) => c[0] as string[])
      .find((args) => args[1] === "get" && args[2] === `providers.${CLAWAI_PROVIDER}.models`);
    expect(read).toContain("--json");
  });

  it("tries again after a read the CLI never answered", async () => {
    // `hermes` is a shim over a venv Python, and `step_hermes_install` rebuilds
    // that checkout for ~90 s with no web-server restart — the shim runs and
    // exits 127 without reaching argparse. Latching on that would skip the
    // repair for the life of the process, on the very update shipping it.
    cliMock.mockResolvedValue({ code: 127, stdout: "", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.some((c) => (c[0] as string[])[1] === "set")).toBe(false);

    cliMock.mockReset();
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === `providers.${CLAWAI_PROVIDER}.models`
        ? { code: 1, stdout: "", stderr: "config key not set" }
        : { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("tries again after a write that failed", async () => {
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "set") return { code: 1, stdout: "", stderr: "config is locked" };
      return args[2] === `providers.${CLAWAI_PROVIDER}.models`
        ? { code: 1, stdout: "", stderr: "config key not set" }
        : { code: 0, stdout: "https://clawbox.com/api/ai\n", stderr: "" };
    });
    await reconcileClawaiModelsWithHermes();
    const firstAttempt = cliMock.mock.calls.filter((c) => (c[0] as string[])[1] === "set").length;
    await reconcileClawaiModelsWithHermes();
    // A failed repair is not a repair: the next request must try it again.
    expect(cliMock.mock.calls.filter((c) => (c[0] as string[])[1] === "set").length)
      .toBeGreaterThan(firstAttempt);
  });
});
