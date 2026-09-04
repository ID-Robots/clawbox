import fsp from "fs/promises";
import path from "path";
import { hermesHome } from "@/lib/hermes-env";

/**
 * Teaching the Hermes agent to draw, through this device's own subscription.
 *
 * SERVER ONLY.
 *
 * WHY A PLUGIN AND NOT A CONFIG LINE. Hermes' image generation is a tool the
 * AGENT reaches for (`image_generate`), serviced by whichever backend
 * `image_gen.provider` names, and every backend is a plugin. Upstream ships
 * seven of them (`plugins/image_gen/{deepinfra,fal,krea,openai,openai-codex,
 * openrouter,xai}` @ v0.20.5) and not one of them can be pointed at ClawBox AI
 * honestly:
 *
 *   - `openai` is the closest fit — it speaks the exact OpenAI images shape the
 *     ClawBox AI proxy serves — but it hardcodes `API_MODEL = "gpt-image-2"`
 *     (`plugins/image_gen/openai/__init__.py:57`), and the proxy serves that id
 *     to MAX PLANS ONLY. Verified against production from a linked box
 *     (2026-08-24): `GET /api/ai/images/generations` reports
 *     `modelTiers: {"gpt-image-1-mini":["free","pro","max"],
 *     "gpt-image-2":["max"]}`. So on a Free or Pro box that backend can only
 *     produce a model-gate rejection. It also takes its credential from
 *     `OPENAI_API_KEY` with a base URL from `OPENAI_BASE_URL`, i.e. it would
 *     mean writing the ClawBox device token under the name every
 *     OpenAI-flavoured code path in Hermes reads — one future upstream change
 *     away from posting the customer's ClawBox credential to api.openai.com.
 *   - `deepinfra` DOES take both its base URL and its model from config, so it
 *     could be aimed at the proxy with the right model id. It would then
 *     describe itself as "DeepInfra" in `hermes tools` and in every error the
 *     agent quotes. A working feature that lies about who is serving it is not
 *     the trade this repo makes.
 *
 * So ClawBox brings its own backend. It is ~200 lines of Python against
 * upstream's own documented extension point — user plugins in
 * `~/.hermes/plugins/<kind>/<name>/`, which OVERRIDE bundled ones by name
 * (`hermes_cli/plugins.py:5-18`) — and it lives OUTSIDE the `hermes-agent` git
 * checkout, so a nightly update replaces the agent without touching it.
 *
 * PROVEN ON THE LIVE BOX (2026-08-24, linked device, deepseek-v4-pro): one
 * `hermes chat -q "Draw a picture of a blue robot crab waving…"` turn produced
 * `~/.hermes/cache/images/clawai_20260824_212225_23c1c095.png`, 944,172 bytes,
 * 1024×1024, with `gpt-image-1-mini` — the id every plan is entitled to.
 */

/** The plugin's name, which is also its directory and its registry key. */
export const HERMES_IMAGE_PLUGIN_NAME = "clawai";

/** The two files that make a Hermes directory plugin: manifest and entry point. */
const PLUGIN_FILES = ["plugin.yaml", "__init__.py"] as const;

/**
 * The env var the plugin reads its credential from.
 *
 * A ClawBox-specific name ON PURPOSE. Nothing else in Hermes reads it, so the
 * device token cannot be picked up by a provider ladder and posted to a
 * third party — which is exactly what writing it as `OPENAI_API_KEY` would
 * risk. Written to `~/.hermes/.env` by `applyClawaiToHermes`.
 */
export const HERMES_IMAGE_TOKEN_ENV = "CLAWBOX_AI_TOKEN";

/**
 * Where the plugin's source lives in THIS checkout.
 *
 * `CLAWBOX_ROOT` first for the same reason `config-store` and `system-profile`
 * read it: the production server runs from the repo root, but a test (and a dev
 * server) may not.
 */
function pluginSourceDir(): string {
  const root = process.env.CLAWBOX_ROOT || process.cwd();
  return path.join(root, "scripts", "hermes-plugins", "image_gen", HERMES_IMAGE_PLUGIN_NAME);
}

/** Where Hermes looks for a user-installed image backend. */
export function hermesImagePluginDir(): string {
  return path.join(hermesHome(), "plugins", "image_gen", HERMES_IMAGE_PLUGIN_NAME);
}

/**
 * Copy the backend into `~/.hermes/plugins/image_gen/clawai/`.
 *
 * Overwrites unconditionally rather than skipping when present: the file is
 * OURS, it is versioned with the app, and an update that ships a fixed plugin
 * must actually deliver it. There is no user edit to preserve here — a customer
 * who wants a different backend selects one, they do not patch this directory.
 *
 * The `__pycache__` a previous version left behind is removed with it, because
 * Python will happily import a stale `.pyc` whose source no longer exists.
 */
export async function installHermesImagePlugin(): Promise<void> {
  const source = pluginSourceDir();
  const target = hermesImagePluginDir();
  await fsp.mkdir(target, { recursive: true, mode: 0o755 });
  for (const name of PLUGIN_FILES) {
    // Read-then-write rather than copyFile: the source is inside the app's own
    // checkout and the destination is the agent's tree, and this way the
    // destination mode is ours rather than inherited from whatever the git
    // checkout happened to have.
    const body = await fsp.readFile(path.join(source, name));
    await fsp.writeFile(path.join(target, name), body, { mode: 0o644 });
  }
  await fsp.rm(path.join(target, "__pycache__"), { recursive: true, force: true }).catch(() => {});
}

/** Is the backend on disk where Hermes will find it? */
export async function hermesImagePluginInstalled(): Promise<boolean> {
  try {
    await fsp.access(path.join(hermesImagePluginDir(), "__init__.py"));
    return true;
  } catch {
    return false;
  }
}

/** What `plugins.enabled` currently holds, as Hermes would read it. */
export interface PluginsEnabledState {
  /** The names Hermes will actually load. Empty unless the key holds a LIST. */
  names: string[];
  /**
   * The key holds something that is not a list — in practice the residue of a
   * `hermes config set` whose coercion failed and stored our own JSON literal
   * as text. `_get_enabled_set` (hermes_cli/plugins_cmd.py:1309-1324) answers
   * `set(enabled) if isinstance(enabled, list) else set()`, so on such a box NO
   * user plugin loads at all — the customer's included.
   */
  residue: boolean;
}

/**
 * Decode what `hermes config get plugins.enabled --json` printed.
 *
 * `--json` IS LOAD-BEARING, and it is the whole reason this function exists
 * rather than the YAML-text parser it replaced. In the plain rendering a stored
 * LIST and a stored STRING that spells one are the same characters, so the
 * residue above read back as a real one-element list, the merge answered
 * "already there, nothing to do", and a box that was loading no plugins at all
 * could never heal itself (TASK-701).
 *
 * The YAML fallback is kept for the plain rendering — a CLI old enough to
 * reject `--json`, and the block/flow shapes both observed on the live box.
 * It cannot tell the two apart, which is why the caller asks for `--json`.
 */
export function readPluginsEnabled(stdout: string): PluginsEnabledState {
  const text = (stdout || "").trim();
  if (!text || /^config key not set/i.test(text)) return { names: [], residue: false };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { names: parseYamlList(text), residue: false };
  }
  if (Array.isArray(value)) {
    return { names: value.filter((v): v is string => typeof v === "string"), residue: false };
  }
  // A STRING is the residue case. Its content is our own literal, so the names
  // in it are recoverable and the customer's plugins survive the repair — but
  // the key is still wrong, and `mergePluginsEnabled` must not read this as
  // "already correct".
  if (typeof value === "string") return { names: parseYamlList(value), residue: true };
  return { names: [], residue: true };
}

/**
 * The `plugins.enabled` list with our backend added, or null when there is
 * nothing to write.
 *
 * MERGED, NEVER REPLACED, and that is the whole reason this is a function with
 * a test rather than a literal in the caller. `plugins.enabled` is opt-in for
 * every user plugin on the box (`hermes_cli/plugins.py:4016` skips anything not
 * listed), so writing `["clawai"]` over a customer's list would silently
 * unload every other plugin they installed — a feature landing by breaking
 * someone else's.
 *
 * Null on "nothing to do" so the caller can skip the write entirely: `hermes
 * config set` rewrites config.yaml, which invalidates the mtime-keyed config
 * memo every chat open reads through. A `residue` state is never "nothing to
 * do", however complete its names look: the TYPE is what Hermes gates on.
 */
export function mergePluginsEnabled(state: PluginsEnabledState): string[] | null {
  const withOurs = state.names.includes(HERMES_IMAGE_PLUGIN_NAME)
    ? [...state.names]
    : [...state.names, HERMES_IMAGE_PLUGIN_NAME];
  if (state.residue) return withOurs;
  return state.names.includes(HERMES_IMAGE_PLUGIN_NAME) ? null : withOurs;
}

/**
 * The names out of a `hermes config get` list rendering.
 *
 * Two shapes, both observed on the live box: a block list (`- clawai` per line)
 * and a flow list (`['clawai']`). Anything else — including the CLI's
 * "Config key not set: plugins.enabled" — parses to nothing, which is the safe
 * answer: it means we add ours to an empty list, and a `set` that turns out to
 * be wrong is visible in the file rather than silently dropping names we could
 * not read.
 */
function parseYamlList(raw: string): string[] {
  const text = (raw || "").trim();
  if (!text || /^config key not set/i.test(text)) return [];
  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((entry) => unquote(entry.trim()))
      .filter(Boolean);
  }
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match) {
      const name = unquote(match[1]);
      if (name) names.push(name);
    }
  }
  return names;
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    if ((first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1).trim();
  }
  return text;
}
