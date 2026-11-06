/**
 * Settings → Users: the owner's "Share OpenClaw with all users" switch.
 * Rendered with a `t` that answers the KEY, so every string is shown to be
 * going through the catalogue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import OpenClawSharingCard from "@/components/OpenClawSharingCard";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
}));

const URL_ = "/setup-api/settings/openclaw-sharing";

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

describe("OpenClawSharingCard", () => {
  let state: { shared: boolean; canChange: boolean; available: boolean };
  let postAnswer: { status: number; body?: unknown } | null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state = { shared: false, canChange: true, available: true };
    postAnswer = null;
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url !== URL_) return json(404, {});
      if ((init?.method ?? "GET") === "GET") return json(200, state);
      if (postAnswer) return json(postAnswer.status, postAnswer.body ?? {});
      state = { ...state, shared: JSON.parse(String(init?.body)).shared };
      return json(200, state);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the owner the switch, off by default, with what sharing means", async () => {
    render(<OpenClawSharingCard />);
    const toggle = await screen.findByTestId("openclaw-sharing-switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("users.shareOpenclaw.title")).toBeInTheDocument();
    expect(screen.getByText("users.shareOpenclaw.hint")).toBeInTheDocument();
    expect(screen.getByTestId("openclaw-sharing-state")).toHaveTextContent("users.shareOpenclaw.off");
  });

  it("shares OpenClaw on a click and draws the box's answer", async () => {
    render(<OpenClawSharingCard />);
    fireEvent.click(await screen.findByTestId("openclaw-sharing-switch"));
    await waitFor(() => expect(screen.getByTestId("openclaw-sharing-switch")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByTestId("openclaw-sharing-state")).toHaveTextContent("users.shareOpenclaw.on");
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ shared: true });
  });

  it("keeps the stored position and says why when the box refuses", async () => {
    postAnswer = { status: 403, body: { error: "Only the box owner can share OpenClaw, from their own browser.", code: "owner_only" } };
    render(<OpenClawSharingCard />);
    fireEvent.click(await screen.findByTestId("openclaw-sharing-switch"));
    expect(await screen.findByTestId("openclaw-sharing-failed")).toHaveTextContent("Only the box owner can share OpenClaw");
    expect(screen.getByTestId("openclaw-sharing-switch")).toHaveAttribute("aria-checked", "false");
  });

  it("draws nothing for another user, nor on a box whose assistant is not OpenClaw", async () => {
    state = { shared: true, canChange: false, available: true };
    const { unmount } = render(<OpenClawSharingCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("openclaw-sharing")).toBeNull();
    unmount();

    state = { shared: false, canChange: true, available: false };
    render(<OpenClawSharingCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("openclaw-sharing")).toBeNull();
  });
});
