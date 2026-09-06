import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Teaching a linked Hermes box to draw.
 *
 * The feature is not a button and not a route: it is four config writes and a
 * credential, after which the customer asks for a picture in words — in the
 * desktop chat, in WhatsApp, in Discord — and the agent reaches for its own
 * `image_generate` tool. So what is worth pinning here is exactly what those
 * writes say, because every one of them has a failure mode that only shows up
 * on a customer's box:
 *
 *   - the wrong MODEL is a model-gate refusal on every plan but Max;
 *   - the wrong ENV NAME hands the device token to a provider ladder that can
 *     post it to a third party;
 *   - a REPLACED `plugins.enabled` silently unloads the customer's own plugins;
 *   - a THROWN failure here would turn "no pictures" into "cannot link at all".
 */

const cliMock = vi.hoisted(() => vi.fn());
const envMock = vi.hoisted(() => vi.fn());
const installMock = vi.hoisted(() => vi.fn());
const drawsMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
// The two halves of "and then tell the RUNNING agent". The fact is mocked so a
// case can say what the writes ended up meaning; the refresh is mocked because
// what belongs here is that it is CALLED with that fact — what it then does
// with it has its own suite (hermes-image-refresh.test.ts).
vi.mock("@/lib/harness/hermes-features", () => ({ hermesAgentDrawsImages: drawsMock }));
vi.mock("@/lib/hermes-image-refresh", () => ({ refreshHermesImageTools: refreshMock }));
// `hermes-clawai` now reads the coding-agent verdict either side of the writes,
// and that module owns a runs store keyed off DATA_DIR. Only the verdict is
// wanted here; `checkReadiness` has its own suite.
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn(async () => ({ ready: false })) }));
vi.mock("@/lib/coding-agent-mcp-refresh", () => ({
  refreshCodingAgentToolsIfReadinessChanged: vi.fn(),
}));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
// `get` too: the link reads the owner's explicit model pick before deciding
// what the tier badge may write (TASK-713). Nothing stored here, so the badge
// decides, exactly as it did before the marker existed.
vi.mock("@/lib/config-store", () => ({ setMany: vi.fn(), get: vi.fn(async () => null) }));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: envMock }));
// The copy is mocked; `mergePluginsEnabled` is NOT, because the merge is the
// part with a rule in it and it has its own reasons to be right.
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: installMock,
}));

import { CLAWBOX_AI_PROXY_URL, applyClawaiToHermes } from "@/lib/hermes-clawai";
import { CLAWBOX_AI_IMAGE_MODEL_ID } from "@/lib/clawbox-ai-models";
import { HERMES_IMAGE_PLUGIN_NAME, HERMES_IMAGE_TOKEN_ENV } from "@/lib/hermes-image-plugin";

const OK = { code: 0, stdout: "", stderr: "" };

/**
 * A `hermes` that actually STORES what it is told for `plugins.enabled`, and
 * REPORTS what it would load from it.
 *
 * The write is proved by asking Hermes now (TASK-701): `plugins list --json`,
 * whose `status` comes from the loader's own `_get_enabled_set`. A stub
 * answering "" to every call therefore reports a plugin that is not enabled,
 * and the link then correctly refuses to claim the box can draw — which would
 * end every case here in the same place. Modelling the store keeps each case
 * about what it is about. `override` wins where a case needs a specific
 * failure.
 */
function hermesFake(
  override: (args: string[]) => { code: number; stdout: string; stderr: string } | undefined = () => undefined,
  seed?: unknown,
): void {
  let stored = seed;
  cliMock.mockImplementation(async (args: string[]) => {
    const forced = override(args);
    if (forced) return forced;
    if (args[0] === "plugins" && args[1] === "list") {
      // `set(enabled) if isinstance(enabled, list) else set()` — the rule the
      // real one applies (hermes_cli/plugins_cmd.py:1309-1324).
      const enabled = Array.isArray(stored) && stored.includes(HERMES_IMAGE_PLUGIN_NAME);
      return {
        code: 0,
        stdout: JSON.stringify([
          { name: HERMES_IMAGE_PLUGIN_NAME, status: enabled ? "enabled" : "not enabled", version: "1.0.0", description: "", source: "user" },
        ]),
        stderr: "",
      };
    }
    if (args[1] === "set" && args[2] === "plugins.enabled") {
      stored = JSON.parse(args[3]);
      return OK;
    }
    if (args[1] === "get" && args[2] === "plugins.enabled") {
      return stored === undefined
        ? { code: 1, stdout: "", stderr: "Config key not set: plugins.enabled" }
        : { code: 0, stdout: JSON.stringify(stored), stderr: "" };
    }
    return OK;
  });
}

/** Every `config set`, as "key=value", in the order they were issued. */
function sets(): string[] {
  return cliMock.mock.calls
    .map((c) => c[0] as string[])
    .filter((a) => a[1] === "set")
    .map((a) => `${a[2]}=${a[3]}`);
}

describe("enabling image generation when ClawBox AI is linked", () => {
  beforeEach(() => {
    cliMock.mockReset();
    envMock.mockReset();
    installMock.mockReset();
    drawsMock.mockReset();
    refreshMock.mockReset();
    hermesFake();
    // Called twice per link: once before the writes, once after. The default is
    // the ordinary case — a box that could not draw, and now can.
    drawsMock.mockResolvedValueOnce(false).mockResolvedValue(true);
  });

  it("installs the backend and names it as the one to use", async () => {
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(installMock).toHaveBeenCalledTimes(1);
    // `image_gen.provider` is what `agent/image_gen_registry.get_active_provider`
    // reads before it dispatches an `image_generate` call.
    expect(sets()).toContain(`image_gen.provider=${HERMES_IMAGE_PLUGIN_NAME}`);
  });

  it("points the backend at this device's own proxy", async () => {
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(
      `image_gen.${HERMES_IMAGE_PLUGIN_NAME}.base_url=${CLAWBOX_AI_PROXY_URL}`,
    );
  });

  it("asks for the model every plan is entitled to", async () => {
    // gpt-image-1-mini is ["free","pro","max"] on the proxy; gpt-image-2 is
    // ["max"]. This runs at LINK time, before anything here knows the plan.
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(`image_gen.model=${CLAWBOX_AI_IMAGE_MODEL_ID}`);
    expect(sets()).toContain(
      `image_gen.${HERMES_IMAGE_PLUGIN_NAME}.model=${CLAWBOX_AI_IMAGE_MODEL_ID}`,
    );
    expect(sets().join("\n")).not.toContain("gpt-image-2");
  });

  it("writes the credential under a ClawBox name, never OpenAI's", async () => {
    await applyClawaiToHermes("claw_token_abc", "pro");
    expect(envMock).toHaveBeenCalledWith({ [HERMES_IMAGE_TOKEN_ENV]: "claw_token_abc" });
    const written = envMock.mock.calls.flatMap((c) => Object.keys(c[0] as object));
    expect(written).not.toContain("OPENAI_API_KEY");
    expect(written).not.toContain("OPENAI_BASE_URL");
    // And it never reaches config.yaml, which `hermes dump` collects into
    // support bundles.
    expect(sets().join("\n")).not.toContain(HERMES_IMAGE_TOKEN_ENV);
  });

  it("adds itself to plugins.enabled without dropping the customer's plugins", async () => {
    hermesFake(() => undefined, ["weather", "spotify"]);
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(
      `plugins.enabled=${JSON.stringify(["weather", "spotify", HERMES_IMAGE_PLUGIN_NAME])}`,
    );
  });

  it("leaves plugins.enabled alone when it already lists us", async () => {
    hermesFake(() => undefined, [HERMES_IMAGE_PLUGIN_NAME]);
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets().some((s) => s.startsWith("plugins.enabled="))).toBe(false);
  });

  it("initialises plugins.enabled on a box that has never enabled one", async () => {
    // `hermes config get` exits NON-ZERO for an absent key, with this wording.
    // It is not a failed read: there is genuinely nothing to preserve, so the
    // list is created with ours in it.
    hermesFake();
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).toContain(`plugins.enabled=${JSON.stringify([HERMES_IMAGE_PLUGIN_NAME])}`);
  });

  it("writes nothing when the plugins.enabled read fails for any other reason", async () => {
    // A locked config or a timed-out CLI knows NOTHING about what is in that
    // list. Reading that as "empty" and writing ours over it would unload every
    // plugin the customer had enabled — the one destructive thing this whole
    // function can do.
    hermesFake((args) =>
      args[1] === "get" && args[2] === "plugins.enabled"
        ? { code: 1, stdout: "", stderr: "could not acquire config lock" }
        : undefined,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets().some((s) => s.startsWith("plugins.enabled="))).toBe(false);
    // And the box does not then claim it can draw.
    expect(sets().some((s) => s.startsWith("image_gen."))).toBe(false);
    warn.mockRestore();
  });

  it("never claims the agent can draw when a setting it depends on failed", async () => {
    // `image_gen.provider` is the key the capability probe reads. Written
    // before the base URL, a failed base URL would leave a box advertising a
    // backend with nowhere to send the request: no composer button, and every
    // request for a picture dying inside the agent.
    hermesFake((args) =>
      args[2] === `image_gen.${HERMES_IMAGE_PLUGIN_NAME}.base_url`
        ? { code: 1, stdout: "", stderr: "nope" }
        : undefined,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(sets()).not.toContain(`image_gen.provider=${HERMES_IMAGE_PLUGIN_NAME}`);
    warn.mockRestore();
  });

  it("still links the box when the backend cannot be installed", async () => {
    // Drawing is an extra. Chat, vision and transcription are not, and a box
    // that could not copy a Python file must not be left unable to talk.
    installMock.mockRejectedValue(new Error("EACCES"));
    // And the box now reads as one that cannot draw, which is the fact the
    // refresh is handed — the half that keeps #497's honest refusal alive.
    drawsMock.mockResolvedValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await applyClawaiToHermes("claw_token_abc", "flash");
    expect(result.provider).toBe("clawai");
    expect(sets()).toContain("model.provider=clawai");
    expect(refreshMock).toHaveBeenCalledWith(false, false);
    // The failure is named in the journal, and the token is not.
    expect(warn.mock.calls.flat().join(" ")).not.toContain("claw_token_abc");
    warn.mockRestore();
  });

  it("tells the RUNNING agent about the backend it just installed", async () => {
    // The writes above all land on DISK. The agent that serves the next turn is
    // a process that started long before them and reads its credential and its
    // plugin list exactly once — at ITS startup. Measured on the owner's box
    // (2026-08-27): linked at 09:08:52 into a dashboard up since the previous
    // day, and the 09:10:07 request for a picture found no `image_generate` at
    // all. A link that only writes files is a link the agent never hears about.
    await applyClawaiToHermes("claw_token_abc", "flash");
    // Both values, because the two stale things have two lifetimes: the MCP
    // tool list turns on the FLIP, the running agent's credential does not.
    expect(refreshMock).toHaveBeenCalledWith(false, true);
  });

  it("does not stop the link when a config write for images fails", async () => {
    hermesFake((args) =>
      args[2]?.startsWith("image_gen") ? { code: 1, stdout: "", stderr: "nope" } : undefined,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(applyClawaiToHermes("claw_token_abc", "flash")).resolves.toMatchObject({
      provider: "clawai",
    });
    warn.mockRestore();
  });
});
