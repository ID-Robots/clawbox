import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ClawBox AI apply retires the proxy's REFUSAL only when the credential
 * actually changed.
 *
 * When the proxy refuses this box's token, ClawBox records the fact
 * (`clawai_credential_refused_at`) and both boot scripts stand the image path
 * down, because there is no back-off downstream: the plugin spends refused calls
 * for as long as the box is switched on (6,554 in twelve hours from one box,
 * TASK-727). The mark is about the CREDENTIAL, so only a different credential
 * retires it — the rule `configureClawboxAi` already states on the OpenClaw
 * side, and the rule this apply did not follow: it cleared the mark the moment
 * `config set providers.clawai.api_key` exited 0, whatever was in it.
 *
 * That was harmless while only a pasted token reached here. It stopped being
 * harmless when the configure route began calling this on the dual SKU: a
 * Settings save with the SAME token — or a tier-pill press, which falls back to
 * the stored token — retired the stand-down, and the next boot re-armed the
 * image path against a credential the proxy had already refused.
 */

const cliMock = vi.hoisted(() => vi.fn());
const forgetRefusal = vi.hoisted(() => vi.fn(async () => {}));
const storedToken = vi.hoisted(() => ({ value: "claw_stored" }));

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/harness/hermes-features", () => ({ hermesAgentDrawsImages: vi.fn(async () => true) }));
vi.mock("@/lib/config-store", () => ({
  setMany: vi.fn(),
  // `get`/`set` too, even though the refusal write is spied below: a factory
  // that omits them makes every read of the persisted refusal take its catch
  // and answer the default, silently — which is what
  // openclaw-config-mock-completeness.test.ts exists to catch.
  get: vi.fn(async () => undefined),
  set: vi.fn(),
  // What the box holds BEFORE this apply — the fallback `previousClawaiToken`
  // is read from when a caller does not pass one.
  getKnown: vi.fn(async (key: string) =>
    key === "clawai_token" ? { value: storedToken.value, known: true } : { value: undefined, known: true },
  ),
}));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn() }));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: vi.fn(),
}));
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  resolveVisionModelId: vi.fn(async () => ({ id: null, verified: false, reason: "probe-failed" })),
}));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn(async () => ({ ready: true })) }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: vi.fn(async () => ({ status: "ok" })) }));
vi.mock("@/lib/hermes-dashboard-control", () => ({ bounceHermesDashboard: vi.fn(async () => "restarted") }));
// The one write under test, spied rather than replaced wholesale so every other
// export of the module keeps its real behaviour.
vi.mock("@/lib/harness/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness/credentials")>()),
  forgetClawaiCredentialRefusal: forgetRefusal,
}));

import { applyClawaiToHermes } from "@/lib/hermes-clawai";

beforeEach(() => {
  cliMock.mockReset();
  forgetRefusal.mockClear();
  storedToken.value = "claw_stored";
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
});

describe("applyClawaiToHermes and the credential refusal", () => {
  it("leaves the stand-down in place when the same credential is saved again", async () => {
    // The dual-SKU Settings save, and the tier-pill press: nothing about the
    // credential changed, so the proxy's refusal of it is still true. Clearing
    // here re-armed the image path both boot scripts had just stood down.
    await applyClawaiToHermes("claw_stored", "flash", { previousClawaiToken: "claw_stored" });

    expect(forgetRefusal).not.toHaveBeenCalled();
  });

  it("retires it when a DIFFERENT credential is linked", async () => {
    // The re-link every refusal message asks for. The mark is about the token
    // that is gone.
    await applyClawaiToHermes("claw_new", "flash", { previousClawaiToken: "claw_stored" });

    expect(forgetRefusal).toHaveBeenCalledTimes(1);
  });

  it("retires it on a first link, where the box held no token at all", async () => {
    // No previous token is not "unchanged": whatever was refused, this is not
    // it, and a box linking for the first time must arm.
    storedToken.value = "";
    await applyClawaiToHermes("claw_new", "flash");

    expect(forgetRefusal).toHaveBeenCalledTimes(1);
  });

  it("does not retire it when the api_key write itself failed", async () => {
    // The pre-existing half of the rule, kept: dropping the mark before the new
    // credential is on disk would re-enable requests against the very token the
    // proxy refused.
    cliMock.mockImplementation(async (args: string[]) =>
      args[2] === "providers.clawai.api_key"
        ? { code: 1, stdout: "", stderr: "refused" }
        : { code: 0, stdout: "", stderr: "" },
    );

    await expect(
      applyClawaiToHermes("claw_new", "flash", { previousClawaiToken: "claw_stored" }),
    ).rejects.toThrow();
    expect(forgetRefusal).not.toHaveBeenCalled();
  });
});
