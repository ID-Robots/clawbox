/**
 * The Create planner (src/components/NewAppWizardCard.tsx).
 *
 * Since 2026-11-01 it is a window of its own (PopoutWindow, which owns Escape
 * and focus — src/tests/components/popout-window.test.tsx), so it is no longer
 * a popover: a press outside it never closes it. Pinned here: the two modes
 * and the messages they hand the chat, the switches, and the planner's own
 * editing — lists, sections, the plan check, pictures and the draft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import NewAppWizardCard, { lastRunLabel, lastRunSummary, PLANNER_DRAFT_KEY } from "@/components/NewAppWizardCard";
import { translations } from "@/lib/translations";
import { buildNewAppPrompt, buildResumeProjectPrompt, buildTeamProjectPrompt, CHAT_MESSAGE_EVENT, PLAN_FIRST_SENTENCE, ultracodeSentence } from "@/lib/ui-events";

// The switches and the draft are remembered per browser; no case may inherit
// another's. Before each case too: the planner writes its draft as it unmounts,
// and the render cleanup can run after this file's afterEach.
const clearStorage = () => { try { window.localStorage.clear(); } catch { /* unavailable */ } };
beforeEach(clearStorage);
afterEach(clearStorage);

function listenToChat(): { heard: string[]; stop: () => void } {
  const heard: string[] = [];
  const onChatMessage = (e: Event) => heard.push(String((e as CustomEvent<{ text?: string }>).detail?.text ?? ""));
  window.addEventListener(CHAT_MESSAGE_EVENT, onChatMessage);
  return { heard, stop: () => window.removeEventListener(CHAT_MESSAGE_EVENT, onChatMessage) };
}

describe("NewAppWizardCard", () => {
  it("is not a popover any more: a press outside it never closes it", () => {
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

  it("starts on the name for a new app", () => {
    render(<NewAppWizardCard onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByTestId("coding-agent-new-name"));
  });

  it("creates on Ctrl+Enter, and keeps a plain Enter as a new line", () => {
    const { heard, stop } = listenToChat();
    try {
      render(<NewAppWizardCard onClose={() => {}} />);
      fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Shop" } });
      const brief = screen.getByTestId("coding-agent-new-what");
      fireEvent.change(brief, { target: { value: "An invoice generator" } });
      fireEvent.keyDown(brief, { key: "Enter" });
      fireEvent.keyDown(brief, { key: "Enter", ctrlKey: true, isComposing: true });
      expect(heard).toEqual([]);
      fireEvent.keyDown(brief, { key: "Enter", ctrlKey: true });
      expect(heard).toEqual([buildNewAppPrompt({ name: "Shop", description: "An invoice generator", template: "nextjs" })]);
    } finally {
      stop();
    }
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
describe("NewAppWizardCard — the switches", () => {
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

  it("shows the switches in the NEW mode, off, as role=switch buttons, before the buttons", () => {
    render(<NewAppWizardCard onClose={() => {}} />);
    const team = screen.getByTestId("coding-agent-new-team");
    const ultra = screen.getByTestId("coding-agent-new-ultracode");
    const planFirst = screen.getByTestId("coding-agent-new-plan-first");
    for (const sw of [team, ultra, planFirst]) {
      expect(sw.tagName).toBe("BUTTON");
      expect(sw).toHaveAttribute("role", "switch");
      expect(sw).not.toBeChecked();
    }
    // In the side panel after the brief, before the Cancel/Create row.
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

/**
 * The planner proper: the editor's keys and toolbar, the sections and the
 * plan check, pictures, the "plan first" switch, and the draft.
 */
describe("NewAppWizardCard — the planner", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  const brief = () => screen.getByTestId("coding-agent-new-what") as HTMLTextAreaElement;
  const type = (value: string, caret = value.length) => {
    fireEvent.change(brief(), { target: { value } });
    brief().setSelectionRange(caret, caret);
  };

  it("continues a list on Enter, numbers the next item, and ends the list on an empty one", () => {
    render(<NewAppWizardCard onClose={() => {}} />);
    type("- Login");
    fireEvent.keyDown(brief(), { key: "Enter" });
    expect(brief().value).toBe("- Login\n- ");
    type("1. Read");
    fireEvent.keyDown(brief(), { key: "Enter" });
    expect(brief().value).toBe("1. Read\n2. ");
    type("- [x] Ship");
    fireEvent.keyDown(brief(), { key: "Enter" });
    expect(brief().value).toBe("- [x] Ship\n- [ ] ");
    type("- a\n- ");
    fireEvent.keyDown(brief(), { key: "Enter" });
    expect(brief().value).toBe("- a\n");
  });

  it("indents a list item on Tab and takes it back on Shift+Tab", () => {
    render(<NewAppWizardCard onClose={() => {}} />);
    type("- one");
    fireEvent.keyDown(brief(), { key: "Tab" });
    expect(brief().value).toBe("  - one");
    fireEvent.keyDown(brief(), { key: "Tab", shiftKey: true });
    expect(brief().value).toBe("- one");
  });

  it("turns the line into a checklist from the toolbar, and wraps a selection in bold", () => {
    render(<NewAppWizardCard onClose={() => {}} />);
    type("Export a PDF");
    fireEvent.click(screen.getByTestId("coding-agent-planner-tool-check"));
    expect(brief().value).toBe("- [ ] Export a PDF");
    type("make it fast");
    brief().setSelectionRange(8, 12);
    fireEvent.click(screen.getByTestId("coding-agent-planner-tool-bold"));
    expect(brief().value).toBe("make it **fast**");
  });

  it("inserts a section from the menu, and the plan check follows the brief", () => {
    render(<NewAppWizardCard onClose={() => {}} />);
    const check = (id: string) => screen.getByTestId(`coding-agent-planner-check-${id}`);
    expect(check("goal")).toHaveAttribute("data-ok", "false");
    expect(screen.getByTestId("coding-agent-planner-score").textContent).toBe("0/3");
    type("An invoice generator for a small shop that keeps its customers.");
    fireEvent.click(screen.getByTestId("coding-agent-planner-sections"));
    fireEvent.click(screen.getByTestId("coding-agent-planner-section-features"));
    expect(brief().value).toBe("An invoice generator for a small shop that keeps its customers.\n\n## codingAgent.planner.sectionFeatures\n- ");
    expect(screen.queryByTestId("coding-agent-planner-sections-menu")).toBeNull();
    type(`${brief().value}Customers\n- Invoices`);
    // An open check is a shortcut to its section.
    fireEvent.click(check("done"));
    type(`${brief().value}It exports a PDF`);
    expect(check("goal")).toHaveAttribute("data-ok", "true");
    expect(check("features")).toHaveAttribute("data-ok", "true");
    expect(check("done")).toHaveAttribute("data-ok", "true");
    expect(screen.getByTestId("coding-agent-planner-score").textContent).toBe("3/3");
  });

  it("previews the brief as Markdown", () => {
    render(<NewAppWizardCard onClose={() => {}} />);
    type("## Features\n- Search");
    fireEvent.click(screen.getByTestId("coding-agent-planner-view-preview"));
    const preview = screen.getByTestId("coding-agent-planner-preview");
    expect(preview.querySelector("h2")?.textContent).toBe("Features");
    expect(brief()).not.toBeVisible();
  });

  it("stages a pasted picture, shows it as a thumbnail, names it in the brief, and hands its path to the run", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "plan-1.png", path: "/home/clawbox/.openclaw/media/chat/plan-1.png" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { heard, stop } = listenToChat();
    try {
      render(<NewAppWizardCard onClose={() => {}} />);
      fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Shop" } });
      type("Like this:");
      const file = new File(["png"], "image.png", { type: "image/png" });
      fireEvent.paste(brief(), { clipboardData: { files: [file], types: ["Files"] } });
      expect(brief().value).toBe("Like this: [image 1] ");
      await waitFor(() => expect(within(screen.getByTestId("coding-agent-planner-images")).getAllByTestId("coding-agent-planner-image")).toHaveLength(1));
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/chat/attachments", expect.objectContaining({ method: "POST" }));
      await waitFor(() => expect(screen.getByTestId("coding-agent-new-create")).not.toBeDisabled());
      expect(screen.getByTestId("coding-agent-planner-check-references")).toHaveAttribute("data-ok", "true");
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard).toHaveLength(1);
      expect(heard[0]).toContain("Like this: [image 1]");
      expect(heard[0]).toContain("- [image 1]: /home/clawbox/.openclaw/media/chat/plan-1.png");
      expect(heard[0]).toContain("input_files");
    } finally {
      stop();
    }
  });

  it("takes a removed picture out of the brief and renumbers the rest", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { n += 1; return new Response(JSON.stringify({ path: `/m/p${n}.png` }), { status: 200 }); }));
    render(<NewAppWizardCard onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("coding-agent-planner-file"), { target: { files: [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.png", { type: "image/png" })] } });
    expect(brief().value).toBe("[image 1] [image 2] ");
    await waitFor(() => expect(screen.getAllByTestId("coding-agent-planner-image")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("coding-agent-planner-image-remove")[0]);
    expect(screen.getAllByTestId("coding-agent-planner-image")).toHaveLength(1);
    expect(brief().value).toBe("[image 1] ");
  });

  it("refuses a file that is not a picture, and drops a picture the box would not stage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 413 })));
    render(<NewAppWizardCard onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("coding-agent-planner-file"), { target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    expect(screen.getByTestId("coding-agent-new-error").textContent).toBe("codingAgent.planner.imageOnly");
    fireEvent.change(screen.getByTestId("coding-agent-planner-file"), { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.queryByTestId("coding-agent-planner-image")).toBeNull());
    expect(screen.getByTestId("coding-agent-new-error").textContent).toBe("codingAgent.planner.imageFailed");
    expect(brief().value).toBe("");
  });

  it("refuses a picture too big to stage before it makes a thumbnail or a token", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<NewAppWizardCard onClose={() => {}} />);
    const huge = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: 26 * 1024 * 1024 });
    fireEvent.change(screen.getByTestId("coding-agent-planner-file"), { target: { files: [huge] } });
    expect(screen.queryByTestId("coding-agent-planner-image")).toBeNull();
    expect(brief().value).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("coding-agent-new-error").textContent).toBe("codingAgent.planner.imageFailed");
    expect(screen.getByTestId("coding-agent-new-create")).not.toBeDisabled();
  });

  it("writes the last keystrokes on the way out, even inside the draft's debounce", () => {
    const first = render(<NewAppWizardCard onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Quick" } });
    type("typed and closed at once");
    first.unmount();
    expect(window.localStorage.getItem(PLANNER_DRAFT_KEY)).toContain("typed and closed at once");
    // Opened and closed with nothing changed: nothing is written.
    window.localStorage.clear();
    render(<NewAppWizardCard onClose={() => {}} />).unmount();
    expect(window.localStorage.getItem(PLANNER_DRAFT_KEY)).toBeNull();
  });

  it("asks for the plan first when that switch is on", () => {
    const { heard, stop } = listenToChat();
    try {
      render(<NewAppWizardCard onClose={() => {}} />);
      fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Shop" } });
      type("An invoice generator");
      fireEvent.click(screen.getByTestId("coding-agent-new-plan-first"));
      expect(screen.getByTestId("coding-agent-new-create").textContent).toContain("askForPlan");
      fireEvent.click(screen.getByTestId("coding-agent-new-create"));
      expect(heard[0].endsWith(PLAN_FIRST_SENTENCE)).toBe(true);
      expect(window.localStorage.getItem("clawbox:create-card:plan-first")).toBe("1");
    } finally {
      stop();
    }
  });

  it("keeps a draft as the owner types, brings it back, and forgets it once the plan is handed over", async () => {
    const first = render(<NewAppWizardCard onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Shop" } });
    type("- Customers\n- Invoices");
    await waitFor(() => expect(window.localStorage.getItem(PLANNER_DRAFT_KEY)).toContain("Invoices"));
    expect(screen.getByTestId("coding-agent-planner-saved")).toBeInTheDocument();
    first.unmount();

    render(<NewAppWizardCard onClose={() => {}} />);
    expect((screen.getByTestId("coding-agent-new-name") as HTMLInputElement).value).toBe("Shop");
    expect(brief().value).toBe("- Customers\n- Invoices");
    fireEvent.click(screen.getByTestId("coding-agent-new-create"));
    expect(window.localStorage.getItem(PLANNER_DRAFT_KEY)).toBeNull();
  });

  it("clears everything only on a second press", () => {
    render(<NewAppWizardCard onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Shop" } });
    type("Something");
    const clear = screen.getByTestId("coding-agent-planner-clear");
    fireEvent.click(clear);
    expect(brief().value).toBe("Something");
    expect(clear.textContent).toBe("codingAgent.planner.clearConfirm");
    fireEvent.click(clear);
    expect(brief().value).toBe("");
    expect((screen.getByTestId("coding-agent-new-name") as HTMLInputElement).value).toBe("");
  });

  it("refuses a brief over the run's ceiling and says so", () => {
    render(<NewAppWizardCard onClose={() => {}} maxTaskChars={10} />);
    fireEvent.change(screen.getByTestId("coding-agent-new-name"), { target: { value: "Shop" } });
    type("far more than ten characters");
    fireEvent.click(screen.getByTestId("coding-agent-new-create"));
    expect(screen.getByTestId("coding-agent-new-error").textContent).toBe("codingAgent.newWhatTooLong");
  });
});

function cleanupStorage() {
  try { window.localStorage.clear(); } catch { /* unavailable */ }
}
