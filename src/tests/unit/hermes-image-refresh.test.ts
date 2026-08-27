import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Linking ClawBox AI under a RUNNING agent has to make that agent able to draw.
 *
 * The bug this pins is measured rather than imagined — the timeline is recorded
 * once, in `src/lib/hermes-image-refresh.ts`. What the cases below are for is
 * the three states a box can be in after a link, and the cheapest correct action
 * for each: a stale credential (reload it), a backend the agent never scanned
 * (bounce it), and a dashboard that will not say (leave it alone).
 */

const rpcMock = vi.hoisted(() => vi.fn());
const bounceMock = vi.hoisted(() => vi.fn());
const reloadMcpMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));
vi.mock("@/lib/hermes-dashboard-control", () => ({ bounceHermesDashboard: bounceMock }));
vi.mock("@/lib/hermes-mcp-reload", () => ({ reloadMcpServers: reloadMcpMock }));

import { refreshHermesImageTools } from "@/lib/hermes-image-refresh";

/**
 * The running agent answers the `image.generate` probe with `available`, or —
 * for `null` — does not answer at all, which is what `dashboardRpc` reports as
 * a dead socket, a timeout or an error frame.
 */
function agentSaysItCanDraw(available: boolean | null): void {
  rpcMock.mockImplementation(async (method: string) =>
    method === "image.generate" ? (available === null ? null : { available }) : { status: "ok" },
  );
}

/** Every RPC method asked for, in order. */
function methods(): string[] {
  return rpcMock.mock.calls.map((call) => call[0] as string);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  rpcMock.mockReset();
  bounceMock.mockReset();
  reloadMcpMock.mockReset();
  bounceMock.mockResolvedValue(true);
  reloadMcpMock.mockResolvedValue(true);
  agentSaysItCanDraw(true);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("refreshHermesImageTools", () => {
  it("makes a newly linked box able to draw WITHOUT a restart when only the credential was stale", async () => {
    // The common case, and the one the whole helper is sized for: the backend
    // was already on disk when the agent last started, so all it was missing is
    // the token that linking just wrote to ~/.hermes/.env.
    await refreshHermesImageTools(false, true);

    // The credential first, because it is the cheap half and on this box it is
    // the whole fix — and `probe: true` is what makes the second call a
    // question rather than a generation: it runs upstream's own
    // `check_image_generation_requirements()` in the process that will serve the
    // next turn, spends no allowance and returns no picture.
    expect(methods()).toEqual(["reload.env", "image.generate"]);
    expect(rpcMock).toHaveBeenCalledWith("image.generate", { probe: true }, expect.anything());
    // #497 registers an `image_generate` that only explains why it cannot run,
    // and only where the box cannot draw. The MCP server probes that once at
    // startup, so without this the refusal outlives the link and tells a linked
    // owner to go and link.
    expect(reloadMcpMock).toHaveBeenCalledTimes(1);
    // And nothing was restarted: a bounce here would cost the owner their chat
    // backend to fix something that was already fixed.
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("bounces the dashboard when the agent still cannot see the backend", async () => {
    // The owner's actual box. `reload.env` fixes the credential and the agent
    // STILL says no, because `_ensure_plugins_discovered()` returns early once
    // the manager has run and nothing reachable over the socket passes `force`.
    // A restart is the only thing that re-scans.
    agentSaysItCanDraw(false);

    await refreshHermesImageTools(false, true);

    expect(bounceMock).toHaveBeenCalledTimes(1);
    // No MCP reload after a bounce: the restart respawns the MCP child with the
    // dashboard, so asking for one would be paying twice.
    expect(reloadMcpMock).not.toHaveBeenCalled();
  });

  it("does NOT bounce a dashboard that merely failed to answer", async () => {
    // The difference between "it said no" and "it said nothing" is the
    // difference between a fix and an outage: the likeliest reason a local
    // dashboard misses a six-second deadline is that it is busy serving a turn,
    // and a SIGTERM is not the response to being busy.
    agentSaysItCanDraw(null);

    await refreshHermesImageTools(false, true);

    expect(bounceMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("reloads the credential even when nothing about the box's answer changed", async () => {
    // Re-linking with a fresh device token, or a tier change: `before` and
    // `after` are both true, and the running agent is still holding the OLD
    // credential. The email sibling's flip guard would skip this; here it must
    // not, because the credential is a second thing that goes stale.
    await refreshHermesImageTools(true, true);

    expect(methods()).toContain("reload.env");
    // The MCP tool list, though, depends only on WHETHER the box can draw — and
    // that did not change, so the owner does not pay for a respawned tool set
    // and a re-sent system prompt.
    expect(reloadMcpMock).not.toHaveBeenCalled();
  });

  it("restores the honest refusal when the box stops being able to draw", async () => {
    // The other direction, and the one that keeps #497's win intact. A box whose
    // image backend went away must get the refusal tool back, so the agent says
    // why instead of improvising a file the chat cannot serve.
    await refreshHermesImageTools(true, false);

    expect(reloadMcpMock).toHaveBeenCalledTimes(1);
    // Nothing else is touched: there is no credential worth reloading into a
    // process that has no backend to spend it through, and nothing to bounce for.
    expect(methods()).toEqual([]);
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("does nothing at all for a box that could not draw before and still cannot", async () => {
    await refreshHermesImageTools(false, false);

    expect(methods()).toEqual([]);
    expect(reloadMcpMock).not.toHaveBeenCalled();
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("never sends a session id — every reload has to be global", async () => {
    await refreshHermesImageTools(false, true);

    for (const [, params] of rpcMock.mock.calls) {
      expect(params).not.toHaveProperty("session_id");
    }
  });

  it("says so when Hermes will not rebuild its tool list", async () => {
    reloadMcpMock.mockResolvedValue(false);

    await refreshHermesImageTools(false, true);

    // Logged, because "the agent still refuses to draw" is otherwise invisible
    // from the outside.
    expect(errorSpy).toHaveBeenCalled();
  });

  it("says so when the backend is installed and the bounce was refused", async () => {
    // A box whose unit is not `Restart=always` — a dev checkout, an older unit
    // file. The dashboard is deliberately left up, and the owner is told what
    // to do about it rather than left with a silently broken feature.
    agentSaysItCanDraw(false);
    bounceMock.mockResolvedValue(false);

    await refreshHermesImageTools(false, true);

    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not throw when the dashboard cannot be reached at all", async () => {
    // An OpenClaw box has no dashboard; a Hermes box can have one that is down.
    // Neither may turn a successful link into an error.
    rpcMock.mockResolvedValue(null);
    bounceMock.mockResolvedValue(false);

    await expect(refreshHermesImageTools(false, true)).resolves.toBeUndefined();
  });

  it("does not throw when the RPC helper itself rejects", async () => {
    rpcMock.mockRejectedValue(new Error("socket exploded"));
    bounceMock.mockResolvedValue(false);

    await expect(refreshHermesImageTools(false, true)).resolves.toBeUndefined();
    await expect(refreshHermesImageTools(true, false)).resolves.toBeUndefined();
  });
});
