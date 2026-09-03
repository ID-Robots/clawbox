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
 * (`probe_api_models`, hermes_cli/models.py:5668) — so the probe yields an
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
import {
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_PRO_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL_ID,
} from "@/lib/clawbox-ai-models";

// ── Hermes' reader, mirrored ────────────────────────────────────────────────
//
// Small on purpose: it is the CONTRACT the writer has to satisfy, pinned so a
// change of shape (a comma-joined string, a list of objects, a bare default)
// fails here rather than on a customer's phone.

/** `_declared_model_ids` — hermes_cli/model_switch.py:61. */
function declaredModelIds(value: unknown): string[] {
  const ids: string[] = [];
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const id = candidate.trim();
    if (!id || ids.some((seen) => seen.toLowerCase() === id.toLowerCase())) return;
    ids.push(id);
  };
  if (typeof value === "string") add(value);
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") add(item);
      else if (item && typeof item === "object") {
        const row = item as { id?: unknown; name?: unknown };
        add(typeof row.id === "string" && row.id.trim() ? row.id : row.name);
      }
    }
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (key === "__explicit_model_allowlist__" || key === "__discovered_model_catalog__") continue;
      add(key);
    }
  }
  return ids;
}

/** `_models_config_is_allowlist` — hermes_cli/model_switch.py:136. */
function modelsConfigIsAllowlist(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return declaredModelIds(value).length > 0;
  return false;
}

/**
 * The model ids Hermes' `/model` picker offers for one `providers:` entry.
 * `liveProbe` is what `<base_url>/models` yielded — `[]` when the endpoint
 * answered in a shape Hermes could not read, `null` when it did not answer.
 */
function hermesPickerModels(entry: Record<string, unknown>, liveProbe: string[] | null): string[] {
  const declared = declaredModelIds(entry.models);
  const fallbackDefault = entry.default_model ?? entry.model;
  const models = typeof fallbackDefault === "string" && fallbackDefault.trim()
    ? [fallbackDefault.trim(), ...declared.filter((id) => id !== fallbackDefault.trim())]
    : declared;
  const hasExplicitModels = modelsConfigIsAllowlist(entry.models);
  if (liveProbe !== null && (liveProbe.length > 0 || !hasExplicitModels)) return liveProbe;
  return models;
}

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
        return { code: 0, stdout: "['deepseek-v4-flash', 'deepseek-v4-pro']\n", stderr: "" };
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

  it("writes nothing when the config could not be read at all", async () => {
    // An unreadable config is not an unconfigured one — the same rule the
    // plugins.enabled read-modify-write follows.
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "permission denied" });
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.some((c) => (c[0] as string[])[1] === "set")).toBe(false);
  });
});
