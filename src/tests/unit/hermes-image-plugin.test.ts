import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveEnv } from "@/tests/helpers/env";
import fs from "fs";
import os from "os";
import path from "path";

import {
  HERMES_IMAGE_PLUGIN_NAME,
  hermesImagePluginDir,
  hermesImagePluginInstalled,
  installHermesImagePlugin,
  mergePluginsEnabled,
  decodePluginsEnabledJson,
  decodePluginsEnabledPlain,
} from "@/lib/hermes-image-plugin";

/**
 * The image backend ClawBox installs into the Hermes agent.
 *
 * Two things are worth a test here and they are quite different from each
 * other: WHERE the files land (Hermes only looks in one directory, and a
 * plugin one directory off is a feature that silently does not exist), and
 * whether enabling ours leaves everybody else's alone.
 */

let restoreEnv: () => void = () => {};
let home: string;

describe("installing the ClawBox AI image backend", () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-imgplugin-"));
    restoreEnv = saveEnv("HOME", "HERMES_HOME", "CLAWBOX_ROOT");
    process.env.HOME = home;
    process.env.HERMES_HOME = path.join(home, ".hermes");
    // The repo's own checkout is the source, exactly as it is on the box.
    process.env.CLAWBOX_ROOT = process.cwd();
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("puts the manifest and the entry point where Hermes discovers plugins", async () => {
    // `~/.hermes/plugins/<kind>/<name>/` with a `plugin.yaml` AND an
    // `__init__.py` exposing `register(ctx)` — hermes_cli/plugins.py:19. Either
    // file missing and the directory is skipped without an error anyone sees.
    expect(await hermesImagePluginInstalled()).toBe(false);
    await installHermesImagePlugin();

    const dir = hermesImagePluginDir();
    expect(dir).toBe(
      path.join(home, ".hermes", "plugins", "image_gen", HERMES_IMAGE_PLUGIN_NAME),
    );
    expect(fs.existsSync(path.join(dir, "plugin.yaml"))).toBe(true);
    const source = fs.readFileSync(path.join(dir, "__init__.py"), "utf-8");
    expect(source).toContain("def register(ctx)");
    expect(source).toContain("register_image_gen_provider");
    expect(await hermesImagePluginInstalled()).toBe(true);
  });

  it("ships the model every plan is entitled to, not the Max-only one", async () => {
    // `gpt-image-2` is `["max"]` on the proxy's own `modelTiers`; naming it
    // would turn a Free box's first drawing request into a model-gate refusal.
    await installHermesImagePlugin();
    const source = fs.readFileSync(
      path.join(hermesImagePluginDir(), "__init__.py"),
      "utf-8",
    );
    expect(source).toContain('DEFAULT_MODEL = "gpt-image-1-mini"');
  });

  it("reads its credential from a name nothing else in Hermes consults", async () => {
    // The alternative — writing the device token as OPENAI_API_KEY — puts a
    // ClawBox credential under the name every OpenAI-flavoured code path in the
    // agent reads, one upstream change away from posting it to api.openai.com.
    await installHermesImagePlugin();
    const source = fs.readFileSync(
      path.join(hermesImagePluginDir(), "__init__.py"),
      "utf-8",
    );
    expect(source).toContain('TOKEN_ENV = "CLAWBOX_AI_TOKEN"');
    expect(source).not.toContain("OPENAI_API_KEY");
  });

  it("overwrites an older copy rather than leaving a stale one in place", async () => {
    await installHermesImagePlugin();
    const entry = path.join(hermesImagePluginDir(), "__init__.py");
    fs.writeFileSync(entry, "# an older release\n");
    await installHermesImagePlugin();
    expect(fs.readFileSync(entry, "utf-8")).toContain("def register(ctx)");
  });
});

describe("plugins.enabled", () => {
  /** What `hermes config get plugins.enabled --json` prints for a stored value. */
  const asJson = (value: unknown) => decodePluginsEnabledJson(JSON.stringify(value));

  it("adds ours to a list the customer already has", () => {
    // The list gates EVERY user plugin on the box, so replacing it would
    // unload whatever else is installed — a feature landing by breaking one.
    expect(mergePluginsEnabled(asJson(["weather", "spotify"]))).toEqual([
      "weather",
      "spotify",
      HERMES_IMAGE_PLUGIN_NAME,
    ]);
  });

  it("reads the YAML spellings too, for a plain `config get`", () => {
    // Block and flow, both observed on the live box. Kept because a CLI old
    // enough to reject `--json` still has to be understood.
    for (const rendering of ["- weather\n- spotify\n", "['weather', \"spotify\"]"]) {
      expect(mergePluginsEnabled(decodePluginsEnabledPlain(rendering))).toEqual([
        "weather",
        "spotify",
        HERMES_IMAGE_PLUGIN_NAME,
      ]);
    }
  });

  it("starts a list when the key has never been set", () => {
    // What the CLI prints for an unset key, verbatim. THAT is an empty list:
    // the CLI said what it holds, and it holds nothing.
    expect(mergePluginsEnabled(decodePluginsEnabledJson("Config key not set: plugins.enabled"))).toEqual([
      HERMES_IMAGE_PLUGIN_NAME,
    ]);
  });

  it("does not read an exit-0 SILENCE as an empty list", () => {
    // A command that printed NOTHING has not said the key is empty, and this
    // decoder is the one that decides whether the value gets REPLACED: read as
    // `[]` the merge answers `["clawai"]`, which is then written over whatever
    // the key really held — silently unloading every plugin the customer
    // installed, the exact outcome `enableHermesImageGeneration` says it must
    // never cause. "Could not ask" is the only honest reading of silence, and
    // an `unreadable` is left strictly alone.
    expect(decodePluginsEnabledJson("").kind).toBe("unreadable");
    expect(decodePluginsEnabledJson("   \n").kind).toBe("unreadable");
    expect(mergePluginsEnabled(decodePluginsEnabledJson(""))).toBeNull();
  });

  it("writes nothing when ours is already listed", () => {
    // Null, not the same list again: `hermes config set` rewrites config.yaml,
    // and that invalidates the mtime-keyed memo every chat open reads through.
    expect(mergePluginsEnabled(asJson([HERMES_IMAGE_PLUGIN_NAME]))).toBeNull();
  });

  it("treats a value that is not a list as something to repair", () => {
    // The residue of a `config set` whose coercion missed: our own literal,
    // stored as TEXT. `_get_enabled_set` reads a non-list as EMPTY, so this box
    // is loading no plugin at all — and through the plain rendering it looked
    // like a list that already contained us, which is why it never healed.
    const residue = asJson(`["weather", "${HERMES_IMAGE_PLUGIN_NAME}"]`);
    expect(residue.kind).toBe("residue");
    // The names inside it are still recoverable, so the repair keeps them.
    expect(mergePluginsEnabled(residue)).toEqual(["weather", HERMES_IMAGE_PLUGIN_NAME]);
  });

  it("recovers a customer's names out of a residue it did not write", () => {
    // A hand-edited mapping is a plausible YAML mistake and its KEYS are good
    // plugin names; a bare scalar is one name. Both were loading nothing, and
    // replacing them with `["clawai"]` would have destroyed the only record of
    // what the owner had enabled.
    expect(mergePluginsEnabled(asJson({ weather: true, spotify: true }))).toEqual([
      "weather",
      "spotify",
      HERMES_IMAGE_PLUGIN_NAME,
    ]);
    expect(mergePluginsEnabled(asJson("weather"))).toEqual(["weather", HERMES_IMAGE_PLUGIN_NAME]);
  });

  it("keeps a mapping's OFF entries off when it repairs the type", () => {
    // `enabled: {clawai: true, weather: false}` is how a person writes a
    // switch table. Taking every key would list `weather` as a real list entry
    // and start loading, on the next boot, a plugin the owner had switched off
    // — enabling something as a side effect of repairing a type.
    expect(mergePluginsEnabled(asJson({ weather: false, spotify: true }))).toEqual([
      "spotify",
      HERMES_IMAGE_PLUGIN_NAME,
    ]);
    // Only when the mapping really is a switch table, though: mixed values are
    // not a decision about anything, so every key is still a name.
    expect(mergePluginsEnabled(asJson({ weather: null, spotify: true }))).toEqual([
      "weather",
      "spotify",
      HERMES_IMAGE_PLUGIN_NAME,
    ]);
  });

  it("leaves a shape it cannot read names out of alone", () => {
    // A JSON value that is not a list names no plugin, so there is nothing to
    // preserve: it is REPLACED, and the caller journals the old shape first.
    for (const stored of [7, null, true]) {
      expect(asJson(stored).kind, JSON.stringify(stored)).toBe("residue");
      expect(mergePluginsEnabled(asJson(stored))).toEqual([HERMES_IMAGE_PLUGIN_NAME]);
    }
    // Stdout that is not JSON is different: nothing was read, so nothing is
    // repaired and nothing is replaced — the same call
    // `scripts/register-mcp.sh` makes on a list it cannot parse.
    expect(decodePluginsEnabledJson("not json at all").kind).toBe("unreadable");
    expect(mergePluginsEnabled(decodePluginsEnabledJson("not json at all"))).toBeNull();
  });
});
