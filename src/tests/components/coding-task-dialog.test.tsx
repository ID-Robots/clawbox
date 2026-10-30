/**
 * The whole-task dialog (src/components/CodingTaskDialog.tsx): the rest of a
 * run's task, opened from the run page's "Show the whole task" and rendered as
 * Markdown in a modal of its own.
 *
 * It replaced a `<details>` that unfolded raw text into the header card. What
 * is pinned: the task is drawn as elements (a heading, a list), not as one
 * pre-wrapped string; Escape, the X and the backdrop all close it; Copy puts
 * the task text — not the rendered page — on the clipboard.
 *
 * Since 2026-10-30 the dialog also lists the files the run was GIVEN (the
 * "Inputs for this run" card the page used to draw): the folder is named even
 * when a run was given nothing, a refusal is worded from the catalogue, and a
 * record from before the hand-over existed says nothing about inputs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingTaskDialog from "@/components/CodingTaskDialog";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const TASK = "Add a dark mode toggle\n\n## What is left\n\n1. Read the settings page\n2. Add the switch\n\nUse `prefers-color-scheme` as the default.";

const DIR = "/srv/clawbox/data/coding-agent-inputs/run-k3x9q2ab";
const SHARED = "/srv/clawbox/data/coding-agent-inputs/shared";

let onClose: () => void;

beforeEach(() => {
  onClose = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CodingTaskDialog", () => {
  it("draws the task as Markdown under the run's title, in a dialog named by it", () => {
    render(<CodingTaskDialog title="Add a dark mode toggle" task={TASK} runId="run-k3x9q2ab" onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Add a dark mode toggle");
    expect(screen.getByText(t("codingAgent.taskDialogTitle"))).toBeInTheDocument();
    expect(screen.getByText("run-k3x9q2ab")).toBeInTheDocument();
    const body = screen.getByTestId("coding-agent-task-dialog-body");
    // Elements, not a pre-wrapped string: the heading is a heading, the
    // numbered steps are rows with their markers (the chat's renderer draws a
    // list as marker + text rows), and the code span is code.
    expect(body.querySelector("h2")?.textContent).toBe("What is left");
    expect(within(body).getByText("1.")).toBeInTheDocument();
    expect(within(body).getByText("2.")).toBeInTheDocument();
    expect(within(body).getByText("Add the switch")).toBeInTheDocument();
    expect(body.querySelector("code")?.textContent).toBe("prefers-color-scheme");
  });

  it("closes on the X, on the backdrop and on Escape", () => {
    render(<CodingTaskDialog title="t" task={TASK} runId="run-1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId("coding-agent-task-dialog-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("coding-agent-task-dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
    // A click inside the panel is not a dismissal.
    fireEvent.click(screen.getByTestId("coding-agent-task-dialog-body"));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("lists what the run was given and names both folders", () => {
    render(<CodingTaskDialog title="t" task={TASK} runId="run-1" inputs={{ dir: DIR, shared: SHARED, files: [{ name: "chart.png", bytes: 2048 }] }} onClose={onClose} />);
    const card = screen.getByTestId("coding-agent-inputs");
    expect(card).toHaveTextContent(t("codingAgent.inputsTitle"));
    expect(card).toHaveTextContent("chart.png");
    expect(card).toHaveTextContent(DIR);
    expect(card).toHaveTextContent(SHARED);
    expect(screen.queryByTestId("coding-agent-inputs-empty")).toBeNull();
    // Copy still puts the TASK on the clipboard, not the file list.
    expect(screen.getByTestId("coding-agent-task-dialog-body").textContent).toContain("Add the switch");
  });

  it("words a refusal from the catalogue, and says nothing at all for a code it does not know", () => {
    render(
      <CodingTaskDialog
        title="t"
        task={TASK}
        runId="run-1"
        inputs={{ dir: DIR, shared: SHARED, files: [], refused: [{ name: "key.png", code: "outside_roots" }, { name: "later.png", code: "something_new" }] }}
        onClose={onClose}
      />,
    );
    const refused = screen.getByTestId("coding-agent-inputs-refused");
    expect(refused).toHaveTextContent(t("codingAgent.inputsRefusedLocation"));
    expect(refused).toHaveTextContent("later.png");
    expect(refused).not.toHaveTextContent("something_new");
    // Nothing handed over, but the folder is still the answer to "where do I put it".
    expect(screen.getByTestId("coding-agent-inputs-empty")).toHaveTextContent(t("codingAgent.inputsEmpty"));
    expect(screen.getByTestId("coding-agent-inputs")).toHaveTextContent(DIR);
  });

  it("says nothing about inputs for a record written before the hand-over existed, or one given and refused nothing", () => {
    const { unmount } = render(<CodingTaskDialog title="t" task={TASK} runId="run-1" inputs={null} onClose={onClose} />);
    expect(screen.queryByTestId("coding-agent-inputs")).toBeNull();
    unmount();
    render(<CodingTaskDialog title="t" task={TASK} runId="run-1" inputs={{ dir: DIR, shared: SHARED, files: [] }} onClose={onClose} />);
    expect(screen.queryByTestId("coding-agent-inputs")).toBeNull();
  });

  it("copies the task text itself, and says so", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CodingTaskDialog title="t" task={TASK} runId="run-1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId("coding-agent-task-dialog-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TASK));
    expect(await screen.findByText(t("codingAgent.copied"))).toBeInTheDocument();
  });
});
