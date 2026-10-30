/**
 * The run page's timeline (src/components/CodingRunTimeline.tsx).
 *
 * Its steps come from the runner, which writes them in English: a German
 * desktop read "Started with deepseek-v4-pro[1m]", "Thinking…" and "Automatic
 * review pass of run-gywqvpbg" between chips that were properly translated
 * ("Liest store.ts"). Each of those lines now carries a key
 * (coding-agent-progress.ts), and this pins that the card asks for the key and
 * fills its placeholders — and that a box whose locale pack predates the key
 * still reads as English rather than as "codingAgent.stepStarted".
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/tests/helpers/test-utils";
import { RUNNER_STEP } from "@/lib/coding-agent-progress";

/** The strings under test, in a language nobody can mistake for the source. */
const PACK: Record<string, string> = {
  "codingAgent.timelineTitle": "Zeitleiste",
  "codingAgent.stepStartedWith": "Gestartet mit {model}",
  "codingAgent.stepThinking": "Denkt nach …",
  "codingAgent.reviewPassTitle": "Automatische Überprüfung von {id}",
  "codingAgent.stepCommitted": "Als {sha} committet",
  "codingAgent.stepFinished": "Beendet: {status}",
  "codingAgent.statusCompleted": "Fertig",
  "codingAgent.stepSubagentStarted": "Unteragent gestartet",
  "codingAgent.stepDropped": "{count} frühere Schritte sind nicht aufbewahrt",
  "codingAgent.stepWhen": "Wann",
  "codingAgent.stepKind": "Art",
  "codingAgent.stepLine": "Zeile",
  "codingAgent.stepKind.text": "Meldung",
};

let pack: Record<string, string> = PACK;
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    locale: "de",
    t: (key: string, params?: Record<string, string | number>) => {
      let str = pack[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

// Imported after the mock so the component picks it up.
const { default: CodingRunTimeline } = await import("@/components/CodingRunTimeline");

const LINES = [
  RUNNER_STEP.started("deepseek-v4-pro[1m]"),
  RUNNER_STEP.reviewPass("run-gywqvpbg"),
  RUNNER_STEP.thinking,
  RUNNER_STEP.dropped(41),
  RUNNER_STEP.helperStarted({ workflow: false, type: "explorer", what: "find the tests" }),
  "Read src/store.ts",
  RUNNER_STEP.committed("4f21ab9", false),
  RUNNER_STEP.finished("completed"),
];
const TIMES = LINES.map((_, i) => 1_000 + i * 1_000);

function draw(live = false) {
  return render(<CodingRunTimeline lines={LINES} times={TIMES} startedAt={1_000} live={live} />);
}

describe("CodingRunTimeline", () => {
  it("words the runner's own steps in the owner's language, values and all", () => {
    pack = PACK;
    draw();
    const steps = screen.getAllByTestId("coding-agent-run-activity-step");
    const said = steps.map((s) => s.textContent ?? "");
    expect(said[0]).toContain("Gestartet mit deepseek-v4-pro[1m]");
    expect(said[1]).toContain("Automatische Überprüfung von run-gywqvpbg");
    expect(said[2]).toContain("Denkt nach …");
    expect(said[3]).toContain("41 frühere Schritte sind nicht aufbewahrt");
    // A helper's type and its own description are names, not words to translate.
    expect(said[4]).toContain("Unteragent gestartet");
    expect(said[4]).toContain("(explorer) find the tests");
    expect(said[6]).toContain("Als 4f21ab9 committet");
    // The status word too: the run's own chip already says it in German.
    expect(said[7]).toContain("Beendet: Fertig");
    // Nothing the runner wrote is left on screen.
    const all = said.join(" ");
    for (const english of ["Started with", "Automatic review pass", "Thinking", "Committed as", "Finished: completed"]) {
      expect(all, english).not.toContain(english);
    }
  });

  it("falls back to the runner's English for a pack that predates the keys — never the raw key", () => {
    pack = { "codingAgent.timelineTitle": "Zeitleiste" };
    draw();
    const all = screen.getAllByTestId("coding-agent-run-activity-step").map((s) => s.textContent ?? "").join(" ");
    expect(all).toContain("Started with deepseek-v4-pro[1m]");
    expect(all).toContain("Automatic review pass of run-gywqvpbg");
    expect(all).toContain("Finished: completed");
    expect(all).not.toContain("codingAgent.step");
  });

  it("keeps the keyed wording when a step is opened, and shows the raw line only in its detail", () => {
    pack = PACK;
    draw();
    const step = screen.getAllByTestId("coding-agent-run-activity-step")[0];
    fireEvent.click(step);
    expect(step.textContent).toContain("Gestartet mit deepseek-v4-pro[1m]");
    expect(step.textContent).not.toContain("Started with");
    const detail = screen.getByTestId("coding-agent-run-activity-detail");
    expect(within(detail).getByText(RUNNER_STEP.started("deepseek-v4-pro[1m]"))).toBeTruthy();
  });

  /**
   * Every row used to read "+8m 3s" from the run's start, so answering "what
   * time did it read the folder" meant adding minutes to a start time that is
   * elsewhere on the page. A log prints the clock; so does this. The distance
   * from the start is still kept, as the cell's title and spelled out in the
   * opened step.
   */
  it("reads the wall clock, 24-hour, with the elapsed behind it", () => {
    pack = PACK;
    draw();
    const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const cells = screen.getAllByTestId("coding-agent-run-activity-time");
    expect(cells).toHaveLength(LINES.length);
    expect(cells[0].textContent).toBe(clock(TIMES[0]));
    expect(cells[4].textContent).toBe(clock(TIMES[4]));
    // Four digits and two colons, never "+4s".
    expect(cells[4].textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    for (const cell of cells) expect(cell.textContent).not.toContain("+");
    // The machine-readable instant, and the elapsed as the secondary reading.
    expect(cells[4]).toHaveAttribute("datetime", new Date(TIMES[4]).toISOString());
    expect(cells[4]).toHaveAttribute("title", "+4s");
    expect(cells[0]).toHaveAttribute("title", "+0s");
  });

  it("spells both out when a step is opened — the clock, then how far into the run it was", () => {
    pack = PACK;
    draw();
    fireEvent.click(screen.getAllByTestId("coding-agent-run-activity-step")[3]);
    const detail = screen.getByTestId("coding-agent-run-activity-detail");
    const clock = new Date(TIMES[3]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    expect(detail.textContent).toContain(`${clock} · +3s`);
  });

  it("words the live step too — it is the one drawn in full", () => {
    pack = PACK;
    draw(true);
    const steps = screen.getAllByTestId("coding-agent-run-activity-step");
    expect(steps.at(-1)?.textContent).toContain("Beendet: Fertig");
    expect(steps.at(-1)?.textContent).not.toContain("Finished: completed");
  });
});

/**
 * The first step says what the run was started ON: the runner's line names
 * the model alone (and is frozen — runs on disk carry it), so the account and,
 * on a team, the role the model was chosen for come from the run's record.
 */
describe("the model a run started with, and its account", () => {
  const ON: Record<string, string> = {
    ...PACK,
    "codingAgent.stepStarted": "Gestartet",
    "codingAgent.stepStartedOn": "Gestartet bei {provider}",
    "codingAgent.stepStartedOnRole": "Gestartet bei {provider} ({role})",
    "codingAgent.stepStartedWithOn": "Gestartet mit {model} bei {provider}",
    "codingAgent.stepStartedWithRole": "Gestartet mit {model} bei {provider} ({role})",
    "codingAgent.providerName.anthropic": "Anthropic",
    "codingAgent.providerName.clawboxAi": "ClawBox AI",
    "codingAgent.modelRole.reviewer": "Prüfer",
    "codingAgent.modelRole.planner": "Planer",
  };
  const first = () => screen.getAllByTestId("coding-agent-run-activity-step")[0].textContent ?? "";

  it("names the model by its short name, with the account, on a solo run", () => {
    pack = ON;
    render(<CodingRunTimeline lines={[RUNNER_STEP.started("claude-fable-5-1"), RUNNER_STEP.thinking]} live={false} provider="anthropic" modelRole={null} />);
    expect(first()).toContain("Gestartet mit Fable 5.1 bei Anthropic");
    expect(first()).not.toContain("(");
  });

  it("adds the role the model was chosen for on a team run — a reviewer on the plan's flash tier", () => {
    pack = ON;
    render(<CodingRunTimeline lines={[RUNNER_STEP.started("deepseek-v4-flash")]} live={false} provider="clawbox-ai" modelRole="reviewer" />);
    expect(first()).toContain("Gestartet mit DeepSeek Flash bei ClawBox AI (Prüfer)");
    // The raw line is still the one behind the step.
    fireEvent.click(screen.getAllByTestId("coding-agent-run-activity-step")[0]);
    expect(within(screen.getByTestId("coding-agent-run-activity-detail")).getByText(RUNNER_STEP.started("deepseek-v4-flash"))).toBeTruthy();
  });

  it("says the account where the plan picked the model and the line names none", () => {
    pack = ON;
    render(<CodingRunTimeline lines={[RUNNER_STEP.started(null)]} live={false} provider="clawbox-ai" modelRole="planner" />);
    expect(first()).toContain("Gestartet bei ClawBox AI (Planer)");
  });

  it("keeps a model this build has no short name for as its id", () => {
    pack = ON;
    render(<CodingRunTimeline lines={[RUNNER_STEP.started("claude-next-9")]} live={false} provider="anthropic" />);
    expect(first()).toContain("Gestartet mit claude-next-9 bei Anthropic");
  });

  it("says no more than the line on a record from before the account was kept", () => {
    pack = ON;
    render(<CodingRunTimeline lines={[RUNNER_STEP.started("deepseek-v4-pro[1m]")]} live={false} />);
    expect(first()).toContain("Gestartet mit deepseek-v4-pro[1m]");
    expect(first()).not.toContain("bei");
  });
});
