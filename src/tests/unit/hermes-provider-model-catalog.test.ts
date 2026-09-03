import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const invalidateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: invalidateMock }));
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
    invalidateMock.mockClear();
    // The repair holds a FAILED attempt for a minute, so a test that proves a
    // retry has to say how much later that retry is.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The `providers.clawai` block this box has, as the CLI would print it. */
  const LINKED = {
    base_url: "https://clawbox.com/api/ai",
    api_key: "claw_token_abc",
    api_mode: "openai",
  };

  /**
   * What `hermes config get providers.clawai --json` answers here.
   *
   * ONE read of the whole block, because Hermes decides what `models:` means
   * from its siblings — `discover_models` and `models_discovered` — and the
   * `base_url` orphan guard needs the same entry.
   */
  function providerBlock(
    entry: Record<string, unknown> | null,
    failure: { code?: number; stderr?: string } = {},
  ) {
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === `providers.${CLAWAI_PROVIDER}`) {
        return entry
          ? { code: 0, stdout: `${JSON.stringify(entry)}\n`, stderr: "" }
          : { code: failure.code ?? 1, stdout: "", stderr: failure.stderr ?? "config key not set" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
  }

  const wrote = () => cliMock.mock.calls.some((c) => (c[0] as string[])[1] === "set");

  it("backfills a box that was linked before the catalogue was declared", async () => {
    // Every box in the field is in this state: `providers.clawai` has the URL,
    // the key and the mode, and no `models:` at all. Nothing re-links it, so
    // without a repair the bot keeps saying "clawai (0)" forever.
    providerBlock(LINKED);
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("asks for the whole provider block in one call", async () => {
    // Not tidiness: reading the `models` LEAF cannot see `discover_models` or
    // `models_discovered`, which are what decide whether the value beside them
    // means anything to Hermes. Reading the entry answers both AND carries the
    // `base_url` the orphan guard needs, so it also costs one Python start
    // instead of two.
    providerBlock(LINKED);
    await reconcileClawaiModelsWithHermes();
    const reads = cliMock.mock.calls
      .map((c) => c[0] as string[])
      .filter((args) => args[1] === "get");
    expect(reads).toEqual([["config", "get", `providers.${CLAWAI_PROVIDER}`, "--json"]]);
  });

  it("asks the CLI for the catalogue as JSON", async () => {
    // Not a style choice. Plain `hermes config get` renders a block through
    // `yaml.safe_dump` and a bare string through `str()`
    // (`_format_config_get_value`, hermes_cli/config.py:1203), so a declared
    // list, a metadata mapping and a scalar id arrive as text only a YAML
    // reader could separate — and telling them apart is the whole of this
    // repair. `--json` is the CLI's own machine-readable mode
    // (`hermes config get <key> [--json]`, config.py:5769).
    providerBlock(LINKED);
    await reconcileClawaiModelsWithHermes();
    const read = cliMock.mock.calls
      .map((c) => c[0] as string[])
      .find((args) => args[1] === "get");
    expect(read).toContain("--json");
  });

  it("leaves a catalogue that is already there alone", async () => {
    providerBlock({ ...LINKED, models: [CLAWBOX_AI_FLASH_MODEL_ID, CLAWBOX_AI_PRO_MODEL_ID] });
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);
  });

  it("leaves a single id the owner pinned by hand alone", async () => {
    // A bare string IS an allowlist as far as Hermes is concerned, so this box
    // offers exactly what its owner asked for. Widening it back to both tiers
    // would be this repair overruling a deliberate configuration.
    providerBlock({ ...LINKED, models: CLAWBOX_AI_FLASH_MODEL_ID });
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);
  });

  it("leaves a catalogue the owner pinned with discover_models: false alone", async () => {
    // The one shape that looks broken and is not. `discover_models: false` is
    // Hermes' documented way to pin a catalogue of ANY shape
    // (model_switch.py:3777), and with discovery off no probe runs — so the
    // mapping IS what the keyboard shows and this owner has no symptom at all.
    // Overwriting it would drop their per-model metadata to fix nothing.
    providerBlock({
      ...LINKED,
      discover_models: false,
      models: { [CLAWBOX_AI_FLASH_MODEL_ID]: { context_length: 65536 } },
    });
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);
  });

  it("leaves a catalogue Hermes persisted for itself alone", async () => {
    // `models_discovered: true` makes `_models_config_is_allowlist` return
    // False WHATEVER the shape (model_switch.py:136), so our list would be
    // ignored with it — writing here would latch "repaired" over a keyboard
    // still saying "clawai (0)".
    providerBlock({
      ...LINKED,
      models_discovered: true,
      models: { [CLAWBOX_AI_FLASH_MODEL_ID]: { context_length: 65536 } },
    });
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);
  });

  it("declares the catalogue over a value Hermes does not read as an allowlist", async () => {
    // The same mapping WITHOUT a pin beside it. `_models_config_is_allowlist`
    // returns False for a mapping, so `has_explicit_models` stays false, the
    // empty probe REPLACES it (model_switch.py:3423-3431) and the keyboard says
    // "clawai (0)" — with a populated `models:` in the file. A key that exists
    // is not a key Hermes reads.
    providerBlock({ ...LINKED, models: { [CLAWBOX_AI_FLASH_MODEL_ID]: { context_length: 65536 } } });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("declares a catalogue for a pin that pins nothing", async () => {
    // `discover_models: false` with NO `models:` is not a pin — there is
    // nothing there to honour. Hermes takes `_discovery_allowed = false`
    // (model_switch.py:3788), runs no probe, and `_declared_model_ids` finds no
    // id, so the row is EMPTY: the exact "clawai (0)" this PR exists to fix,
    // reached by the one path that used to walk away logging "pinned".
    providerBlock({ ...LINKED, discover_models: false });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("declares a catalogue for a pin holding an empty list", async () => {
    // Same hole, the other spelling.
    providerBlock({ ...LINKED, discover_models: false, models: [] });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("still honours a pin that actually pins something", async () => {
    // The boundary the two above must not move: with discovery off AND ids
    // present, `_declared_model_ids` reads even a mapping's keys, so the
    // keyboard shows them and this owner has nothing wrong with their box.
    providerBlock({
      ...LINKED,
      discover_models: false,
      models: { [CLAWBOX_AI_FLASH_MODEL_ID]: { context_length: 65536 } },
    });
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);
  });

  it("reads `discover_models` exactly as Hermes coerces it", async () => {
    // Hermes does a bare `discover.lower() not in {"false","no","0"}`
    // (model_switch.py:3371 and :3603) — no trim. So a quoted " false " is
    // discovery ON to Hermes, which means the empty probe wipes the block and
    // the repair is needed. A mirror that trimmed would decline to touch it.
    providerBlock({
      ...LINKED,
      discover_models: " false ",
      models: { [CLAWBOX_AI_FLASH_MODEL_ID]: { context_length: 65536 } },
    });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("says so when the block carries no endpoint", async () => {
    // A `providers.clawai` with no `base_url` is not an ordinary box — it is an
    // invalid state — so unlike the two ordinary verdicts it earns a line. The
    // line names the provider and nothing else: the block it came from carries
    // `api_key`.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      providerBlock({ api_mode: "openai" });
      await reconcileClawaiModelsWithHermes();
      expect(wrote()).toBe(false);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("treats a write the CLI stored as a STRING as a failure", async () => {
    // `hermes config set k '["a","b"]'` exits 0 EVEN WHEN its structured parse
    // did not yield a list — it prints `…storing as string.` to stderr and
    // saves the literal text (hermes_cli/config.py:5518-5530). Hermes then
    // reads that string as a one-id allowlist and the keyboard offers a single
    // bogus model. An exit code is not an outcome.
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "set") {
        return {
          code: 0,
          stdout: "",
          stderr: "Warning: value for 'providers.clawai.models' looks like a"
            + " list/mapping but parsed as str; storing as string.",
        };
      }
      return { code: 0, stdout: `${JSON.stringify(LINKED)}\n`, stderr: "" };
    });
    await reconcileClawaiModelsWithHermes();
    // Not claimed: the catalogue cache is only dropped for a write that landed.
    expect(invalidateMock).not.toHaveBeenCalled();

    const firstAttempt = cliMock.mock.calls.filter((c) => (c[0] as string[])[1] === "set").length;
    vi.advanceTimersByTime(60_001);
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.filter((c) => (c[0] as string[])[1] === "set").length)
      .toBeGreaterThan(firstAttempt);
  });

  it("declares the catalogue over an empty list", async () => {
    // Same rule, the other unusable shape: an allowlist needs at least one id,
    // so `models: []` leaves the probe free to win with nothing.
    providerBlock({ ...LINKED, models: [] });
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("writes nothing on a box that has no ClawBox AI provider block", async () => {
    // `models:` beside no endpoint is a picker row offering two models with
    // nowhere to send them — the orphan the local provider's removal avoids.
    providerBlock(null);
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);
  });

  it("writes nothing on a block that carries no endpoint", async () => {
    providerBlock({ api_mode: "openai" });
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);
  });

  it("writes nothing when the provider block could not be read", async () => {
    // An unreadable config is not an unconfigured one — the same rule the
    // plugins.enabled read-modify-write follows.
    providerBlock(null, { code: 1, stderr: "permission denied" });
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);
  });

  it("tries again after a read that FAILED rather than answered", async () => {
    // A non-zero exit whose message is not "config key not set" is not the
    // answer "nothing there" — it is an unreadable config: an EACCES on
    // config.yaml, Hermes' own filelock held by an interactive CLI, a parse
    // error. Leaving the file alone is right; latching is not.
    providerBlock(null, { code: 1, stderr: "permission denied" });
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);

    vi.advanceTimersByTime(60_001);
    cliMock.mockReset();
    providerBlock(LINKED);
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("tries again after a read the CLI never answered", async () => {
    // `hermes` is a shim over a venv Python, and `step_hermes_install` rebuilds
    // that checkout for ~90 s with no web-server restart — the shim runs and
    // exits 127 without reaching argparse. Latching on that would skip the
    // repair for the life of the process, on the very update shipping it.
    cliMock.mockResolvedValue({ code: 127, stdout: "", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    expect(wrote()).toBe(false);

    vi.advanceTimersByTime(60_001);
    cliMock.mockReset();
    providerBlock(LINKED);
    await reconcileClawaiModelsWithHermes();
    expect(hermesPickerModels(providerEntry(CLAWAI_PROVIDER), [])).toEqual([
      CLAWBOX_AI_FLASH_MODEL_ID,
      CLAWBOX_AI_PRO_MODEL_ID,
    ]);
  });

  it("tries again after a write that failed", async () => {
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "set") return { code: 1, stdout: "", stderr: "config is locked" };
      return { code: 0, stdout: `${JSON.stringify(LINKED)}\n`, stderr: "" };
    });
    await reconcileClawaiModelsWithHermes();
    const firstAttempt = cliMock.mock.calls.filter((c) => (c[0] as string[])[1] === "set").length;

    vi.advanceTimersByTime(60_001);
    await reconcileClawaiModelsWithHermes();
    // A failed repair is not a repair: a later request must try it again.
    expect(cliMock.mock.calls.filter((c) => (c[0] as string[])[1] === "set").length)
      .toBeGreaterThan(firstAttempt);
  });

  it("does not re-ask on every request while the CLI keeps failing", async () => {
    // The retry above is what stops an update from skipping the repair; this is
    // what stops it becoming a Python start per request. `GET
    // /setup-api/hermes/models` awaits this before it serves anything and each
    // read carries a 15 s timeout, so on a box whose `hermes` is wedged an
    // unbounded retry would be added to every chat-header and Settings load.
    cliMock.mockResolvedValue({ code: 127, stdout: "", stderr: "" });
    await reconcileClawaiModelsWithHermes();
    const afterFirst = cliMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    vi.advanceTimersByTime(30_000);
    await reconcileClawaiModelsWithHermes();
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.length).toBe(afterFirst);

    vi.advanceTimersByTime(30_001);
    await reconcileClawaiModelsWithHermes();
    expect(cliMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("says why it walked away, on every path that is not an ordinary box", async () => {
    // A silent `return` on the path the field actually reaches is how a box
    // ends up wrong with nothing in its journal. The two ordinary verdicts —
    // already declared, never linked — stay quiet, because every box on the
    // fleet would otherwise print one a boot.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      cliMock.mockResolvedValue({ code: 127, stdout: "", stderr: "" });
      await reconcileClawaiModelsWithHermes();
      expect(warn).toHaveBeenCalled();

      vi.advanceTimersByTime(60_001);
      _resetClawaiModelsReconcileForTests();
      log.mockClear();
      providerBlock({ ...LINKED, discover_models: false, models: { a: {} } });
      await reconcileClawaiModelsWithHermes();
      expect(log).toHaveBeenCalled();

      _resetClawaiModelsReconcileForTests();
      log.mockClear();
      warn.mockClear();
      providerBlock({ ...LINKED, models: [CLAWBOX_AI_FLASH_MODEL_ID] });
      await reconcileClawaiModelsWithHermes();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("never puts the provider block it just read into the journal", async () => {
    // That block carries `api_key`. Every branch reports an exit code and our
    // own words, never the stream — this repo is public and its logs are read
    // over screen shares.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      providerBlock(null, { code: 1, stderr: `unreadable: ${JSON.stringify(LINKED)}` });
      await reconcileClawaiModelsWithHermes();
      const printed = [warn, log, error]
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((arg) => String(arg))
        .join(" ");
      expect(printed).not.toContain(LINKED.api_key);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });
});
