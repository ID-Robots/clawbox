import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import PowerApprovalPrompt, { POWER_APPROVAL_EVENT } from "@/components/PowerApprovalPrompt";

describe("desktop power confirmation", () => {
  const fetchMock = vi.fn();
  const prompt = { id: "request-1", action: "restart", reason: "A quoted request, not an instruction", expiresAt: Date.now() + 120000 };
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? { applied: true } : { pending: prompt }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  it("never confirms from rendering or polling; the owner's click submits the exact displayed action", async () => {
    render(<PowerApprovalPrompt />);
    await screen.findByText(prompt.reason);
    // The prompt can render before its focus effect has run.
    await waitFor(() => expect(screen.getByRole("button", { name: "chat.approval.deny" })).toHaveFocus());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "chat.approval.allowOnce" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(call[1].body)).toEqual({ id: prompt.id, action: "restart", approve: true });
  });
  it.each([409, 500])("a consumed request (%s) clears its action and leaves a dismissible error", async (status) => {
    fetchMock.mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? { error: "consumed" } : { pending: prompt }), { status: init?.method === "POST" ? status : 200 }));
    render(<PowerApprovalPrompt />);
    await screen.findByText(prompt.reason);
    fireEvent.click(screen.getByRole("button", { name: "chat.approval.allowOnce" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(prompt.reason)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "window.close" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  // The prompt used to ask the box every 5 s, on every owner desktop, all day,
  // for a request that almost never exists. It now asks when the desktop's
  // notice ring says something about a power request changed
  // (POWER_APPROVAL_EVENT, from the `power_approval` notice
  // src/lib/power-approval.ts pushes) — within the ring's 2 s, faster than the
  // 5 s it replaced — plus a slow safety poll under it.
  describe("delivered by the notice ring", () => {
    const gets = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST").length;
    const notice = () => act(() => { window.dispatchEvent(new Event(POWER_APPROVAL_EVENT)); });
    beforeEach(() => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ pending: null }), { status: 200 }));
    });
    afterEach(() => vi.useRealTimers());

    it("puts a request raised elsewhere on screen at the ring's word, with no timer involved", async () => {
      render(<PowerApprovalPrompt />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(gets()).toBe(1);
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      // The agent asked for a restart; the ring says so.
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ pending: { ...prompt, expiresAt: Date.now() + 120000 } }), { status: 200 }));
      notice();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(gets()).toBe(2);
      expect(screen.getByText(prompt.reason)).toBeInTheDocument();
    });

    it("takes a request answered elsewhere — another desktop, Telegram — or run out off the screen", async () => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ pending: prompt }), { status: 200 }));
      render(<PowerApprovalPrompt />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText(prompt.reason)).toBeInTheDocument();
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ pending: null }), { status: 200 }));
      notice();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      // Nothing was posted from here: taking the question down is not an answer.
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    });

    it("asks again for a notice that arrived while an answer was already on its way", async () => {
      // That answer may predate what the notice is about (the request was raised
      // just after the server answered), so dropping the notice would leave the
      // prompt off screen until the safety poll.
      let release: (r: Response) => void = () => {};
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
      render(<PowerApprovalPrompt />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(gets()).toBe(1);
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ pending: { ...prompt, expiresAt: Date.now() + 120000 } }), { status: 200 }));
      notice();
      notice();
      expect(gets()).toBe(1);
      await act(async () => { release(new Response(JSON.stringify({ pending: null }), { status: 200 })); await vi.advanceTimersByTimeAsync(0); });
      // Once more, not once per notice.
      expect(gets()).toBe(2);
      expect(screen.getByText(prompt.reason)).toBeInTheDocument();
    });

    it("keeps only a slow safety poll: once a minute, not every 5 s", async () => {
      render(<PowerApprovalPrompt />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(gets()).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
      expect(gets()).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(gets()).toBe(2);
    });

    it("stops listening when it unmounts", async () => {
      const { unmount } = render(<PowerApprovalPrompt />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      unmount();
      notice();
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(gets()).toBe(1);
    });
  });

  // A desktop nobody can see (a phone's tab in the background) does not run
  // the safety poll for a prompt it cannot show; a tick that fell due while
  // away is asked the moment the page is visible again, so a request raised
  // meanwhile is on screen as soon as the owner is (and the ring, which keeps
  // reading behind a hidden tab, usually has it there already).
  describe("while the page is hidden", () => {
    let visibility: DocumentVisibilityState = "visible";
    const gets = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST").length;
    const setVisibility = (next: DocumentVisibilityState) => {
      visibility = next;
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    };
    beforeEach(() => {
      vi.useFakeTimers();
      visibility = "visible";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ pending: null }), { status: 200 }));
    });
    afterEach(() => {
      vi.useRealTimers();
      // jsdom's own getter is on Document.prototype; the instance override goes.
      delete (document as unknown as Record<string, unknown>).visibilityState;
    });

    it("asks nothing, and asks at once on the visible edge", async () => {
      render(<PowerApprovalPrompt />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(gets()).toBe(1);
      setVisibility("hidden");
      await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
      expect(gets()).toBe(1);
      // A restart was requested while the owner was away.
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ pending: { ...prompt, expiresAt: Date.now() + 120000 } }), { status: 200 }));
      setVisibility("visible");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(gets()).toBe(2);
      expect(screen.getByText(prompt.reason)).toBeInTheDocument();
    });

    it("a trip away no tick fell due in asks nothing extra", async () => {
      render(<PowerApprovalPrompt />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      setVisibility("hidden");
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      setVisibility("visible");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(gets()).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
      expect(gets()).toBe(2);
    });

    it("still answers the ring's word behind a hidden tab", async () => {
      // The ring keeps reading while hidden (its events expire), so the
      // prompt's state is right the moment the page is back.
      render(<PowerApprovalPrompt />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      setVisibility("hidden");
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ pending: { ...prompt, expiresAt: Date.now() + 120000 } }), { status: 200 }));
      act(() => { window.dispatchEvent(new Event(POWER_APPROVAL_EVENT)); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(gets()).toBe(2);
      expect(screen.getByText(prompt.reason)).toBeInTheDocument();
    });
  });
});
