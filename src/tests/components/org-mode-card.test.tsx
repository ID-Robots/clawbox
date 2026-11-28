/**
 * Settings → System → Users: the owner's "Organisation mode" switch
 * (TASK-2435). Rendered with a `t` that answers the KEY, so every string is
 * shown to be going through the catalogue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import OrgModeCard from "@/components/OrgModeCard";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
}));

const URL_ = "/setup-api/settings/org-mode";

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

describe("OrgModeCard", () => {
  let state: { orgMode: boolean; canChange: boolean };
  let postAnswer: { status: number; body?: unknown } | null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state = { orgMode: false, canChange: true };
    postAnswer = null;
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url !== URL_) return json(404, {});
      if ((init?.method ?? "GET") === "GET") return json(200, state);
      if (postAnswer) return json(postAnswer.status, postAnswer.body ?? {});
      state = { ...state, orgMode: JSON.parse(String(init?.body)).orgMode };
      return json(200, state);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the owner the switch, off by default, with what it narrows", async () => {
    render(<OrgModeCard />);
    const toggle = await screen.findByTestId("org-mode-switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("users.orgMode.hint")).toBeInTheDocument();
    expect(screen.getByTestId("org-mode-state")).toHaveTextContent("users.orgMode.off");
  });

  it("turns it on and off through the route", async () => {
    render(<OrgModeCard />);
    fireEvent.click(await screen.findByTestId("org-mode-switch"));
    await waitFor(() => expect(screen.getByTestId("org-mode-switch")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByTestId("org-mode-state")).toHaveTextContent("users.orgMode.on");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ orgMode: true });
    fireEvent.click(screen.getByTestId("org-mode-switch"));
    await waitFor(() => expect(screen.getByTestId("org-mode-switch")).toHaveAttribute("aria-checked", "false"));
  });

  it("says when the switch could not be saved, with the route's own sentence", async () => {
    postAnswer = { status: 500, body: { error: "The ClawBox settings file could not be written." } };
    render(<OrgModeCard />);
    fireEvent.click(await screen.findByTestId("org-mode-switch"));
    expect(await screen.findByTestId("org-mode-failed")).toHaveTextContent("users.orgMode.failed The ClawBox settings file could not be written.");
    expect(screen.getByTestId("org-mode-switch")).toHaveAttribute("aria-checked", "false");
  });

  it("tells the Users panel around it what the switch says, once read and on every change", async () => {
    const onChange = vi.fn();
    render(<OrgModeCard onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(false));
    fireEvent.click(await screen.findByTestId("org-mode-switch"));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(true));
  });

  it("is drawn for nobody but the owner", async () => {
    state = { orgMode: true, canChange: false };
    const { container } = render(<OrgModeCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
