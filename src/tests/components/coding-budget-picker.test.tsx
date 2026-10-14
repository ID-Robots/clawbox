/**
 * The Create App card's time-budget picker (src/components/CodingBudgetPicker.tsx):
 * chips, an explicit no-limit, and a calendar popover built in-house — what
 * each comes to on the BOX's clock and zone, the refusals the routes would
 * make, the keyboard and aria contract, and the line the card's message gains.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";

// The real English copy with its {placeholders} filled, so the preview is
// asserted as the owner reads it (the bare fallback answers keys).
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const { translations } = await import("@/lib/translations");
  const t = (key: string, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), translations.en[key] ?? key);
  return { ...actual, useT: () => ({ locale: "en", localeResolved: true, setLocale: () => {}, t }) };
});

import CodingBudgetPicker, {
  budgetPickerOutcome,
  customPickProblem,
  readTokenCapInput,
  type BudgetPickerOutcome,
} from "@/components/CodingBudgetPicker";
import NewAppWizardCard from "@/components/NewAppWizardCard";
import { CHAT_MESSAGE_EVENT } from "@/lib/ui-events";

/** Wed 14 Oct 2026, 12:00 UTC — 15:00 in Sofia (EEST). */
const NOW = Date.UTC(2026, 9, 14, 12, 0);
const SOFIA = "Europe/Sofia";

function stubStatus(body: unknown = { timeZone: SOFIA, defaultTimeBudget: null }, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPicker(props: Partial<Parameters<typeof CodingBudgetPicker>[0]> = {}) {
  const seen: BudgetPickerOutcome[] = [];
  const onChange = vi.fn((o: BudgetPickerOutcome) => { seen.push(o); });
  const utils = render(<CodingBudgetPicker onChange={onChange} {...props} />);
  return { ...utils, onChange, seen, last: () => seen[seen.length - 1] };
}

const radio = (name: string) => screen.getByTestId(`coding-budget-chip-${name}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the picker's rules — the routes' own", () => {
  it("refuses a past end, one more than 14 days away, under 5 minutes, or a start after the end", () => {
    expect(customPickProblem("2026-10-14T18:00", null, NOW, SOFIA)).toBeNull();
    expect(customPickProblem("2026-10-14T14:00", null, NOW, SOFIA)).toBe("past");
    expect(customPickProblem("2026-10-14T15:03", null, NOW, SOFIA)).toBe("tooShort");
    expect(customPickProblem("2026-10-29T15:00", null, NOW, SOFIA)).toBe("tooFar");
    expect(customPickProblem("2026-10-14T18:00", "2026-10-14T19:00", NOW, SOFIA)).toBe("startAfterEnd");
    expect(customPickProblem("2026-10-14T18:00", "2026-10-14T17:58", NOW, SOFIA)).toBe("tooShort");
    expect(customPickProblem("not a time", null, NOW, SOFIA)).toBe("unreadable");
    // A wall-clock end is read in the zone given: 15:30 is three and a half
    // hours ahead on a UTC box, 11:30 already behind it.
    expect(customPickProblem("2026-10-14T15:30", null, NOW, "UTC")).toBeNull();
    expect(customPickProblem("2026-10-14T11:30", null, NOW, "UTC")).toBe("past");
  });

  it("reads a typed token ceiling with digit grouping, and refuses one under 10,000", () => {
    expect(readTokenCapInput("")).toBeNull();
    expect(readTokenCapInput("500 000")).toBe(500_000);
    expect(readTokenCapInput("500,000")).toBe(500_000);
    expect(readTokenCapInput("9999")).toBe("invalid");
    expect(readTokenCapInput("12k")).toBe("invalid");
  });

  it("sends no ceiling with no limit, and none at all without a pick", () => {
    expect(budgetPickerOutcome({ pick: null, tokenCap: "50000" }, NOW, SOFIA)).toEqual({ token: null, tokenCap: null, error: null });
    expect(budgetPickerOutcome({ pick: { kind: "none" }, tokenCap: "50000" }, NOW, SOFIA)).toEqual({ token: "none", tokenCap: null, error: null });
    expect(budgetPickerOutcome({ pick: { kind: "chip", chip: "1d" }, tokenCap: "50000" }, NOW, SOFIA)).toEqual({ token: "1d", tokenCap: 50_000, error: null });
    expect(budgetPickerOutcome({ pick: { kind: "custom", end: "2026-10-14T18:00", start: "2026-10-14T16:00" }, tokenCap: "" }, NOW, SOFIA))
      .toEqual({ token: "2026-10-14T16:00/2026-10-14T18:00", tokenCap: null, error: null });
  });
});

describe("CodingBudgetPicker", () => {
  it("is a radio group of the four chips, no limit and the calendar — nothing picked, nothing reported", async () => {
    const fetchMock = stubStatus();
    const { onChange } = renderPicker();
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAccessibleName("Time budget");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["30 minutes", "1 hour", "Until tomorrow morning", "1 day", "No limit", "Pick…"]);
    expect(radios.every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    // Tab lands on the first chip only.
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    expect(screen.getByTestId("coding-budget-preview")).toHaveTextContent("Not set: a time the task itself names applies, otherwise there is no limit.");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/setup-api/coding-agent/status", { cache: "no-store" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("previews a chip's deadline on the box's clock and zone, and says a long one starts a team", async () => {
    stubStatus();
    const { last } = renderPicker();
    fireEvent.click(radio("1h"));
    expect(radio("1h")).toHaveAttribute("aria-checked", "true");
    expect(last()).toEqual({ token: "1h", tokenCap: null, error: null });
    // Sofia is UTC+3 in October: 13:00 UTC is 16:00 on the box.
    await waitFor(() => expect(screen.getByTestId("coding-budget-zone")).toHaveTextContent("Box time: Europe/Sofia"));
    expect(screen.getByTestId("coding-budget-deadline")).toHaveTextContent("Ends Wed 14 Oct, 16:00 — in 60 minutes.");
    expect(screen.getByTestId("coding-budget-team-hint")).toHaveTextContent("Over 30 minutes");

    fireEvent.click(radio("30m"));
    expect(last()).toEqual({ token: "30m", tokenCap: null, error: null });
    expect(screen.queryByTestId("coding-budget-team-hint")).toBeNull();

    fireEvent.click(radio("morning"));
    expect(screen.getByTestId("coding-budget-deadline")).toHaveTextContent("Ends Thu 15 Oct, 08:00");
  });

  it("does not say a long budget starts a team when the card asks for a team anyway", async () => {
    stubStatus();
    renderPicker({ team: true });
    fireEvent.click(radio("1d"));
    expect(screen.getByTestId("coding-budget-deadline")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-budget-team-hint")).toBeNull();
  });

  it("falls back to UTC when the status route cannot say the zone", async () => {
    const fetchMock = stubStatus([{ not: "a status" }]);
    renderPicker();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(radio("1h"));
    expect(screen.getByTestId("coding-budget-zone")).toHaveTextContent("Box time: UTC");
    expect(screen.getByTestId("coding-budget-deadline")).toHaveTextContent("Ends Wed 14 Oct, 13:00");
  });

  it("reads nothing itself when the host passes the box's zone and default — one status read per open", () => {
    const fetchMock = stubStatus();
    renderPicker({ timeZone: SOFIA, defaultBudget: "1d" });
    expect(screen.getByTestId("coding-budget-preview")).toHaveTextContent("otherwise your default — 1 day.");
    fireEvent.click(radio("1h"));
    expect(screen.getByTestId("coding-budget-zone")).toHaveTextContent("Box time: Europe/Sofia");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows UTC, and still reads nothing, while the host's own read is out", () => {
    const fetchMock = stubStatus();
    renderPicker({ timeZone: null, defaultBudget: null });
    fireEvent.click(radio("1h"));
    expect(screen.getByTestId("coding-budget-zone")).toHaveTextContent("Box time: UTC");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the owner's default when nothing is picked", async () => {
    stubStatus({ timeZone: SOFIA, defaultTimeBudget: "1h" });
    renderPicker();
    await waitFor(() => expect(screen.getByTestId("coding-budget-preview")).toHaveTextContent("otherwise your default — 1 hour."));
  });

  it("moves and checks with the arrow keys, the radio pattern, but only focuses the calendar chip", () => {
    stubStatus();
    const { last } = renderPicker();
    radio("30m").focus();
    fireEvent.keyDown(radio("30m"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(radio("1h"));
    expect(last()).toMatchObject({ token: "1h" });
    expect(radio("1h").tabIndex).toBe(0);
    expect(radio("30m").tabIndex).toBe(-1);
    fireEvent.keyDown(radio("1h"), { key: "End" });
    expect(document.activeElement).toBe(radio("pick"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(last()).toMatchObject({ token: "1h" });
    fireEvent.keyDown(radio("pick"), { key: "ArrowLeft" });
    expect(last()).toEqual({ token: "none", tokenCap: null, error: null });
    expect(screen.getByTestId("coding-budget-preview")).toHaveTextContent("No time limit");
    // No ceiling field for no limit.
    expect(screen.queryByTestId("coding-budget-token-cap")).toBeNull();
  });

  it("takes an optional token ceiling, and refuses one under the floor", () => {
    stubStatus();
    const { last } = renderPicker();
    fireEvent.click(radio("1d"));
    const cap = screen.getByTestId("coding-budget-token-cap");
    expect(cap).toHaveAccessibleName("Token ceiling (optional)");
    fireEvent.change(cap, { target: { value: "5000" } });
    expect(last()).toEqual({ token: "1d", tokenCap: null, error: "tokenCap" });
    expect(cap).toHaveAttribute("aria-invalid", "true");
    expect(cap).toHaveAccessibleDescription("A token ceiling is a whole number of at least 10,000 tokens.");
    fireEvent.change(cap, { target: { value: "500 000" } });
    expect(last()).toEqual({ token: "1d", tokenCap: 500_000, error: null });
  });

  it("clears back to nothing picked", () => {
    stubStatus();
    const { last } = renderPicker();
    fireEvent.click(radio("1h"));
    fireEvent.click(screen.getByTestId("coding-budget-clear"));
    expect(last()).toEqual({ token: null, tokenCap: null, error: null });
    expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(document.activeElement).toBe(radio("30m"));
  });
});

describe("the calendar popover", () => {
  async function openCalendar() {
    stubStatus();
    const picker = renderPicker();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    // Let the zone land before the calendar opens on today's date.
    fireEvent.click(radio("1h"));
    await waitFor(() => expect(screen.getByTestId("coding-budget-zone")).toHaveTextContent(SOFIA));
    fireEvent.click(radio("pick"));
    return picker;
  }

  it("opens as a labelled dialog on today, 18:00 box time, with focus on the chosen day", async () => {
    await openCalendar();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("When must the work stop?");
    expect(radio("pick")).toHaveAttribute("aria-expanded", "true");
    expect(radio("pick")).toHaveAttribute("aria-controls", dialog.id);
    expect(screen.getByTestId("coding-budget-month")).toHaveTextContent("October 2026");
    const today = screen.getByTestId("coding-budget-day-2026-10-14");
    expect(today).toHaveAttribute("aria-pressed", "true");
    expect(today).toHaveAttribute("aria-current", "date");
    expect(today).toHaveAccessibleName("Wednesday, October 14, 2026");
    expect(document.activeElement).toBe(today);
    expect(screen.getByTestId("coding-budget-time")).toHaveValue("18:00");
    expect(screen.getByTestId("coding-budget-draft-preview")).toHaveTextContent("Ends Wed 14 Oct, 18:00 — in 3 hours.");
    // Days before today and after the 14-day limit cannot be picked.
    expect(screen.getByTestId("coding-budget-day-2026-10-13")).toBeDisabled();
    expect(screen.getByTestId("coding-budget-day-2026-10-28")).toBeEnabled();
    expect(screen.getByTestId("coding-budget-day-2026-10-29")).toBeDisabled();
    expect(screen.getByTestId("coding-budget-prev-month")).toBeDisabled();
    expect(screen.getByTestId("coding-budget-next-month")).toBeDisabled();
  });

  it("applies the picked end as a box-local token and words the chip with it", async () => {
    const { last } = await openCalendar();
    fireEvent.click(screen.getByTestId("coding-budget-day-2026-10-16"));
    fireEvent.change(screen.getByTestId("coding-budget-time"), { target: { value: "09:30" } });
    fireEvent.click(screen.getByTestId("coding-budget-apply"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(last()).toEqual({ token: "2026-10-16T09:30", tokenCap: null, error: null });
    expect(radio("pick")).toHaveAttribute("aria-checked", "true");
    expect(radio("pick")).toHaveTextContent("Until Fri 16 Oct, 09:30");
    expect(document.activeElement).toBe(radio("pick"));
    expect(screen.getByTestId("coding-budget-deadline")).toHaveTextContent("Ends Fri 16 Oct, 09:30 — in 2 days.");
  });

  it("refuses a past time, more than 14 days and under 5 minutes before it can be applied", async () => {
    await openCalendar();
    const time = screen.getByTestId("coding-budget-time");
    fireEvent.change(time, { target: { value: "14:00" } });
    expect(screen.getByTestId("coding-budget-draft-preview")).toHaveTextContent("That time has already passed.");
    expect(screen.getByTestId("coding-budget-apply")).toBeDisabled();
    fireEvent.change(time, { target: { value: "15:02" } });
    expect(screen.getByTestId("coding-budget-draft-preview")).toHaveTextContent("at least 5 minutes long");
    fireEvent.click(screen.getByTestId("coding-budget-day-2026-10-28"));
    fireEvent.change(time, { target: { value: "18:00" } });
    expect(screen.getByTestId("coding-budget-draft-preview")).toHaveTextContent("at most 14 days");
    expect(screen.getByTestId("coding-budget-apply")).toBeDisabled();
  });

  it("takes an optional start, which must come before the end", async () => {
    const { last } = await openCalendar();
    fireEvent.click(screen.getByTestId("coding-budget-start-toggle"));
    const start = screen.getByTestId("coding-budget-start");
    fireEvent.change(start, { target: { value: "2026-10-14T19:00" } });
    expect(screen.getByTestId("coding-budget-draft-preview")).toHaveTextContent("The start must be before the end.");
    fireEvent.change(start, { target: { value: "2026-10-14T16:00" } });
    fireEvent.click(screen.getByTestId("coding-budget-apply"));
    expect(last()).toEqual({ token: "2026-10-14T16:00/2026-10-14T18:00", tokenCap: null, error: null });
    expect(screen.getByTestId("coding-budget-preview")).toHaveTextContent("Starts Wed 14 Oct, 16:00.");
  });

  it("moves the day with the arrow keys, inside the days that can be picked", async () => {
    await openCalendar();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("coding-budget-day-2026-10-15"));
    expect(screen.getByTestId("coding-budget-day-2026-10-15")).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("coding-budget-day-2026-10-22"));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    // Clamped to the last day a budget may end on.
    expect(document.activeElement).toBe(screen.getByTestId("coding-budget-day-2026-10-28"));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("coding-budget-day-2026-10-14"));
  });

  it("applies on Enter in the time field instead of submitting the form around it", async () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    stubStatus();
    const seen: BudgetPickerOutcome[] = [];
    render(
      <form onSubmit={(e) => onSubmit(e.nativeEvent)}>
        <CodingBudgetPicker onChange={(o) => seen.push(o)} timeZone={SOFIA} />
        <button type="submit">go</button>
      </form>,
    );
    fireEvent.click(radio("pick"));
    fireEvent.keyDown(screen.getByTestId("coding-budget-time"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(seen[seen.length - 1]).toEqual({ token: "2026-10-14T18:00", tokenCap: null, error: null });
  });

  it("closes on Escape without applying, hands focus back, and stops the key there", async () => {
    const { last } = await openCalendar();
    const reachedDocument = vi.fn();
    document.addEventListener("keydown", reachedDocument);
    try {
      fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", reachedDocument);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reachedDocument).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(radio("pick"));
    expect(last()).toMatchObject({ token: "1h" });
  });

  it("closes on a click outside it, without applying", async () => {
    const { last } = await openCalendar();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(last()).toMatchObject({ token: "1h" });
  });

  it("reads the box's clock from the status answer, not the browser's", async () => {
    // The box is an hour ahead of this browser: 16:30 box time is already past.
    stubStatus({ timeZone: SOFIA }, { date: new Date(NOW + 3_600_000).toUTCString() });
    renderPicker({ initialValue: { pick: { kind: "custom", end: "2026-10-14T15:30", start: null }, tokenCap: "" } });
    await waitFor(() => expect(screen.getByTestId("coding-budget-preview")).toHaveTextContent("That time has already passed."));
  });
});

describe("the Create App card with a budget", () => {
  function listen() {
    const heard: string[] = [];
    const onMessage = (e: Event) => heard.push(String((e as CustomEvent<{ text?: string }>).detail?.text ?? ""));
    window.addEventListener(CHAT_MESSAGE_EVENT, onMessage);
    return { heard, stop: () => window.removeEventListener(CHAT_MESSAGE_EVENT, onMessage) };
  }

  it("asks the assistant to pass the picked budget and ceiling to coding_agent_run", async () => {
    stubStatus();
    const { heard, stop } = listen();
    try {
      render(<NewAppWizardCard onClose={() => {}} />);
      fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Timer" } });
      fireEvent.change(screen.getByTestId("coding-agent-new-what"), { target: { value: "A kitchen timer" } });
      fireEvent.click(radio("morning"));
      fireEvent.change(screen.getByTestId("coding-budget-token-cap"), { target: { value: "200000" } });
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard).toHaveLength(1);
      expect(heard[0]).toContain('pass budget: "morning" and budget_token_cap: 200000 to coding_agent_run');
    } finally {
      stop();
    }
  });

  it("sends the message unchanged when nothing is picked", () => {
    stubStatus();
    const { heard, stop } = listen();
    try {
      render(<NewAppWizardCard onClose={() => {}} />);
      fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Timer" } });
      fireEvent.change(screen.getByTestId("coding-agent-new-what"), { target: { value: "A kitchen timer" } });
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard).toHaveLength(1);
      expect(heard[0]).not.toMatch(/budget/i);
    } finally {
      stop();
    }
  });

  it("will not send a budget the box would refuse", () => {
    stubStatus();
    const { heard, stop } = listen();
    const onClose = vi.fn();
    try {
      render(<NewAppWizardCard onClose={onClose} />);
      fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Timer" } });
      fireEvent.change(screen.getByTestId("coding-agent-new-what"), { target: { value: "A kitchen timer" } });
      fireEvent.click(radio("1h"));
      fireEvent.change(screen.getByTestId("coding-budget-token-cap"), { target: { value: "12" } });
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("coding-agent-new-error")).toHaveTextContent("Fix the time budget first.");
    } finally {
      stop();
    }
  });

  it("keeps the card open when Escape closes only the calendar", () => {
    stubStatus();
    const onClose = vi.fn();
    render(<NewAppWizardCard onClose={onClose} closeOnOutsideClick />);
    fireEvent.click(radio("pick"));
    fireEvent.pointerDown(screen.getByTestId("coding-budget-day-2026-10-15"));
    fireEvent.click(screen.getByTestId("coding-budget-day-2026-10-15"));
    fireEvent.keyDown(screen.getByTestId("coding-budget-day-2026-10-15"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // The next Escape is the card's.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks a team's message for the budget on coding_team_run, without the team hint", async () => {
    const PROJECTS = [{ folder: "shop", directory: "/home/clawbox/Projects/shop", kind: "folder", name: "shop", latestRun: null }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(
      JSON.stringify(String(url).includes("/projects") ? PROJECTS : { timeZone: SOFIA }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const { heard, stop } = listen();
    try {
      render(<NewAppWizardCard onClose={() => {}} initialProject="/home/clawbox/Projects/shop" initialTeam />);
      const select = await screen.findByTestId("coding-agent-new-project");
      await waitFor(() => expect(select).not.toBeDisabled());
      fireEvent.change(screen.getByTestId("coding-agent-new-next"), { target: { value: "Add invoices" } });
      fireEvent.click(radio("1d"));
      expect(screen.queryByTestId("coding-budget-team-hint")).toBeNull();
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard).toHaveLength(1);
      expect(heard[0]).toContain('pass budget: "1d" to coding_team_run');
    } finally {
      stop();
    }
  });
});
