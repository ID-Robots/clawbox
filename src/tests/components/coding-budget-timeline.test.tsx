/**
 * A budgeted run's or team's time on its page (src/components/CodingBudgetTimeline.tsx):
 * the bar from the work's start to the deadline with the safety margin shaded,
 * the estimate markers, elapsed / remaining / deadline in the box's zone, the
 * spend beside the time, the extra work and what was left out, and the
 * checkpoints of the time record — and nothing at all without a budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/tests/helpers/test-utils";

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const { translations } = await import("@/lib/translations");
  const t = (key: string, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), translations.en[key] ?? key);
  return { ...actual, useT: () => ({ locale: "en", localeResolved: true, setLocale: () => {}, t }) };
});

import CodingBudgetTimeline, { formatSpan, readBudgetTimeline } from "@/components/CodingBudgetTimeline";
import type { TimeBudget, TimeRecord } from "@/lib/coding-time-budget";

const MIN = 60_000;
/** Wed 14 Oct 2026, 15:00 UTC — 18:00 in Sofia (EEST). */
const T0 = Date.UTC(2026, 9, 14, 15, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const SOFIA = "Europe/Sofia";

/** One hour, from T0: the safety margin is its 10-minute floor, so the cutoff is at 50 minutes. */
const HOUR_BUDGET: TimeBudget = { deadline: iso(T0 + 60 * MIN), label: "1 hour", preset: "1h", source: "picker", setAt: iso(T0), tokenCap: 100_000 };

const rec = (offsetMin: number, kind: TimeRecord["kind"], text: string, extra: Partial<TimeRecord> = {}): TimeRecord => ({ at: iso(T0 + offsetMin * MIN), kind, text, ...extra });

const RECORD = {
  budget: HOUR_BUDGET,
  estimateMs: 45 * MIN,
  tasks: [
    { taskId: "t1", estimateMs: 30 * MIN, actualMs: 36 * MIN },
    { taskId: "t2", estimateMs: 15 * MIN, actualMs: null },
  ],
  startedAt: iso(T0),
  finishedAt: null,
  usedMs: 40 * MIN,
  leftMs: null,
  stopReason: null,
  tokenCap: 100_000,
  tokensUsed: 42_000,
  extras: ["tests: covered the parser"],
  skipped: ["t3 (does not fit before the cutoff: Polish styles.css)"],
  records: [
    rec(0, "budget", "Budget: 1 hour"),
    rec(1, "plan", "2 tasks planned", { estimateMs: 45 * MIN }),
    rec(2, "start", "Scaffold", { taskId: "t1" }),
    rec(10, "note", "Checkpoint: 10 minutes used, 50 minutes left", { tokensUsed: 9_000 }),
    rec(38, "finish", "The worker ended completed", { taskId: "t1", actualMs: 36 * MIN }),
    rec(39, "note", "Re-plan: t1 took 36 minutes against ~30 minutes (+20%)"),
  ],
  omittedRecords: 3,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 + 40 * MIN);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CodingBudgetTimeline", () => {
  it("draws nothing for a run or team without a budget", () => {
    const { container } = render(<CodingBudgetTimeline budget={undefined} live />);
    expect(container).toBeEmptyDOMElement();
    expect(readBudgetTimeline({ deadline: "soon" }, null)).toBeNull();
  });

  it("shows the bar to the deadline, the margin, the estimates, the figures in the box's zone and the spend", () => {
    render(<CodingBudgetTimeline budget={HOUR_BUDGET} record={RECORD} live timeZone={SOFIA} testId="tl" />);
    expect(screen.getByTestId("tl-label")).toHaveTextContent("1 hour");
    expect(screen.getByTestId("tl-status")).toHaveTextContent("Working");
    // 40 of 60 minutes gone; the margin shaded from the 50th.
    expect(screen.getByTestId("tl-fill").style.width).toMatch(/^66\.66/);
    expect(screen.getByTestId("tl-margin").style.left).toMatch(/^83\.33/);
    expect(screen.getByTestId("tl-elapsed")).toHaveTextContent("40 min");
    expect(screen.getByTestId("tl-remaining")).toHaveTextContent("20 min");
    // 16:00 UTC is 19:00 in Sofia.
    expect(screen.getByTestId("tl-deadline")).toHaveTextContent("Wed 14 Oct, 19:00");
    expect(screen.getByTestId("tl-zone")).toHaveTextContent("Safety margin from Wed 14 Oct, 18:50 · Europe/Sofia");
    expect(screen.getByTestId("tl-spend")).toHaveTextContent("42,000 of 100,000 tokens used");
    // The whole work's estimate at 45 of 60 minutes, and each task's where it would end laid end to end.
    expect(screen.getByTestId("tl-estimate").style.left).toBe("75%");
    expect(screen.getAllByTestId("tl-task-estimate").map((m) => m.style.left)).toEqual(["50%", "75%"]);
    expect(screen.getAllByTestId("tl-task-estimate")[0]).toHaveAttribute("title", "t1: about 30 min");
    // How the estimates held so far: the one task finished.
    expect(screen.getByTestId("tl-accuracy")).toHaveTextContent("Estimated 30 min, took 36 min");
    expect(screen.getByTestId("tl-extras")).toHaveTextContent("tests: covered the parser");
    expect(screen.getByTestId("tl-skipped")).toHaveTextContent("t3 (does not fit before the cutoff: Polish styles.css)");
    // Markers on the bar for the checkpoint and the finish the record noted — and a legend that says what each is.
    expect(screen.getAllByTestId("tl-mark")).toHaveLength(2);
    expect([...screen.getByTestId("tl-legend").querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Estimate", "Safety margin", "Checkpoint", "Finish"]);
  });

  it("names the estimate marks in the legend when only the tasks' estimates are drawn", () => {
    render(<CodingBudgetTimeline budget={HOUR_BUDGET} record={{ ...RECORD, estimateMs: null }} live timeZone={SOFIA} testId="tl" />);
    expect(screen.queryByTestId("tl-estimate")).toBeNull();
    expect(screen.getAllByTestId("tl-task-estimate")).toHaveLength(2);
    expect([...screen.getByTestId("tl-legend").querySelectorAll("li")].map((li) => li.textContent)).toContain("Estimate");
  });

  it("lists the checkpoints with the time used and left at each, and says how many older ones are in the file", () => {
    render(<CodingBudgetTimeline budget={HOUR_BUDGET} record={RECORD} live timeZone={SOFIA} testId="tl" />);
    const list = screen.getByTestId("tl-checkpoints");
    expect(list).toHaveTextContent("Checkpoints (6)");
    fireEvent.click(within(list).getByText("Checkpoints (6)"));
    const rows = screen.getAllByTestId("tl-row");
    expect(rows).toHaveLength(6);
    expect(rows[3]).toHaveTextContent("Checkpoint");
    expect(rows[3]).toHaveTextContent("10 min in, 50 min left");
    expect(rows[3]).toHaveTextContent("Checkpoint: 10 minutes used, 50 minutes left");
    expect(rows[4]).toHaveTextContent("t1 · The worker ended completed");
    expect(list).toHaveTextContent("3 older entries are in the time record file.");
  });

  it("says why the work stopped, and what it overran, once the record is closed", () => {
    vi.setSystemTime(T0 + 90 * MIN);
    const closed = { ...RECORD, finishedAt: iso(T0 + 65 * MIN), stopReason: "time", records: [...RECORD.records, rec(65, "stop", "the deadline came", { reason: "time" })] };
    render(<CodingBudgetTimeline budget={HOUR_BUDGET} record={closed} live={false} timeZone={SOFIA} testId="tl" />);
    expect(screen.getByTestId("tl-status")).toHaveTextContent("Stopped at the deadline");
    expect(screen.getByTestId("tl-elapsed")).toHaveTextContent("1 hr 5 min");
    expect(screen.getByTestId("tl-remaining")).toHaveTextContent("5 min");
    expect(screen.getByText("Past the deadline")).toBeInTheDocument();
    expect(screen.getByTestId("tl-fill").style.width).toBe("100%");
    // The bar in the chip's colour: amber for the box's own stop, not the green of work done.
    expect(screen.getByTestId("tl-fill").style.background).toBe("rgb(252, 211, 77)");
    expect(screen.getByTestId("tl-legend")).toHaveTextContent("Stop");
  });

  it("shows a budget whose record is not written yet, with the run's own token count", () => {
    vi.setSystemTime(T0 + 5 * MIN);
    render(<CodingBudgetTimeline budget={{ ...HOUR_BUDGET, tokenCap: undefined }} live tokensUsed={1234} timeZone={SOFIA} testId="tl" />);
    expect(screen.getByTestId("tl-spend")).toHaveTextContent("1,234 tokens used");
    expect(screen.queryByTestId("tl-checkpoints")).toBeNull();
    expect(screen.queryByTestId("tl-estimate")).toBeNull();
  });
});

describe("formatSpan", () => {
  it("says minutes, hours and days in the UI's language", () => {
    expect(formatSpan(42 * MIN, "en")).toBe("42 min");
    expect(formatSpan(90 * MIN, "en")).toBe("1 hr 30 min");
    expect(formatSpan(120 * MIN, "en")).toBe("2 hr");
    expect(formatSpan(26 * 60 * MIN, "en")).toBe("1 day 2 hr");
    expect(formatSpan(42 * MIN, "de")).toBe("42 Min.");
  });
});
