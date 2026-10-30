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
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import NewAppWizardCard, { lastRunLabel, lastRunSummary } from "@/components/NewAppWizardCard";
import { translations } from "@/lib/translations";
import { buildNewAppPrompt, buildResumeProjectPrompt, buildTeamProjectPrompt, CHAT_MESSAGE_EVENT, ultracodeSentence } from "@/lib/ui-events";

// The two toggles remember the owner's last choice per browser; no case may inherit another's.
afterEach(() => { try { window.localStorage.clear(); } catch { /* unavailable */ } });

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

  it("stops the Escape at the document, so the chat's own Escape never sees it", () => {
    // The chat closes on Escape from a WINDOW listener. A guard there on "is
    // the card open" cannot hold in a browser, which flushes this close between
    // the two listeners; the key has to stop here (the UI sweep of 2026-09-07).
    const onClose = vi.fn();
    const reachedWindow = vi.fn();
    window.addEventListener("keydown", reachedWindow);
    try {
      render(<NewAppWizardCard onClose={onClose} closeOnOutsideClick />);
      fireEvent.keyDown(document.body, { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", reachedWindow);
    }
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(reachedWindow).not.toHaveBeenCalled();
  });

  it("hands focus back to what opened it when Escape closes it", async () => {
    // The card takes focus for itself (the name input's autoFocus) and
    // unmounts on close; without this a keyboard user landed on <body>, with
    // the composer and the + button behind Tab from the top of the document.
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>+</button>
          {open && <NewAppWizardCard onClose={() => setOpen(false)} closeOnOutsideClick />}
        </div>
      );
    }
    render(<Host />);
    const opener = screen.getByTestId("opener");
    opener.focus();
    fireEvent.click(opener);
    const name = await screen.findByTestId("coding-agent-new-name");
    expect(document.activeElement).toBe(name);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("coding-agent-new-name")).toBeNull());
    expect(document.activeElement).toBe(opener);
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

/**
 * The two toggles (2026-10-30): "Run as a coding team" and "Ultracode", as
 * switch rows above the buttons in BOTH modes, off by default, each
 * remembered in localStorage, and what each does to the message.
 */
describe("NewAppWizardCard — the two toggles", () => {
  const PROJECTS = [
    { folder: "shop", directory: "/home/clawbox/Projects/shop", kind: "folder", name: "shop", lastCommit: null, onDesktop: false, latestRun: null },
  ];
  afterEach(() => { vi.unstubAllGlobals(); });

  function listen(): { heard: string[]; stop: () => void } {
    const heard: string[] = [];
    const onChatMessage = (e: Event) => heard.push(String((e as CustomEvent<{ text?: string }>).detail?.text ?? ""));
    window.addEventListener(CHAT_MESSAGE_EVENT, onChatMessage);
    return { heard, stop: () => window.removeEventListener(CHAT_MESSAGE_EVENT, onChatMessage) };
  }

  it("shows both switches in the NEW mode, off, as role=switch buttons, above the buttons", () => {
    render(<NewAppWizardCard onClose={() => {}} />);
    const team = screen.getByTestId("coding-agent-new-team");
    const ultra = screen.getByTestId("coding-agent-new-ultracode");
    for (const sw of [team, ultra]) {
      expect(sw.tagName).toBe("BUTTON");
      expect(sw).toHaveAttribute("role", "switch");
      expect(sw).not.toBeChecked();
    }
    // Directly above the Cancel/Create row: the toggles come before the buttons in the form.
    const toggles = screen.getByTestId("coding-agent-new-toggles");
    expect(toggles.compareDocumentPosition(screen.getByTestId("coding-agent-new-create")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggles.compareDocumentPosition(screen.getByTestId("coding-agent-new-what")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // The old checkbox is gone.
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("shows both switches in the EXISTING mode too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200, headers: { "content-type": "application/json" } })));
    render(<NewAppWizardCard onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("coding-agent-new-mode-existing"));
    await screen.findByTestId("coding-agent-new-project");
    expect(screen.getByTestId("coding-agent-new-team")).not.toBeChecked();
    expect(screen.getByTestId("coding-agent-new-ultracode")).not.toBeChecked();
  });

  it("sends a NEW app to a coding team when the team switch is on, and says Start a team", () => {
    const { heard, stop } = listen();
    try {
      render(<NewAppWizardCard onClose={() => {}} />);
      fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Shop" } });
      fireEvent.change(screen.getByTestId("coding-agent-new-what"), { target: { value: "An invoice generator" } });
      const submit = screen.getByTestId("coding-agent-new-create");
      // No i18n provider here: the button reads its key, which is enough to tell the three apart.
      expect(submit.textContent).toContain("newCreate");
      fireEvent.click(screen.getByTestId("coding-agent-new-team"));
      expect(screen.getByTestId("coding-agent-new-team")).toBeChecked();
      expect(submit.textContent).toContain("newStartTeam");
      fireEvent.click(submit);
      expect(heard).toEqual([buildNewAppPrompt({ name: "Shop", description: "An invoice generator", template: "nextjs" }, { team: true })]);
      expect(heard[0]).toContain("coding_team_run");
      expect(heard[0]).not.toContain("ultracode");
    } finally {
      stop();
    }
  });

  it("ends the message with the ultracode sentence when that switch is on — a new app and an existing project alike", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200, headers: { "content-type": "application/json" } })));
    const { heard, stop } = listen();
    try {
      const first = render(<NewAppWizardCard onClose={() => {}} />);
      fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Shop" } });
      fireEvent.change(screen.getByTestId("coding-agent-new-what"), { target: { value: "An invoice generator" } });
      fireEvent.click(screen.getByTestId("coding-agent-new-ultracode"));
      expect(screen.getByTestId("coding-agent-new-ultracode")).toBeChecked();
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard[0]).toBe(buildNewAppPrompt({ name: "Shop", description: "An invoice generator", template: "nextjs" }, { ultracode: true }));
      expect(heard[0].endsWith(ultracodeSentence("coding_agent_run"))).toBe(true);
      first.unmount();

      // The choice is remembered: the next card opens with Ultracode on, and
      // with the team switch on too the sentence names coding_team_run.
      render(<NewAppWizardCard onClose={() => {}} initialProject="/home/clawbox/Projects/shop" initialTeam />);
      const select = await screen.findByTestId("coding-agent-new-project");
      await waitFor(() => expect(select).not.toBeDisabled());
      expect(screen.getByTestId("coding-agent-new-ultracode")).toBeChecked();
      expect(screen.getByTestId("coding-agent-new-team")).toBeChecked();
      fireEvent.change(screen.getByTestId("coding-agent-new-next"), { target: { value: "Add invoices." } });
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard[1]).toBe(buildTeamProjectPrompt({ name: "shop", directory: "/home/clawbox/Projects/shop", kind: "folder", folder: "shop", instructions: "Add invoices." }, { ultracode: true }));
      expect(heard[1].endsWith(ultracodeSentence("coding_team_run"))).toBe(true);
    } finally {
      stop();
    }
  });

  it("remembers each switch as the owner last left it, and reads a blocked storage as off", () => {
    const first = render(<NewAppWizardCard onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("coding-agent-new-team"));
    first.unmount();
    const second = render(<NewAppWizardCard onClose={() => {}} />);
    expect(screen.getByTestId("coding-agent-new-team")).toBeChecked();
    expect(screen.getByTestId("coding-agent-new-ultracode")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("coding-agent-new-team"));
    second.unmount();
    const third = render(<NewAppWizardCard onClose={() => {}} />);
    expect(screen.getByTestId("coding-agent-new-team")).not.toBeChecked();
    expect(window.localStorage.getItem("clawbox:create-card:team")).toBe("0");
    third.unmount();
    cleanupStorage();
    // A storage that throws (a private window, blocked site data): the card still renders, both off.
    const broken = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      render(<NewAppWizardCard onClose={() => {}} />);
      expect(screen.getByTestId("coding-agent-new-team")).not.toBeChecked();
      expect(screen.getByTestId("coding-agent-new-ultracode")).not.toBeChecked();
    } finally {
      broken.mockRestore();
    }
  });
});

function cleanupStorage() {
  try { window.localStorage.clear(); } catch { /* unavailable */ }
}
