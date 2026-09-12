import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connecting ClawBox AI has to re-advertise the coding-agent tools, for the same
 * reason flipping the switch does.
 *
 * `getCodingAgentStatus().ready` is three facts ANDed together — the owner's
 * switch, the harness on disk, and ClawBox AI connected — and the ClawBox MCP
 * server reads exactly that verdict ONCE, while it boots
 * (`mcp/lib/context.ts` probeCodingAgent), to decide whether
 * `coding_agent_run`/`_status`/`_stop` exist at all. #514 taught the enable
 * route to reload the tool list when the SWITCH moved the verdict. This file
 * pins the sibling write path: the third of those facts is written here, by
 * `applyClawaiToHermes`, which every Hermes connect entry point funnels through
 * (`/setup-api/hermes/clawai`, `/setup-api/ai-models/configure`, and the
 * device-code finaliser in `/setup-api/ai-models/clawai/poll`). Without this a
 * box with the switch already on goes ready:false → ready:true, the panel says
 * ready, and the long-lived MCP child still has none of the three tools.
 *
 * The second rule here is the COST one. A reload kills and respawns every MCP
 * child and invalidates the model's prompt cache, and this one call can move two
 * families at once (drawing and the coding agent), so a link that changes both
 * must still cost exactly ONE respawn.
 */

const cliMock = vi.hoisted(() => vi.fn());
const drawsMock = vi.hoisted(() => vi.fn());
const statusMock = vi.hoisted(() => vi.fn());
const rpcMock = vi.hoisted(() => vi.fn());
const bounceMock = vi.hoisted(() => vi.fn());
const resolveVisionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/harness/hermes-features", () => ({ hermesAgentDrawsImages: drawsMock }));
// `getKnown` too: the link reads the owner's explicit model picks before
// deciding what the tier badge may write (TASK-713). Nothing stored here, so the
// badge decides, exactly as it did before the marker existed.
vi.mock("@/lib/config-store", () => ({
  setMany: vi.fn(),
  getKnown: vi.fn(async () => ({ value: undefined, known: true })),
  // `get`/`set` are how the link reads and clears the persisted ClawBox AI
  // credential refusal — the record that decides whether the image slot may be
  // armed. Both calls sit inside a catch that answers a DEFAULT, so omitting
  // them would silently put every case here on the "no refusal" branch
  // (openclaw-config-mock-completeness.test.ts).
  get: vi.fn(async () => undefined),
  set: vi.fn(),
}));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn() }));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: vi.fn(),
}));
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  resolveVisionModelId: resolveVisionMock,
}));
// The coding-agent module owns a runs store keyed off DATA_DIR; only its verdict
// is wanted here, and `checkReadiness` has its own suite.
const clearFaultMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: statusMock, clearHarnessFault: clearFaultMock }));
// A Hermes box, so the refresh helpers report in Hermes' words.
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
// NOT mocked, deliberately: `hermes-image-refresh`, `coding-agent-mcp-refresh`
// and `hermes-mcp-reload` are the three modules whose combined behaviour is the
// subject. Only the socket underneath them is faked.
vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));
vi.mock("@/lib/hermes-dashboard-control", () => ({ bounceHermesDashboard: bounceMock }));

import { applyClawaiToHermes } from "@/lib/hermes-clawai";
import { CLAWBOX_AI_VISION_MODEL_ID } from "@/lib/clawbox-ai-models";

/** How many GLOBAL MCP respawns this link asked the agent for. */
function reloadCount(): number {
  return rpcMock.mock.calls.filter((call) => call[0] === "reload.mcp").length;
}

/**
 * @param drawsBefore/drawsAfter what `hermesAgentDrawsImages()` says either side
 * @param readyBefore/readyAfter what `getCodingAgentStatus().ready` says either side
 */
function box(opts: {
  drawsBefore: boolean;
  drawsAfter: boolean;
  readyBefore: boolean;
  readyAfter: boolean;
}): void {
  drawsMock.mockResolvedValueOnce(opts.drawsBefore).mockResolvedValue(opts.drawsAfter);
  statusMock
    .mockResolvedValueOnce({ ready: opts.readyBefore })
    .mockResolvedValue({ ready: opts.readyAfter });
}

beforeEach(() => {
  cliMock.mockReset();
  drawsMock.mockReset();
  statusMock.mockReset();
  rpcMock.mockReset();
  bounceMock.mockReset();
  resolveVisionMock.mockReset();
  clearFaultMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  resolveVisionMock.mockResolvedValue({
    id: CLAWBOX_AI_VISION_MODEL_ID,
    verified: true,
    reason: "proxy-allows",
  });
  bounceMock.mockResolvedValue("restarted");
  // The running agent answers every probe happily, so nothing below is a bounce.
  rpcMock.mockImplementation(async (method: string) =>
    method === "image.generate" ? { available: true } : { status: "ok" },
  );
});

describe("applyClawaiToHermes and the coding-agent tool list", () => {
  it("re-advertises the coding-agent tools when connecting is what made them runnable", async () => {
    // The customer path this exists for: the owner turns the coding agent on
    // FIRST (the switch saves fine, `ready` stays false because no AI is
    // connected — the readiness text even tells them to go and connect one),
    // then connects ClawBox AI. That second step is what moves the verdict, and
    // before this fix nothing told the running agent.
    box({ drawsBefore: true, drawsAfter: true, readyBefore: false, readyAfter: true });
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(reloadCount()).toBe(1);
    // `confirm` is not decoration: `reload.mcp` is gated by
    // approvals.mcp_reload_confirm, which defaults to true.
    expect(rpcMock).toHaveBeenCalledWith("reload.mcp", { confirm: true });
  });

  /**
   * A remembered harness fault — the record that makes the device refuse new
   * runs after one died because the harness could not get a model to answer —
   * is cleared HERE, on the credential write itself.
   *
   * Not in the callers: only this function knows the write landed, and only
   * here is the clear inside the before/after pair the MCP refresh is computed
   * from. A caller clearing beforehand makes this function read an
   * already-ready box and skip the reload; a caller clearing afterwards leaves
   * the fault standing while `codingReadyAfter` is read, which skips it too.
   */
  describe("the remembered harness fault", () => {
    it("is cleared when the credential write lands", async () => {
      // The refusal message sends the owner to Settings → AI Models. A
      // credential that has just landed is newer evidence than the fault.
      box({ drawsBefore: true, drawsAfter: true, readyBefore: false, readyAfter: true });
      await applyClawaiToHermes("claw_token_abc", "flash");
      expect(clearFaultMock).toHaveBeenCalledTimes(1);
    });

    it("is left standing when the write fails", async () => {
      // Nothing was fixed, so the refusal still describes the box. Clearing
      // optimistically would hand back a 502 with the guard already gone.
      cliMock.mockImplementation(async (args: string[]) =>
        args[2]?.endsWith(".api_key")
          ? { code: 1, stdout: "", stderr: "hermes: could not write" }
          : { code: 0, stdout: "", stderr: "" },
      );
      box({ drawsBefore: true, drawsAfter: true, readyBefore: false, readyAfter: true });
      await expect(applyClawaiToHermes("claw_token_abc", "flash")).rejects.toThrow();
      expect(clearFaultMock).not.toHaveBeenCalled();
    });

    it("is cleared even when the same token is pasted again", async () => {
      // Unlike the credential-refusal record beside it, this one is NOT gated
      // on the bytes changing: the PLAN behind an unchanged token can have
      // moved upstream, and an upgrade to Max is exactly the fix the refusal
      // message asks for while moving no bytes on this box.
      box({ drawsBefore: true, drawsAfter: true, readyBefore: true, readyAfter: true });
      await applyClawaiToHermes("claw_token_abc", "flash", { previousClawaiToken: "claw_token_abc" });
      expect(clearFaultMock).toHaveBeenCalledTimes(1);
    });

    it("does not fail the link when the clear throws", async () => {
      // The credential has landed; a bookkeeping write that would not go must
      // not turn a save that worked into an error.
      clearFaultMock.mockRejectedValue(new Error("disk full"));
      box({ drawsBefore: true, drawsAfter: true, readyBefore: false, readyAfter: true });
      await expect(applyClawaiToHermes("claw_token_abc", "flash")).resolves.toBeTruthy();
    });
  });

  it("costs ONE respawn when the same link moves drawing and the coding agent together", async () => {
    // A reload respawns every MCP child and invalidates the prompt cache. Two
    // families changing in one request is one fact about one box, not two
    // reloads to pay for.
    box({ drawsBefore: false, drawsAfter: true, readyBefore: false, readyAfter: true });
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(reloadCount()).toBe(1);
  });

  it("does not reload when neither family moved", async () => {
    // Re-applying a tier on a box that was already linked and already ready.
    // Nothing about the tool list changed, so the owner may not be charged a
    // prompt-cache invalidation for it.
    box({ drawsBefore: true, drawsAfter: true, readyBefore: true, readyAfter: true });
    await applyClawaiToHermes("claw_token_abc", "pro");
    expect(reloadCount()).toBe(0);
  });

  it("reads the BEFORE verdict before it writes the token, not after", async () => {
    // The trap: `checkReadiness` reads `clawai_token` from the config store, and
    // this function writes that key. A verdict sampled after the write is always
    // true, the guard sees before === after, and the reload silently never
    // happens. The first `getCodingAgentStatus()` must therefore land before the
    // `setMany` at the bottom of the apply.
    box({ drawsBefore: true, drawsAfter: true, readyBefore: false, readyAfter: true });
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(statusMock).toHaveBeenCalledTimes(2);
    expect(reloadCount()).toBe(1);
  });

  it("does not let a readiness probe that threw fail the link", async () => {
    // `checkReadiness` stats a wrapper, looks for two binaries on PATH and lists
    // the project folders — all of which can throw on a half-installed box. This
    // whole refresh is a courtesy laid on top of writes that already happened;
    // turning it into "cannot link at all" would be the fail-soft promise the
    // image half of this function makes, broken by its neighbour.
    statusMock.mockRejectedValue(new Error("no such file"));
    drawsMock.mockResolvedValue(true);
    await expect(applyClawaiToHermes("claw_token_abc", "flash")).resolves.toMatchObject({
      provider: "clawai",
    });
    expect(reloadCount()).toBe(0);
  });

  it("does not reload on a half-answered verdict", async () => {
    // Readable before, unreadable after: that is not a flip, it is an unknown,
    // and a global respawn is not the thing to do on a guess.
    drawsMock.mockResolvedValue(true);
    statusMock
      .mockResolvedValueOnce({ ready: false })
      .mockRejectedValue(new Error("no such file"));
    await applyClawaiToHermes("claw_token_abc", "flash");
    expect(reloadCount()).toBe(0);
  });

  it("lets the caller supply the BEFORE verdict when it wrote the token first", async () => {
    // `/setup-api/hermes/clawai` persists a PASTED token before it applies it,
    // so a snapshot taken in here would already be true. The route takes its own
    // and hands it over; this pins that the override is honoured.
    box({ drawsBefore: true, drawsAfter: true, readyBefore: true, readyAfter: true });
    await applyClawaiToHermes("claw_token_abc", "flash", { codingAgentReadyBefore: false });
    expect(reloadCount()).toBe(1);
  });
});
