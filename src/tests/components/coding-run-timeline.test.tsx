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

  it("words the live step too — it is the one drawn in full", () => {
    pack = PACK;
    draw(true);
    const steps = screen.getAllByTestId("coding-agent-run-activity-step");
    expect(steps.at(-1)?.textContent).toContain("Beendet: Fertig");
    expect(steps.at(-1)?.textContent).not.toContain("Finished: completed");
  });
});
