import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import PowerApprovalPrompt from "@/components/PowerApprovalPrompt";

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
    expect(screen.getByRole("button", { name: "chat.approval.deny" })).toHaveFocus();
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

});
