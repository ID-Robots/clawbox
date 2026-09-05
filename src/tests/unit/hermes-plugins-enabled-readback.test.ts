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
const resolveVisionMock = vi.hoisted(() => vi.fn());

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
// The vision probe reaches the proxy over the network and waits seconds for it.
// Nothing in this file is about vision; stubbing it keeps the suite hermetic.
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  resolveVisionModelId: resolveVisionMock,
}));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: installMock,
}));

import { CLAWBOX_AI_VISION_MODEL_ID } from "@/lib/clawbox-ai-models";
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

/** Every `config unset`, by key. */
function unsets(): string[] {
  return cliMock.mock.calls
    .map((c) => c[0] as string[])
    .filter((a) => a[1] === "unset")
    .map((a) => a[2]);
}

/** The CLI's own warning when a JSON literal did not coerce to a structure. */
const STORING_AS_STRING =
  "Warning: value for 'plugins.enabled' looks like a list/mapping but parsed as str; storing as string.";

interface Reply { code: number; stdout: string; stderr: string }

/**
 * What `hermes plugins list --json` prints, derived the way Hermes derives it.
 *
 * `_plugin_status` reads `_get_enabled_set()`, which is
 * `set(enabled) if isinstance(enabled, list) else set()`
 * (hermes_cli/plugins_cmd.py:1309-1324, read on the pinned 0.20.5 build) — so
 * a value that is not a LIST reports "not enabled" however it is spelled, and
 * that is the whole reason this listing is the proof rather than a type check
 * of our own.
 */
function pluginsListing(stored: unknown): Reply {
  const enabled = Array.isArray(stored) && stored.includes(HERMES_IMAGE_PLUGIN_NAME);
  return {
    code: 0,
    stdout: JSON.stringify([
      {
        name: HERMES_IMAGE_PLUGIN_NAME,
        status: enabled ? "enabled" : "not enabled",
        version: "1.0.0",
        description: "ClawBox AI image generation backend.",
        source: "user",
      },
    ]),
    stderr: "",
  };
}

/**
 * Is this argv the plugin listing — asked MACHINE-READABLY?
 *
 * `--json` is asserted rather than ignored: without it the real CLI prints a
 * rich table, which `hermesReportsPluginEnabled` reads as `cannot-ask`. A stub
 * that answered JSON to both would keep every test in this file green while the
 * flag was dropped from the call.
 */
function isPluginsListing(args: string[]): boolean {
  return args[0] === "plugins" && args[1] === "list" && args.includes("--json");
}

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
  // STATEFUL: a `config set` changes what the next `config get` answers, unless
  // the case says the write fails. Without that the read-back compares the
  // written names against the PRE-write value and every success path really
  // exercises the mismatch branch — the tests would pass for the wrong reason.
  let stored = opts.value;
  cliMock.mockImplementation(async (args: string[]) => {
    if (isPluginsListing(args)) return pluginsListing(stored);
    // No deny-list on this box, reported the way the CLI reports an unset key.
    // Not an exit-0 silence: that is "the command said nothing", which no
    // reader here may take for "nothing is denied".
    if (args[1] === "get" && args[2] === "plugins.disabled") {
      return { code: 1, stdout: "", stderr: "Config key not set: plugins.disabled" };
    }
    if (args[1] === "get" && args[2] === "plugins.enabled") {
      if (stored === undefined) {
        return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
      }
      return args.includes("--json")
        ? { code: 0, stdout: JSON.stringify(stored), stderr: "" }
        : { code: 0, stdout: renderPlain(stored), stderr: "" };
    }
    if (args[1] === "set" && args[2] === "plugins.enabled") {
      const reply = opts.onSet ?? { code: 0, stdout: "", stderr: "" };
      // A write the case made fail leaves the old value; the CLI's own
      // "storing as string" is a write that landed AS TEXT.
      if (reply.code === 0) {
        stored = /storing as string/i.test(reply.stderr) ? args[3] : JSON.parse(args[3]);
      }
      return reply;
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
  // The resolver's own shape (`id`, not `model`), so the vision write below it
  // is issued with a real id rather than `undefined`: a stub whose field name
  // is wrong makes every case in this file exercise a path the file is not
  // about. Same value the vision suite stubs with.
  resolveVisionMock.mockResolvedValue({
    id: CLAWBOX_AI_VISION_MODEL_ID,
    verified: true,
    reason: "proxy-allows",
  });
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
      const residue = `["${HERMES_IMAGE_PLUGIN_NAME}"]`;
      // A STRING, so `_get_enabled_set` answers empty and Hermes reports the
      // plugin as not enabled — however that string is spelled.
      if (isPluginsListing(args)) return pluginsListing(written ? residue : undefined);
      if (args[1] === "set" && args[2] === "plugins.enabled") {
        written = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        if (!written) return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
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
    // Nothing to report: assert on the recorded arguments, not on a matcher
    // pair that could never line up with a one-argument console.warn.
    expect(warn.mock.calls.flat().join(" ")).not.toContain("plugins.enabled");
  });

  it("says what it discarded when a residue names no plugin, and says it once", async () => {
    // The one place "merged, never replaced" gives way. It is announced at the
    // moment of the decision — not from inside the decoder, which also runs as
    // the prover, where nothing is replaced and the same line would report an
    // overwrite that never happened.
    box({ value: 7 });

    await applyClawaiToHermes("claw_token_abc", "flash");

    const journal = warn.mock.calls.flat().join("\n");
    expect(journal).toContain("names no plugin");
    expect(journal.match(/names no plugin/g)).toHaveLength(1);
  });

  it("keeps the customer's plugins when it adds itself", async () => {
    box({ value: ["weather", "spotify"] });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(sets()).toContain(
      `plugins.enabled=${JSON.stringify(["weather", "spotify", HERMES_IMAGE_PLUGIN_NAME])}`,
    );
  });
});

describe("a box that was linked before the guard existed", () => {
  it("withdraws the claim it can draw, rather than leaving the old one standing", async () => {
    // Every box that CAN be in the residue state has been linked once already,
    // so `image_gen.provider` is on disk naming us — and that one key is what
    // `hermesAgentDrawsImages` reads. Declining to re-write it would leave the
    // composer button and the capability both saying yes over a plugin Hermes
    // does not load: the same false success, one link later.
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "set" && args[2] === "plugins.enabled") {
        return { code: 0, stdout: "", stderr: STORING_AS_STRING };
      }
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
      }
      if (args[1] === "get" && args[2] === "image_gen.provider") {
        return { code: 0, stdout: `${HERMES_IMAGE_PLUGIN_NAME}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(unsets()).toContain("image_gen.provider");
  });

  it("leaves a backend the customer chose by hand alone", async () => {
    // The "known and accepted false positive" is their choice, not ours.
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "set" && args[2] === "plugins.enabled") {
        return { code: 0, stdout: "", stderr: STORING_AS_STRING };
      }
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
      }
      if (args[1] === "get" && args[2] === "image_gen.provider") {
        return { code: 0, stdout: "fal\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(unsets()).not.toContain("image_gen.provider");
  });
});

describe("a hermes whose config get does not take --json", () => {
  it("keeps drawing, merging from the plain rendering instead of refusing", async () => {
    // `--json` is only what lets the TYPE be proved. A build that cannot answer
    // that question has said nothing about whether the value is residue, so
    // withdrawing the feature would be a false failure — these boxes draw today.
    cliMock.mockImplementation(async (args: string[]) => {
      // A build old enough to lack `--json` on `config get` lacks it on
      // `plugins list` too, so NEITHER question can be put here.
      if (isPluginsListing(args)) {
        return { code: 2, stdout: "", stderr: "usage: hermes plugins list\nunrecognized arguments: --json" };
      }
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return args.includes("--json")
          ? { code: 2, stdout: "", stderr: "usage: hermes config get\nunrecognized arguments: --json" }
          : { code: 0, stdout: "- weather\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(sets()).toContain(
      `plugins.enabled=${JSON.stringify(["weather", HERMES_IMAGE_PLUGIN_NAME])}`,
    );
    expect(claimedItCanDraw()).toBe(true);
    expect(unsets()).not.toContain("image_gen.provider");
  });
});

describe("the proof does not accept the ambiguous rendering", () => {
  it("refuses a `--json` answer that is not JSON, even though it spells the right list", async () => {
    // A build that takes `--json` but does not honour it in the formatter, or
    // anything that re-renders on the way out. `- clawai` through a lenient
    // text parse would have looked like a list already holding us and left the
    // residue in place.
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return args.includes("--json")
          ? { code: 0, stdout: `- ${HERMES_IMAGE_PLUGIN_NAME}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
  });

  it("makes no claim when the CLI never answered, and leaves the old one standing", async () => {
    // 127 is the shell's code for the `hermes` shim while the venv under it is
    // being rebuilt: nothing was parsed, and the write above still exited 0.
    // NOTHING WAS ESTABLISHED, so nothing is withdrawn either: unsetting
    // `image_gen.provider` here would take drawing away from a box that has it,
    // and no code path on the device puts it back — this function has no
    // periodic caller and is the only writer of that key.
    cliMock.mockImplementation(async (args: string[]) => {
      if (isPluginsListing(args)) return { code: 127, stdout: "", stderr: "hermes: command not found" };
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
      }
      if (args[1] === "get" && args[2] === "image_gen.provider") {
        return { code: 0, stdout: `${HERMES_IMAGE_PLUGIN_NAME}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await applyClawaiToHermes("claw_token_abc", "flash");

    expect(result.provider).toBe("clawai"); // the link itself still succeeds
    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).not.toContain("image_gen.provider");
  });

  it("makes no claim on a shape it cannot read, and leaves the old one standing", async () => {
    // Stdout that is not JSON from a read that exited 0 says the RENDERING was
    // not machine-readable — a build that takes `--json` without honouring it,
    // a wrapper that re-renders, a deprecation line ahead of the value. It says
    // nothing about the stored type, so it is not a licence to make the claim
    // and not grounds to take an existing one away.
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return { code: 0, stdout: "not json and not a list", stderr: "" };
      }
      if (args[1] === "get" && args[2] === "image_gen.provider") {
        return { code: 0, stdout: `${HERMES_IMAGE_PLUGIN_NAME}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(wrotePluginsEnabled()).toBe(false); // left alone, not replaced
    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).not.toContain("image_gen.provider");
  });
});

describe("the plain fallback is for one answer only", () => {
  it("does not downgrade to the ambiguous rendering on a transient typed-read failure", async () => {
    // A held config lock is not "this build has no --json". Falling back there
    // would read the residue `["clawai"]` out of the plain rendering as a real
    // list, conclude there is nothing to do, and go on to claim the box can
    // draw — the exact defect this file exists to remove.
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return args.includes("--json")
          ? { code: 1, stdout: "", stderr: "could not acquire config lock" }
          : { code: 0, stdout: `["${HERMES_IMAGE_PLUGIN_NAME}"]`, stderr: "" };
      }
      if (args[1] === "get" && args[2] === "image_gen.provider") {
        return { code: 0, stdout: `${HERMES_IMAGE_PLUGIN_NAME}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).not.toContain("image_gen.provider");
  });
});

describe("a failure that establishes nothing takes nothing away", () => {
  /**
   * The other half of the withdrawal rule, and the one that decides what a
   * WORKING box does on a bad day.
   *
   * `enableHermesImageGeneration` runs on every AI-Models save and every
   * re-link, it is the only writer of `image_gen.provider`, and nothing on the
   * device re-runs it on its own. So a withdrawal made on a failure that
   * proved nothing is not a moment of caution — it is image generation gone
   * from a customer's box until they happen to open Settings and save again.
   * Only an ANSWER that establishes the plugin cannot load may withdraw the
   * claim: the CLI's own "storing as string", or a strict read-back that is
   * not the list that was just written.
   */
  function boxThatDraws(reply: (args: string[]) => Promise<Reply>): void {
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === "image_gen.provider") {
        return { code: 0, stdout: `${HERMES_IMAGE_PLUGIN_NAME}\n`, stderr: "" };
      }
      return reply(args);
    });
  }

  it("keeps drawing when the typed read cannot be run at all", async () => {
    // `runHermesCli` REJECTS for a missing binary, a timeout and its own
    // SIGKILL. A 15 s timeout on one `config get` is not evidence about
    // anything on disk.
    boxThatDraws(async (args) => {
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        throw new Error("hermes config get plugins.enabled --json timed out after 15000ms");
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await applyClawaiToHermes("claw_token_abc", "flash");

    expect(result.provider).toBe("clawai"); // the link itself still succeeds
    expect(unsets()).not.toContain("image_gen.provider");
  });

  it("keeps drawing when the config lock is held", async () => {
    // The scenario the fleet actually meets: a second `hermes` holding the
    // config lock while the owner saves Settings → AI Models.
    boxThatDraws(async (args) => {
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return { code: 1, stdout: "", stderr: "could not acquire config lock" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(unsets()).not.toContain("image_gen.provider");
  });

  it("keeps drawing when the write itself could not be made", async () => {
    // The read answered and the list needs us added; the WRITE is what failed.
    // The box is no worse off than before the save, and what it holds now is
    // what it held then.
    boxThatDraws(async (args) => {
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return args.includes("--json")
          ? { code: 0, stdout: JSON.stringify(["weather"]), stderr: "" }
          : { code: 0, stdout: "- weather\n", stderr: "" };
      }
      if (args[1] === "set" && args[2] === "plugins.enabled") {
        return { code: 1, stdout: "", stderr: "could not acquire config lock" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).not.toContain("image_gen.provider");
  });

  it("keeps drawing when hermes' own listing says nothing at all", async () => {
    // Exit 0 and an empty stdout from `plugins list --json`. A command that
    // printed nothing has not reported that a plugin is absent, and reading it
    // as one would take a working box's claim away over silence.
    boxThatDraws(async (args) => {
      if (isPluginsListing(args)) return { code: 0, stdout: "", stderr: "" };
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).not.toContain("image_gen.provider");
  });

  /**
   * A box whose `plugins.enabled` holds `stored` and whose `plugins.disabled`
   * names our plugin, so Hermes' own listing reports it `disabled`.
   *
   * `plugins.disabled` is a deny-list that WINS over `plugins.enabled`
   * (`_plugin_status`, hermes_cli/plugins_cmd.py:1930-1936), so every type check
   * ClawBox could make on the allow-list says "loadable" and Hermes still loads
   * nothing. That is why the proof is Hermes' own answer rather than our reading
   * of a key — and why it has to be asked on BOTH paths below.
   */
  function boxWithUsDenied(stored: string[]): void {
    boxThatDraws(async (args) => {
      if (isPluginsListing(args)) {
        return {
          code: 0,
          stdout: JSON.stringify([
            { name: HERMES_IMAGE_PLUGIN_NAME, status: "disabled", version: "1.0.0", description: "", source: "user" },
          ]),
          stderr: "",
        };
      }
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return args.includes("--json")
          ? { code: 0, stdout: JSON.stringify(stored), stderr: "" }
          : { code: 0, stdout: stored.map((v) => `- ${v}`).join("\n") + "\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
  }

  it("believes hermes over the list when the plugin is explicitly disabled", async () => {
    // The allow-list does not name us yet, so a WRITE is needed and the listing
    // is consulted on the way out of it.
    boxWithUsDenied(["weather"]);

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).toContain("image_gen.provider");
  });

  it("believes hermes over the list on a box that needs no write at all", async () => {
    // THE FIELD STATE, and the one this whole round exists for: a healthy
    // linked box already names us in a real list, so `mergePluginsEnabled`
    // answers null and there is nothing to write. That must not be read as
    // "loadable" — nothing has been asked yet. The deny-list is the case where
    // the difference is visible: with no write there is no `writePluginsEnabled`
    // to consult the listing, and the claim would be made over a plugin Hermes
    // refuses to load, which is TASK-701's exact symptom.
    boxWithUsDenied([HERMES_IMAGE_PLUGIN_NAME, "clawbox_email_directives"]);

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(wrotePluginsEnabled(), "the list already names us: nothing to write").toBe(false);
    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).toContain("image_gen.provider");
  });

  it("does not rewrite image_gen.model when it makes no claim", async () => {
    // `image_gen.model` is the GLOBAL key, read by whichever backend is
    // SELECTED; our own plugin reads `image_gen.clawai.model`. Written with the
    // describing keys it was replaced on every AI-Models save — including here,
    // where the listing answered nothing, no claim is made and the box keeps
    // whatever provider it had. A customer on another backend lost their model
    // to a link that concluded it could not turn ours on. It belongs with
    // `image_gen.provider`: ours to name only when we become the backend.
    boxThatDraws(async (args) => {
      if (isPluginsListing(args)) return { code: 0, stdout: "", stderr: "" };
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return { code: 0, stdout: JSON.stringify([HERMES_IMAGE_PLUGIN_NAME]), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).not.toContain("image_gen.provider");
    expect(sets().some((v) => v.startsWith("image_gen.model="))).toBe(false);
    // Our OWN backend is still described — that is ours either way, and it is
    // what a re-link exists to repair when the proxy address moves.
    expect(sets().some((v) => v.startsWith(`image_gen.${HERMES_IMAGE_PLUGIN_NAME}.base_url=`))).toBe(true);
  });

  it("writes image_gen.model when it does claim the backend", async () => {
    // The counterweight: once we ARE the provider that key is ours to name, and
    // a provider set without its model would point at whatever came before.
    box({ value: [HERMES_IMAGE_PLUGIN_NAME] });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(true);
    expect(sets().some((s) => s.startsWith("image_gen.model="))).toBe(true);
  });

  it("asks hermes on the no-write path even when the answer is yes", async () => {
    // The counterweight: the same no-write path on a box where the plugin IS
    // enabled must still reach `image_gen.provider`. A guard that answered
    // "unproved" for every healthy box would take image generation away from
    // the whole fleet.
    boxThatDraws(async (args) => {
      if (isPluginsListing(args)) return pluginsListing([HERMES_IMAGE_PLUGIN_NAME]);
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return args.includes("--json")
          ? { code: 0, stdout: JSON.stringify([HERMES_IMAGE_PLUGIN_NAME]), stderr: "" }
          : { code: 0, stdout: `- ${HERMES_IMAGE_PLUGIN_NAME}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(wrotePluginsEnabled()).toBe(false);
    expect(claimedItCanDraw()).toBe(true);
    expect(unsets()).not.toContain("image_gen.provider");
  });

  it("keeps drawing on the no-write path when hermes cannot be asked", async () => {
    // 127: the `hermes` shim while `step_hermes_install` rebuilds the venv under
    // it. Nothing was established, so the claim standing on disk is neither
    // re-made nor taken away — the same rule the write path follows.
    boxThatDraws(async (args) => {
      if (isPluginsListing(args)) {
        return { code: 127, stdout: "", stderr: "hermes: command not found" };
      }
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return args.includes("--json")
          ? { code: 0, stdout: JSON.stringify([HERMES_IMAGE_PLUGIN_NAME]), stderr: "" }
          : { code: 0, stdout: `- ${HERMES_IMAGE_PLUGIN_NAME}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).not.toContain("image_gen.provider");
  });

  it("does not overwrite the customer's plugins over a silent plain read", async () => {
    // The `--json`-less build, where nothing can prove the type and the write
    // is therefore made unproved: a `config get` that exits 0 and prints
    // NOTHING must not be read as an empty list, or the merge writes
    // `["clawai"]` over whatever the key holds and unloads every plugin the
    // customer installed.
    boxThatDraws(async (args) => {
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return args.includes("--json")
          ? { code: 2, stdout: "", stderr: "Error: no such option: --json" }
          : { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(wrotePluginsEnabled()).toBe(false);
    expect(unsets()).not.toContain("image_gen.provider");
  });

  it("still links a FIRST box whose hermes has no `plugins list --json`", async () => {
    // A build that answers `config get --json` but not `plugins list --json`.
    // The key is UNSET — a genuine first link — so a write happens and the
    // prover runs; without a fallback the listing answers nothing, the write
    // path returns `!typed` = false, and the box silently never gains image
    // generation, where beta gave it unconditionally.
    //
    // The proof it CAN still give is the typed read-back of the two keys
    // Hermes gates on. `box()` is stateful, so after the write those answer
    // the list just written and an unset deny-list.
    box({ value: undefined });
    const stored = cliMock.getMockImplementation()!;
    cliMock.mockImplementation(async (args: string[]) => {
      if (isPluginsListing(args)) {
        return { code: 2, stdout: "", stderr: "Error: no such option: --json" };
      }
      return stored(args);
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(wrotePluginsEnabled(), "an unset key must be written").toBe(true);
    expect(claimedItCanDraw()).toBe(true);
    expect(unsets()).not.toContain("image_gen.provider");
  });

  it("does not arm a build with no listing when the write landed as TEXT", async () => {
    // The other half of the same exemption, and the reason it cannot be an
    // unconditional yes: this build can still be asked the typed questions, and
    // a `plugins.enabled` that reads back as a STRING is Hermes loading no user
    // plugin at all.
    //
    // The write lands as text SILENTLY — exit 0, clean stderr, the older CLI
    // with no coercion warning — so `hermesStoredValueAsText` sees nothing and
    // the typed read-back is the only witness left. Arming on the exit code
    // here is TASK-701's own symptom, re-opened for one build class.
    let written = false;
    boxThatDraws(async (args) => {
      const residue = `["${HERMES_IMAGE_PLUGIN_NAME}"]`;
      if (isPluginsListing(args)) {
        return { code: 2, stdout: "", stderr: "Error: no such option: --json" };
      }
      if (args[1] === "set" && args[2] === "plugins.enabled") {
        written = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        if (!written) return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
        // A STRING that spells a list: `_get_enabled_set` reads it as empty.
        return { code: 0, stdout: JSON.stringify(residue), stderr: "" };
      }
      if (args[1] === "get" && args[2] === "plugins.disabled") {
        return { code: 1, stdout: "", stderr: "Config key not set: plugins.disabled" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
    // The residue is an ANSWER, so the stale claim goes too.
    expect(unsets()).toContain("image_gen.provider");
  });

  it("does not arm a build with no listing while plugins.disabled names us", async () => {
    // `plugins.disabled` is the deny-list the listing would have caught. On a
    // build that cannot be asked for the listing it is read directly, in BOTH
    // spellings hermes writes — `hermes plugins disable clawai` stores the
    // resolved key `image_gen/clawai` (cmd_disable -> _resolve_plugin_key,
    // read on the pinned 0.20.5 build).
    for (const spelling of [HERMES_IMAGE_PLUGIN_NAME, `image_gen/${HERMES_IMAGE_PLUGIN_NAME}`]) {
      cliMock.mockReset();
      drawsMock.mockResolvedValueOnce(false).mockResolvedValue(true);
      boxThatDraws(async (args) => {
        if (isPluginsListing(args)) {
          return { code: 2, stdout: "", stderr: "Error: no such option: --json" };
        }
        if (args[1] === "get" && args[2] === "plugins.enabled") {
          return { code: 0, stdout: JSON.stringify([HERMES_IMAGE_PLUGIN_NAME]), stderr: "" };
        }
        if (args[1] === "get" && args[2] === "plugins.disabled") {
          return { code: 0, stdout: JSON.stringify([spelling]), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      await applyClawaiToHermes("claw_token_abc", "flash");

      expect(claimedItCanDraw(), `${spelling} must deny the claim`).toBe(false);
      expect(unsets(), `${spelling} must withdraw`).toContain("image_gen.provider");
    }
  });

  it("keeps drawing when plugins.disabled holds a residue hermes ignores", async () => {
    // The mirror of the case above, in the direction that costs a customer
    // their pictures. `_get_disabled_set()` gates on the SAME type as the
    // allow-list — `set(disabled) if isinstance(disabled, list) else set()`
    // (hermes_cli/plugins_cmd.py:1257-1269, read on the pinned 0.20.5 build) —
    // so a deny-list stored as a STRING denies nothing and Hermes loads the
    // plugin. Reading the names recovered out of that residue as a real denial
    // would withdraw `image_gen.provider` from a box that is drawing today, on
    // every Save, with nothing on the device to put it back: the false failure
    // this block forbids, arriving through a misread ANSWER rather than a
    // failed question.
    for (const residue of [`["${HERMES_IMAGE_PLUGIN_NAME}"]`, HERMES_IMAGE_PLUGIN_NAME]) {
      cliMock.mockReset();
      drawsMock.mockResolvedValueOnce(false).mockResolvedValue(true);
      boxThatDraws(async (args) => {
        if (isPluginsListing(args)) {
          return { code: 2, stdout: "", stderr: "Error: no such option: --json" };
        }
        if (args[1] === "get" && args[2] === "plugins.enabled") {
          return { code: 0, stdout: JSON.stringify([HERMES_IMAGE_PLUGIN_NAME]), stderr: "" };
        }
        if (args[1] === "get" && args[2] === "plugins.disabled") {
          // A `hermes config set plugins.disabled '["clawai"]'` whose coercion
          // missed, or `disabled: clawai` hand-edited into config.yaml.
          return { code: 0, stdout: JSON.stringify(residue), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      await applyClawaiToHermes("claw_token_abc", "flash");

      expect(unsets(), `${residue} must not withdraw`).not.toContain("image_gen.provider");
      expect(claimedItCanDraw(), `${residue} must keep the claim`).toBe(true);
    }
  });

  it("does not read an unfamiliar status as a NO", async () => {
    // `not-enabled` is the one verdict that takes a working box's claim away,
    // so it is a CLOSED list — `disabled`, `not enabled`, `not-enabled`, what
    // `_plugin_status` can return on the pinned 0.20.5 build
    // (hermes_cli/plugins_cmd.py:1931-1937). This file already argues that CLI
    // wording differs on builds moved off the pin by a hand-run `hermes
    // update`; that applies to a status string as much as to argparse's errors.
    // A wrong "cannot ask" hides nothing. A wrong "no" unsets image generation
    // on a box where Hermes was loading the plugin all along, on every Save,
    // with nothing on the device to put it back.
    for (const status of ["enabled (user)", "active", "", undefined]) {
      cliMock.mockReset();
      drawsMock.mockResolvedValueOnce(false).mockResolvedValue(true);
      boxThatDraws(async (args) => {
        if (isPluginsListing(args)) {
          return {
            code: 0,
            stdout: JSON.stringify([
              { name: HERMES_IMAGE_PLUGIN_NAME, status, version: "1.0.0", description: "", source: "user" },
            ]),
            stderr: "",
          };
        }
        if (args[1] === "get" && args[2] === "plugins.enabled") {
          return { code: 0, stdout: JSON.stringify([HERMES_IMAGE_PLUGIN_NAME]), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });

      await applyClawaiToHermes("claw_token_abc", "flash");

      expect(unsets(), `status ${JSON.stringify(status)} must not withdraw`)
        .not.toContain("image_gen.provider");
    }
  });

  it("still withdraws on the one answer that establishes the plugin cannot load", async () => {
    // The counterweight, kept in the same block as the cases above so the rule
    // reads as one: a read-back that ANSWERED and did not spell the list is
    // proof, and proof still takes the claim away.
    let written = false;
    boxThatDraws(async (args) => {
      // The write landed AS TEXT with a clean stderr — an older CLI stores the
      // literal silently — so Hermes' own listing is the only witness, and it
      // reports the plugin not enabled because a string is not a list.
      if (isPluginsListing(args)) {
        return pluginsListing(written ? `["${HERMES_IMAGE_PLUGIN_NAME}"]` : undefined);
      }
      if (args[1] === "set" && args[2] === "plugins.enabled") {
        written = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "get" && args[2] === "plugins.enabled") {
        return { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    await applyClawaiToHermes("claw_token_abc", "flash");

    expect(claimedItCanDraw()).toBe(false);
    expect(unsets()).toContain("image_gen.provider");
  });
});
