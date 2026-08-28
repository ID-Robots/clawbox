import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI-provider save path's failure text — the surfaces #515's parser was
 * never pointed at.
 *
 * The extraction that gave #515 a home in `@/lib/hermes-cli-message` wrote its
 * own completeness proof into the file header:
 *
 *   grep -rn "stderr" src/app/setup-api/hermes --include=route.ts
 *
 * That grep is scoped to ONE directory, and the AI-provider save path does not
 * live in it. `runHermesCli` resolves with RAW stdout/stderr — it sanitises only
 * the spawn-failure reject — so three libraries handed that stream straight to
 * the browser:
 *
 *   hermes-cloud-provider.ts   `hermes auth add`, `hermes config set`
 *   hermes-clawai.ts           `hermes config set`
 *   hermes-config-yaml.ts      `hermes config set` (the CLI fallback), and the
 *                              fs error from the merge path above it
 *
 * All four throw classes are caught together in /setup-api/ai-models/configure
 * and returned as `{ error: err.message }`; AIModelsStep's `extractError`
 * returns `data.error` unchanged into `showError`. So a failed `hermes auth add`
 * printed its CPython traceback — `/home/clawbox/.hermes/…` and all — into the
 * Settings save banner, which is precisely the input #515 removed from the chat
 * bubble one directory over.
 *
 * The fixtures are the shapes a Python CLI actually produces: a traceback whose
 * summary is the only line worth reading, and the one-line EACCES that carries
 * the install layout with no traceback at all.
 */

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/config-store", () => ({ setMany: vi.fn(), get: vi.fn(async () => null) }));
// The image half of the ClawBox AI apply writes to ~/.hermes and copies a plugin
// into it; neither belongs in this file's blast radius, and both have their own.
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
vi.mock("@/lib/hermes-model-options", () => ({
  invalidateModelOptions: vi.fn(),
  getModelOptions: vi.fn(async () => null),
  isAllowedProvider: vi.fn(() => false),
  scopeFromPayload: vi.fn(async () => ({ defaultModel: "" })),
}));

import { HermesCloudApplyError, applyCloudProviderKeyToHermes } from "@/lib/hermes-cloud-provider";
import { ClawaiApplyError, applyClawaiToHermes } from "@/lib/hermes-clawai";
import { CLAWBOX_AI_VISION_MODEL_ID } from "@/lib/clawbox-ai-models";

const TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/home/clawbox/.hermes/cli/auth.py", line 142, in add',
  '    raise PermissionError(13, "auth-profiles.json")',
  "PermissionError: [Errno 13] Permission denied: '/home/clawbox/.hermes/auth-profiles.json'",
].join("\n");

const ONE_LINE_EACCES = "Error: cannot write /home/clawbox/.hermes/config.yaml: permission denied";

/** The message a customer would be shown for this failure. */
async function messageFor(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the call to fail, and it did not");
}

/** Every assertion that applies to every one of these surfaces. */
function expectCustomerSafe(message: string): void {
  expect(message).not.toContain("/home/clawbox");
  expect(message).not.toContain('File "');
  expect(message).not.toContain("Traceback");
  // Null means "say something generic", never "say nothing" — an empty banner
  // is the silent failure the sanitiser exists to prevent.
  expect(message.trim()).not.toBe("");
}

beforeEach(() => {
  cliMock.mockReset();
  resolveVisionMock.mockReset();
  resolveVisionMock.mockResolvedValue({
    id: CLAWBOX_AI_VISION_MODEL_ID,
    verified: true,
    reason: "proxy-allows",
  });
});

describe("saving a cloud provider key on Hermes", () => {
  it("does not put a Python traceback in the Settings banner", async () => {
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: TRACEBACK });
    expectCustomerSafe(await messageFor(() =>
      applyCloudProviderKeyToHermes({ openclawProvider: "anthropic", apiKey: "sk-test-key" })));
  });

  it("does not name the install layout when there is no traceback at all", async () => {
    // The shape that survives every rule in the parser, because it genuinely IS
    // the cause and it genuinely does name a failure.
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: ONE_LINE_EACCES });
    const message = await messageFor(() =>
      applyCloudProviderKeyToHermes({ openclawProvider: "anthropic", apiKey: "sk-test-key" }));
    expectCustomerSafe(message);
    expect(message).not.toContain(".hermes");
  });

  it("never echoes the API key back, even when the CLI printed the argv it sat in", async () => {
    // An argparse usage error prints the offending command line, and the key is
    // in it. The redaction runs BEFORE the parser for that reason — the order
    // /setup-api/hermes/provider-key already uses.
    const key = "sk-ant-secret-value-0123456789";
    cliMock.mockResolvedValue({
      code: 2,
      stdout: "",
      stderr: [
        "usage: hermes auth add [-h] --type TYPE --api-key API_KEY provider",
        `hermes auth add: error: unrecognized arguments: --api-key ${key}`,
      ].join("\n"),
    });
    const message = await messageFor(() =>
      applyCloudProviderKeyToHermes({ openclawProvider: "anthropic", apiKey: key }));
    expect(message).not.toContain(key);
    expect(message.trim()).not.toBe("");
  });

  it("stays a HermesCloudApplyError, so the configure route still classifies it", async () => {
    cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: TRACEBACK });
    await expect(
      applyCloudProviderKeyToHermes({ openclawProvider: "anthropic", apiKey: "sk-test-key" }),
    ).rejects.toBeInstanceOf(HermesCloudApplyError);
  });

  it("cleans the two `config set` failures after the key is stored, not just the first", async () => {
    // The sibling call sites: `auth add` succeeds, a model resolves, and the
    // activation writes fail. Same class, same screen, three lines apart.
    const options = await import("@/lib/hermes-model-options");
    vi.mocked(options.isAllowedProvider).mockReturnValue(true);
    vi.mocked(options.scopeFromPayload).mockResolvedValue(
      { defaultModel: "claude-opus-5" } as Awaited<ReturnType<typeof options.scopeFromPayload>>,
    );
    cliMock.mockImplementation(async (args: string[]) =>
      args[0] === "auth"
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: TRACEBACK });
    expectCustomerSafe(await messageFor(() =>
      applyCloudProviderKeyToHermes({ openclawProvider: "anthropic", apiKey: "sk-test-key" })));
  });
});

describe("linking ClawBox AI on Hermes", () => {
  it("does not put a Python traceback in the Settings banner", async () => {
    cliMock.mockImplementation(async (args: string[]) =>
      args[1] === "set"
        ? { code: 1, stdout: "", stderr: TRACEBACK }
        : { code: 0, stdout: "", stderr: "" });
    expectCustomerSafe(await messageFor(() => applyClawaiToHermes("claw_token_abc", "flash")));
  });

  it("puts the device token in neither the banner nor the journal", async () => {
    // One of the `config set` steps is `providers.clawai.api_key <token>`, so
    // the argv carries the credential — and an argparse usage error prints the
    // argv back. Both the log line and the thrown message have to be clean.
    const token = "claw_device_token_0123456789";
    const journal = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Fail the ONE step that carries the credential, so the assertions are
      // about that step rather than about whichever `set` happens to be first.
      cliMock.mockImplementation(async (args: string[]) =>
        args[1] === "set" && args[2] === "providers.clawai.api_key"
          ? {
            code: 2,
            stdout: "",
            stderr: `hermes config set: error: unrecognized arguments: ${token}`,
          }
          : { code: 0, stdout: "", stderr: "" });
      const message = await messageFor(() => applyClawaiToHermes(token, "flash"));
      expect(message).not.toContain(token);
      expect(journal.mock.calls.flat().join(" ")).not.toContain(token);
      // The log still says WHICH write failed — redaction, not silence.
      expect(journal.mock.calls.flat().join(" ")).toContain("providers.clawai.api_key");
    } finally {
      journal.mockRestore();
    }
  });

  it("stays a ClawaiApplyError, so the configure route still classifies it", async () => {
    cliMock.mockImplementation(async (args: string[]) =>
      args[1] === "set"
        ? { code: 1, stdout: "", stderr: TRACEBACK }
        : { code: 0, stdout: "", stderr: "" });
    await expect(applyClawaiToHermes("claw_token_abc", "flash")).rejects.toBeInstanceOf(ClawaiApplyError);
  });
});
