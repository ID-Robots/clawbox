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
vi.mock("@/lib/config-store", () => ({ setMany: vi.fn() }));
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
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: statusMock }));
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
