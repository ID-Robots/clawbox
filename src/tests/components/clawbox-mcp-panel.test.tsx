import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import ClawboxMcpPanel from "@/components/ClawboxMcpPanel";

/**
 * The on/off switch for the assistant's device tools (Settings → Harness,
 * 2026-09-15). Mounted inside Settings, so anything it throws takes the whole
 * window with it — which is why a body without the fields hides the card.
 */

const ON = { enabled: true, registered: { openclaw: true, hermes: null } };
const OFF = { enabled: false, registered: { openclaw: false, hermes: null } };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Let the mount effect's fetch chain settle before a "draws nothing" answer is believed. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => json(ON)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClawboxMcpPanel", () => {
  it("draws the switch from the box's answer, checked while the tools are on", async () => {
    render(<ClawboxMcpPanel />);
    await waitFor(() => expect(screen.getByTestId("clawbox-mcp-panel")).toBeTruthy());
    const sw = screen.getByTestId("clawbox-mcp-switch");
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("clawbox-mcp-restarting")).toBeNull();
    expect(screen.queryByTestId("clawbox-mcp-failed")).toBeNull();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("/setup-api/harness/mcp");
  });

  it("draws it unchecked when the box says off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(OFF)));
    render(<ClawboxMcpPanel />);
    await waitFor(() => expect(screen.getByTestId("clawbox-mcp-switch").getAttribute("aria-checked")).toBe("false"));
  });

  it("posts the opposite state, says the assistant is restarting while the write is in flight, and follows the answer", async () => {
    let resolvePost: (r: Response) => void = () => {};
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((resolve) => { resolvePost = resolve; });
      return json(ON);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ClawboxMcpPanel />);
    const sw = await screen.findByTestId("clawbox-mcp-switch");
    fireEvent.click(sw);

    // In flight: the note is up and the switch is held.
    expect(await screen.findByTestId("clawbox-mcp-restarting")).toBeTruthy();
    expect(sw.hasAttribute("disabled")).toBe(true);
    expect(sw.getAttribute("aria-busy")).toBe("true");
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall?.[0]).toBe("/setup-api/harness/mcp");
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ enabled: false });

    await act(async () => { resolvePost(json(OFF)); });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByTestId("clawbox-mcp-restarting")).toBeNull();
    expect(sw.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("clawbox-mcp-failed")).toBeNull();
  });

  it("shows a refusal in the route's own words and keeps the state it had", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init?: RequestInit) => (
      init?.method === "POST"
        ? json({ error: "Switching the assistant's device tools needs a signed-in browser session.", code: "owner_only" }, 403)
        : json(ON)
    )));
    render(<ClawboxMcpPanel />);
    const sw = await screen.findByTestId("clawbox-mcp-switch");
    fireEvent.click(sw);
    const failed = await screen.findByTestId("clawbox-mcp-failed");
    expect(failed.textContent).toContain("needs a signed-in browser session");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.hasAttribute("disabled")).toBe(false);
  });

  it("draws the re-read state a 502 carries beside its error — the switch IS saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init?: RequestInit) => (
      init?.method === "POST"
        ? json({ ...OFF, error: "The gateway did not come back.", code: "gateway_restart_failed" }, 502)
        : json(ON)
    )));
    render(<ClawboxMcpPanel />);
    const sw = await screen.findByTestId("clawbox-mcp-switch");
    fireEvent.click(sw);
    const failed = await screen.findByTestId("clawbox-mcp-failed");
    expect(failed.textContent).toContain("did not come back");
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("says a write that never answered failed, without the route's words", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("Failed to fetch");
      return json(ON);
    }));
    render(<ClawboxMcpPanel />);
    fireEvent.click(await screen.findByTestId("clawbox-mcp-switch"));
    expect(await screen.findByTestId("clawbox-mcp-failed")).toBeTruthy();
    expect(screen.getByTestId("clawbox-mcp-switch").getAttribute("aria-checked")).toBe("true");
  });

  it("draws nothing, and throws nothing, for a body without the fields or a box that does not answer", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const answer of [json({}), json([null]), new Response("nope", { status: 500 }), new Response("", { status: 404 })]) {
        vi.stubGlobal("fetch", vi.fn(async () => answer.clone()));
        const { container, unmount } = render(<ClawboxMcpPanel />);
        await settle();
        expect(container.querySelector("[data-testid='clawbox-mcp-panel']")).toBeNull();
        unmount();
      }
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
