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
  it("adds ours to a list the customer already has", () => {
    // The list gates EVERY user plugin on the box, so replacing it would
    // unload whatever else is installed — a feature landing by breaking one.
    expect(mergePluginsEnabled("- weather\n- spotify\n")).toEqual([
      "weather",
      "spotify",
      HERMES_IMAGE_PLUGIN_NAME,
    ]);
  });

  it("reads the flow spelling of the same list", () => {
    expect(mergePluginsEnabled("['weather', \"spotify\"]")).toEqual([
      "weather",
      "spotify",
      HERMES_IMAGE_PLUGIN_NAME,
    ]);
  });

  it("starts a list when the key has never been set", () => {
    // What the CLI prints for an unset key, verbatim.
    expect(mergePluginsEnabled("Config key not set: plugins.enabled")).toEqual([
      HERMES_IMAGE_PLUGIN_NAME,
    ]);
    expect(mergePluginsEnabled("")).toEqual([HERMES_IMAGE_PLUGIN_NAME]);
  });

  it("writes nothing when ours is already listed", () => {
    // Null, not the same list again: `hermes config set` rewrites config.yaml,
    // and that invalidates the mtime-keyed memo every chat open reads through.
    expect(mergePluginsEnabled("- clawai\n")).toBeNull();
  });
});
