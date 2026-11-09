import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import WeeklyUpdateCheckCard from "@/components/WeeklyUpdateCheckCard";

/**
 * Settings → System Update → Weekly update check (TASK-2260): the switch
 * reflects the box (on by default), a click saves the opposite and shows what
 * the box answered, and a failed save says so instead of pretending.
 */
describe("WeeklyUpdateCheckCard", () => {
  const fetchMock = vi.fn();
  const next = new Date(2026, 10, 16, 10, 23).getTime();
  let serverEnabled = true;

  beforeEach(() => {
    serverEnabled = true;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") serverEnabled = JSON.parse(String(init.body)).enabled;
      return new Response(JSON.stringify({
        enabled: serverEnabled,
        nextCheckAt: serverEnabled ? next : null,
        lastNotified: { version: "4.3.1", at: new Date(2026, 10, 9, 10, 5).getTime(), via: "telegram" },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the switch ON by default, when the box looks next and what it last announced", async () => {
    render(<WeeklyUpdateCheckCard />);
    const toggle = await screen.findByRole("switch", { name: "Check for updates every week" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("weekly-update-check-status").textContent).toContain("Next check:");
    expect(screen.getByText(/Last told you about 4\.3\.1/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/update/weekly-check", { cache: "no-store" });
  });

  it("switches it off with one click and says what off means", async () => {
    render(<WeeklyUpdateCheckCard />);
    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1].body)).toEqual({ enabled: false });
    expect(screen.getByText("Off: the box does not look for updates on its own.")).toBeInTheDocument();
    expect(screen.queryByText(/Next check:/)).not.toBeInTheDocument();
  });

  it("says a save failed, and keeps the switch where the box has it", async () => {
    render(<WeeklyUpdateCheckCard />);
    const toggle = await screen.findByRole("switch");
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "Only the box owner can do this.", code: "owner_only" }), { status: 403 }));
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("The setting could not be saved. Try again.");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("stays out of the way when the box cannot say what the switch is", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
    const { container } = render(<WeeklyUpdateCheckCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='weekly-update-check']")).toBeNull();
  });
});
