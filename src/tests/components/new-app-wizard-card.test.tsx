/**
 * The New app card's popover behaviour.
 *
 * The card has two hosts with opposite expectations. On the Coding Agent's
 * home page it is part of the page: a stray click elsewhere must not throw
 * away what was typed. In the mascot chat it floats over the composer, and
 * there anything that opens over your work is expected to close when you click
 * away. One prop separates them, so neither host has to re-implement it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import NewAppWizardCard, { lastRunLabel, lastRunSummary } from "@/components/NewAppWizardCard";
import { translations } from "@/lib/translations";
import { buildResumeProjectPrompt, buildTeamProjectPrompt, CHAT_MESSAGE_EVENT } from "@/lib/ui-events";

describe("NewAppWizardCard", () => {
  it("ignores an outside click by default — the page host must not lose typed text", () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button" data-testid="outside">elsewhere</button>
        <NewAppWizardCard onClose={onClose} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on an outside click when the host asks for popover behaviour", () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button" data-testid="outside">elsewhere</button>
        <NewAppWizardCard onClose={onClose} closeOnOutsideClick />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open for a click INSIDE it", () => {
    const onClose = vi.fn();
    render(<NewAppWizardCard onClose={onClose} closeOnOutsideClick />);
    fireEvent.pointerDown(screen.getByTestId("coding-agent-new-name"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape — the other half of what a popover owes the keyboard", () => {
    const onClose = vi.fn();
    render(<NewAppWizardCard onClose={onClose} closeOnOutsideClick />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted", () => {
    const onClose = vi.fn();
    const { unmount } = render(<NewAppWizardCard onClose={onClose} closeOnOutsideClick />);
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * The card's second mode: an existing project and what its next run should
 * do, composed as a message that tells the assistant how to RESUME it.
 */
describe("NewAppWizardCard — an existing project", () => {
  const PROJECTS = [
    { folder: "shop", directory: "/home/clawbox/Projects/shop", kind: "folder", name: "shop", lastCommit: null, onDesktop: false,
      latestRun: { id: "run-1", status: "completed", task: "Build the customer list\nwith search", startedAt: 1, completedAt: 2 } },
    { folder: "invoices", directory: "/home/clawbox/clawbox/data/code-projects/invoices", kind: "codeProject", name: "Invoices", lastCommit: null, onDesktop: true, latestRun: null },
  ];

  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists the owner's projects, and hands the chat a message that resumes the chosen one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200, headers: { "content-type": "application/json" } })));
    const heard: string[] = [];
    const onChatMessage = (e: Event) => heard.push(String((e as CustomEvent<{ text?: string }>).detail?.text ?? ""));
    window.addEventListener(CHAT_MESSAGE_EVENT, onChatMessage);
    const onClose = vi.fn();
    try {
      render(<NewAppWizardCard onClose={onClose} />);
      fireEvent.click(screen.getByTestId("coding-agent-new-mode-existing"));
      const select = await screen.findByTestId("coding-agent-new-project");
      await waitFor(() => expect(select).not.toBeDisabled());
      fireEvent.change(select, { target: { value: "/home/clawbox/clawbox/data/code-projects/invoices" } });
      fireEvent.change(screen.getByTestId("coding-agent-new-next"), { target: { value: "Add a PDF export." } });
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard).toEqual([buildResumeProjectPrompt({
        name: "Invoices", directory: "/home/clawbox/clawbox/data/code-projects/invoices", kind: "codeProject", folder: "invoices",
        instructions: "Add a PDF export.", latestRun: null,
      })]);
      expect(heard[0]).toContain("coding_agent_run");
      expect(heard[0]).toContain("code_project_build");
      expect(heard[0]).not.toContain("Create a new ClawBox app");
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, onChatMessage);
    }
  });

  it("opens on a project the Coding Agent handed over, with the team switch on, and asks for a coding TEAM", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200, headers: { "content-type": "application/json" } })));
    const heard: string[] = [];
    const onChatMessage = (e: Event) => heard.push(String((e as CustomEvent<{ text?: string }>).detail?.text ?? ""));
    window.addEventListener(CHAT_MESSAGE_EVENT, onChatMessage);
    try {
      render(<NewAppWizardCard onClose={() => {}} initialProject="/home/clawbox/Projects/shop" initialTeam />);
      // The existing-project mode, already on the project, the switch on.
      const select = await screen.findByTestId("coding-agent-new-project");
      await waitFor(() => expect(select).not.toBeDisabled());
      expect((select as HTMLSelectElement).value).toBe("/home/clawbox/Projects/shop");
      expect(screen.getByTestId("coding-agent-new-team")).toBeChecked();
      fireEvent.change(screen.getByTestId("coding-agent-new-next"), { target: { value: "Add invoices with PDF export." } });
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard).toEqual([buildTeamProjectPrompt({
        name: "shop", directory: "/home/clawbox/Projects/shop", kind: "folder", folder: "shop", instructions: "Add invoices with PDF export.",
      })]);
      expect(heard[0]).toContain("coding_team_run");
      expect(heard[0]).toContain('directory "/home/clawbox/Projects/shop"');
      expect(heard[0]).not.toContain("coding_agent_run");
      // The switch off again: the plain resume message.
      fireEvent.click(screen.getByTestId("coding-agent-new-team"));
      expect(screen.getByTestId("coding-agent-new-team")).not.toBeChecked();
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, onChatMessage);
    }
  });

  it("sends on Enter in the instruction, keeps Shift+Enter as a new line, and leaves a composition alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200, headers: { "content-type": "application/json" } })));
    const onMessage = vi.fn();
    window.addEventListener(CHAT_MESSAGE_EVENT, onMessage);
    try {
      render(<NewAppWizardCard onClose={() => {}} initialProject="/home/clawbox/Projects/shop" />);
      const next = await screen.findByTestId("coding-agent-new-next");
      await waitFor(() => expect(screen.getByTestId("coding-agent-new-project")).not.toBeDisabled());
      fireEvent.change(next, { target: { value: "Add a footer" } });
      fireEvent.keyDown(next, { key: "Enter", shiftKey: true });
      expect(onMessage).not.toHaveBeenCalled();
      fireEvent.keyDown(next, { key: "Enter", isComposing: true });
      expect(onMessage).not.toHaveBeenCalled();
      fireEvent.keyDown(next, { key: "Enter" });
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect((onMessage.mock.calls[0][0] as CustomEvent<{ text: string }>).detail.text).toContain("Add a footer");
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, onMessage);
    }
  });

  it("shows the chosen project's last run, and refuses to continue without a project or an instruction", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ projects: PROJECTS }), { status: 200, headers: { "content-type": "application/json" } })));
    render(<NewAppWizardCard onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("coding-agent-new-mode-existing"));
    const select = await screen.findByTestId("coding-agent-new-project");
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("coding-agent-new-create"));
    expect(screen.getByTestId("coding-agent-new-error")).toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-new-last-run")).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "/home/clawbox/Projects/shop" } });
    // The line exists only once a project with a run is chosen; the words
    // come through the i18n provider, absent in this render.
    expect(screen.getByTestId("coding-agent-new-last-run")).toBeInTheDocument();
    expect((select as HTMLSelectElement).value).toBe("/home/clawbox/Projects/shop");
    fireEvent.click(screen.getByTestId("coding-agent-new-create"));
    expect(screen.getByTestId("coding-agent-new-error")).toBeInTheDocument();
  });

  // The note used to be a hard 120-character slice: "…in THIS pass and quote
  // the" stopped mid-sentence with nothing to say it had been cut.
  it("ends a cut last-run summary with an ellipsis and leaves a short one whole", () => {
    const long = "Automatic review pass. Start by running the project's own verification — its tests or build — in THIS pass and quote the output you saw.";
    const cut = lastRunSummary(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(121);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    // No trailing space left in front of the ellipsis.
    expect(cut).not.toContain(" …");
    expect(lastRunSummary("Add a PDF export.")).toBe("Add a PDF export.");
    expect(lastRunSummary("Build the customer list\nwith search")).toBe("Build the customer list");
  });

  // "Last run: Automatic review pass. Start by running the project's own
  // verification — its tests or build — in THIS pass and quote the" — the
  // first 120 characters of REVIEW_PASS_TASK, because a review pass's `task`
  // IS that prompt. The sidebar, the run page and the breadcrumb all name it
  // "Automatic review pass of run-…" from one key; so does this line now.
  it("names a review pass the way every other surface does, not by its internal prompt", () => {
    const t = (key: string, params?: Record<string, string | number>) => {
      let str = translations.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    };
    const reviewTask = "Automatic review pass. Start by running the project's own verification — its tests or build — in THIS pass and quote the output you saw.";
    expect(lastRunLabel({ task: reviewTask, reviewOf: "run-gywqvpbg" }, t)).toBe("Automatic review pass of run-gywqvpbg");
    // Every other run still reads by its own first line.
    expect(lastRunLabel({ task: "Build the customer list\nwith search", reviewOf: null }, t)).toBe("Build the customer list");
    expect(lastRunLabel({ task: "# Paginate the inventory API", reviewOf: null }, t)).toBe("Paginate the inventory API");
    expect(lastRunLabel({ task: reviewTask, reviewOf: null }, t)).toContain("…");
  });

  // A native select clips its selected option at the control's edge; without
  // `text-overflow` the label simply stopped mid-word ("…TypeScript (def").
  it("lets a clipped select label end in an ellipsis", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200, headers: { "content-type": "application/json" } })));
    render(<NewAppWizardCard onClose={() => {}} />);
    expect(screen.getByTestId("coding-agent-new-template").className).toContain("text-ellipsis");
    fireEvent.click(screen.getByTestId("coding-agent-new-mode-existing"));
    expect((await screen.findByTestId("coding-agent-new-project")).className).toContain("text-ellipsis");
  });
});
