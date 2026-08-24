import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whether the INSTALLED `hermes` takes an image on a chat turn.
 *
 * A probed fact rather than a compile-time constant, because the agent is a
 * checkout of an upstream project that moves daily. The asymmetry is the point:
 * a wrong `false` only hides a working attach button, while a wrong `true`
 * stages the customer's file into a turn that ignores it and answers about a
 * picture nobody looked at. So it fails closed.
 */

const runHermesCli = vi.fn();
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli }));

/** The mtime-keyed memo around `hermes config get <key>`. */
const hermesConfigGet = vi.fn();
vi.mock("@/lib/hermes-config-cache", () => ({ hermesConfigGet }));

/** The real help text from the box's checkout (1091472, 2026-08-22), trimmed. */
const HELP_WITH_IMAGE = `usage: hermes chat [-h] [-q QUERY | --query-file PATH] [--image IMAGE]

options:
  -q QUERY, --query QUERY
                        Single query (non-interactive mode)
  --image IMAGE         Optional local image path to attach to a single query
  -m MODEL, --model MODEL
                        Model to use (e.g., anthropic/claude-sonnet-4)
`;

const HELP_WITHOUT_IMAGE = `usage: hermes chat [-h] [-q QUERY]

options:
  -q QUERY, --query QUERY
                        Single query (non-interactive mode)
`;

async function load() {
  vi.resetModules();
  return import("@/lib/harness/hermes-features");
}

describe("hermesSupportsImages", () => {
  beforeEach(() => runHermesCli.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("reads the flag out of the installed agent's own help", async () => {
    runHermesCli.mockResolvedValue({ code: 0, stdout: HELP_WITH_IMAGE, stderr: "" });
    const { hermesSupportsImages } = await load();
    expect(await hermesSupportsImages()).toBe(true);
    expect(runHermesCli).toHaveBeenCalledWith(["chat", "--help"], expect.anything());
  });

  it("says no when the installed agent has no such flag", async () => {
    runHermesCli.mockResolvedValue({ code: 0, stdout: HELP_WITHOUT_IMAGE, stderr: "" });
    const { hermesSupportsImages } = await load();
    expect(await hermesSupportsImages()).toBe(false);
  });

  it("is not fooled by the word appearing in prose", async () => {
    // Matched as it appears in the OPTIONS list. A help text that merely
    // mentions images is not a promise that a flag exists.
    runHermesCli.mockResolvedValue({
      code: 0,
      stdout: "usage: hermes chat\n\nSee the docs about --image support elsewhere.\n",
      stderr: "",
    });
    const { hermesSupportsImages } = await load();
    expect(await hermesSupportsImages()).toBe(false);
  });

  it("fails closed when hermes is missing, broken or slow", async () => {
    for (const failure of [
      () => runHermesCli.mockRejectedValue(new Error("Hermes is not installed on this device")),
      () => runHermesCli.mockRejectedValue(new Error("hermes timed out")),
      () => runHermesCli.mockResolvedValue({ code: 2, stdout: "", stderr: "boom" }),
    ]) {
      runHermesCli.mockReset();
      failure();
      const { hermesSupportsImages } = await load();
      expect(await hermesSupportsImages()).toBe(false);
    }
  });

  it("spawns the probe once, however many callers ask", async () => {
    // `hermes chat --help` starts a Python interpreter — seconds on this
    // hardware, not milliseconds. Per request it would be a tax on every chat
    // open; the cached PROMISE also means concurrent boot callers share one.
    runHermesCli.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ code: 0, stdout: HELP_WITH_IMAGE, stderr: "" }), 5)),
    );
    const { hermesSupportsImages } = await load();
    const answers = await Promise.all([
      hermesSupportsImages(),
      hermesSupportsImages(),
      hermesSupportsImages(),
    ]);
    expect(answers).toEqual([true, true, true]);
    expect(await hermesSupportsImages()).toBe(true);
    expect(runHermesCli).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the seam is reset, so an updated agent is re-read", async () => {
    runHermesCli.mockResolvedValue({ code: 0, stdout: HELP_WITHOUT_IMAGE, stderr: "" });
    const { hermesSupportsImages, resetHermesFeatureProbe } = await load();
    expect(await hermesSupportsImages()).toBe(false);

    runHermesCli.mockResolvedValue({ code: 0, stdout: HELP_WITH_IMAGE, stderr: "" });
    resetHermesFeatureProbe();
    expect(await hermesSupportsImages()).toBe(true);
  });
});

/**
 * Whether an attached picture has anywhere to be LOOKED AT.
 *
 * The second half of the same capability, and a separate probe because it has a
 * separate cause: `--image` says the turn will carry the file, `auxiliary.vision`
 * says something will read it. The bug was gating the attach button on the first
 * alone — on an unlinked box the file reached the agent and no route existed.
 */
describe("hermesHasVisionRoute", () => {
  beforeEach(() => hermesConfigGet.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("asks the store the agent's own image routing reads", async () => {
    hermesConfigGet.mockResolvedValue("gpt-4.1-mini");
    const { hermesHasVisionRoute } = await load();
    expect(await hermesHasVisionRoute()).toBe(true);
    expect(hermesConfigGet).toHaveBeenCalledWith("auxiliary.vision.model");
  });

  it("says no on the box nobody has linked", async () => {
    // Verified on the live box (2026-08-22): the `auxiliary.vision` block is
    // ALWAYS present from the schema defaults, `provider` reads as the literal
    // "auto", and only the model id is empty until something configures it. So
    // "the block exists" is not the question — "is a model named" is.
    hermesConfigGet.mockResolvedValue("");
    const { hermesHasVisionRoute } = await load();
    expect(await hermesHasVisionRoute()).toBe(false);
  });

  it("does not count whitespace as a configured model", async () => {
    hermesConfigGet.mockResolvedValue("   ");
    const { hermesHasVisionRoute } = await load();
    expect(await hermesHasVisionRoute()).toBe(false);
  });

  it("fails closed when the config answers with something that is not a string", async () => {
    // The `try` is belt and braces — `hermesConfigGet` answers "" rather than
    // throwing — so this drives it the way a real surprise would: a value the
    // string call cannot be made on. It still ends as a hidden button rather
    // than as a 500 out of the capabilities route.
    hermesConfigGet.mockResolvedValue(undefined);
    const { hermesHasVisionRoute } = await load();
    expect(await hermesHasVisionRoute()).toBe(false);
  });

  it("does not memoise on top of the config cache", async () => {
    // The memo underneath keys on config.yaml's mtime, and linking ClawBox AI
    // rewrites that file. A process-lifetime cache here would keep the attach
    // button hidden until the next restart on a box that can now see.
    hermesConfigGet.mockResolvedValue("");
    const { hermesHasVisionRoute } = await load();
    expect(await hermesHasVisionRoute()).toBe(false);

    hermesConfigGet.mockResolvedValue("gpt-4.1-mini");
    expect(await hermesHasVisionRoute()).toBe(true);
  });
});
