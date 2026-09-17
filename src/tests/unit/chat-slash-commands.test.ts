import { describe, expect, it } from "vitest";
import {
  applySlashCommand,
  commandsFromHermesCatalog,
  commandsFromOpenClawList,
  filterSlashCommands,
  isSlashCommandMessage,
  isSlashCommand,
  slashQueryAt,
} from "@/lib/chat-slash-commands";

/**
 * The command SOURCE, per edition.
 *
 * Both fixtures are the harnesses' real wire shapes, not invented ones:
 *
 *  - the OpenClaw rows are trimmed from a live `commands.list` captured on the
 *    owner's box (core 2026.9.4, 73 entries), through the page's own
 *    authenticated gateway socket;
 *  - the Hermes rows are the documented `commands.catalog` result
 *    (`tui_gateway/methods_tools.py`) — `categories`, `pairs`, and the
 *    `commands` map whose `desktop` field is Hermes' own statement about which
 *    of its commands belong in a non-terminal composer.
 *
 * What is pinned here is that neither list is EDITED: the descriptions are the
 * harnesses' words, the order is the harnesses' order, and the only rows
 * dropped are the ones each harness itself says do not belong.
 */

const OPENCLAW_LIST = {
  commands: [
    {
      name: "help",
      textAliases: ["/help"],
      description: "Show available commands.",
      category: "status",
      source: "native",
      scope: "both",
      acceptsArgs: false,
    },
    {
      name: "status",
      textAliases: ["/status"],
      description: "Show current status.",
      category: "status",
      source: "native",
      scope: "both",
      // The real shape: acceptsArgs true with NO `args` metadata. 36 of the 73
      // commands on the owner's box look like this.
      acceptsArgs: true,
    },
    {
      name: "model",
      textAliases: ["/model"],
      description: "Show or set the model; use -s, -a, or -g to choose scope.",
      category: "options",
      source: "native",
      scope: "both",
      acceptsArgs: true,
      args: [{ name: "model", description: "Model id", type: "string", required: true }],
    },
    {
      name: "tools",
      textAliases: ["/tools"],
      description: "List available runtime tools.",
      category: "status",
      source: "native",
      scope: "both",
      acceptsArgs: true,
      args: [{ name: "mode", description: "compact or verbose", type: "string" }],
    },
    {
      // A command the core publishes as NATIVE-only: it exists as a platform
      // command on a channel, and typing it here would do nothing.
      name: "ping",
      textAliases: ["/ping"],
      description: "Native-only.",
      source: "native",
      scope: "native",
      acceptsArgs: false,
    },
    {
      name: "diagram_maker",
      textAliases: ["/diagram_maker"],
      description: "Create SVG/HTML or Excalidraw diagrams.",
      category: "tools",
      source: "skill",
      scope: "both",
      acceptsArgs: true,
    },
  ],
};

const HERMES_CATALOG = {
  pairs: [
    ["/new", "Start a new session (fresh session ID + history)"],
    ["/status", "Show session, model, token, and context info"],
  ],
  categories: [
    {
      name: "Session",
      pairs: [
        ["/new", "Start a new session (fresh session ID + history)"],
        ["/status", "Show session, model, token, and context info"],
        ["/clear", "Clear screen and start a new session"],
        ["/undo", "Back up N user turns and re-prompt (usage: /undo [n])"],
      ],
    },
    {
      name: "Configuration",
      pairs: [["/model", "Switch model (session-scoped; --global to persist)"]],
    },
  ],
  commands: {
    "/new": { argument_mode: null, desktop: null },
    "/status": { argument_mode: null, desktop: null },
    // Hermes' own word for "runs, but not from a composer".
    "/clear": { argument_mode: null, desktop: "terminal" },
    "/undo": { argument_mode: "text", desktop: null },
    "/model": { argument_mode: "options", desktop: "hidden" },
  },
  skills: {},
  skill_count: 0,
  warning: "",
};

describe("the OpenClaw command source (commands.list)", () => {
  it("reads the gateway's own catalogue, descriptions and order unchanged", () => {
    const commands = commandsFromOpenClawList(OPENCLAW_LIST);
    expect(commands.map((c) => c.id)).toEqual([
      "/help",
      "/status",
      "/model",
      "/tools",
      "/diagram_maker",
    ]);
    expect(commands[0]).toEqual({
      id: "/help",
      usage: "/help",
      description: "Show available commands.",
      acceptsArgs: false,
      source: "harness",
    });
    // A skill command is a harness command like any other: it comes from the
    // box's installed skills, which is precisely why it cannot be a list here.
    expect(commands[4].description).toBe("Create SVG/HTML or Excalidraw diagrams.");
  });

  it("drops a native-only command, because typing it in a chat does nothing", () => {
    expect(commandsFromOpenClawList(OPENCLAW_LIST).map((c) => c.id)).not.toContain("/ping");
  });

  it("builds the argument hint from the core's own args, required in angle brackets", () => {
    const byId = new Map(commandsFromOpenClawList(OPENCLAW_LIST).map((c) => [c.id, c]));
    expect(byId.get("/model")?.usage).toBe("/model <model>");
    expect(byId.get("/tools")?.usage).toBe("/tools [mode]");
    // No declared args → no hint, and therefore no trailing space on accept.
    expect(byId.get("/status")?.usage).toBe("/status");
  });

  it("answers an empty list for a payload it cannot read, rather than throwing", () => {
    expect(commandsFromOpenClawList(null)).toEqual([]);
    expect(commandsFromOpenClawList({})).toEqual([]);
    expect(commandsFromOpenClawList({ commands: "nope" })).toEqual([]);
    expect(commandsFromOpenClawList({ commands: [{ name: "" }, 7, null] })).toEqual([]);
  });
});

describe("the Hermes command source (commands.catalog)", () => {
  it("reads Hermes' catalogue in the registry's own order", () => {
    expect(commandsFromHermesCatalog(HERMES_CATALOG).map((c) => c.id)).toEqual([
      "/new",
      "/status",
      "/undo",
    ]);
  });

  it("honours Hermes' own `desktop` field about what belongs in a composer", () => {
    const ids = commandsFromHermesCatalog(HERMES_CATALOG).map((c) => c.id);
    // "terminal" — a reason it is not offered here.
    expect(ids).not.toContain("/clear");
    // "hidden" — runs, but out of the popover.
    expect(ids).not.toContain("/model");
  });

  it("lifts Hermes' published usage hint out of the description", () => {
    const undo = commandsFromHermesCatalog(HERMES_CATALOG).find((c) => c.id === "/undo");
    expect(undo?.usage).toBe("/undo [n]");
    expect(undo?.description).toBe("Back up N user turns and re-prompt");
  });

  it("falls back to `pairs` for a catalogue that answered without categories", () => {
    const noCategories = { ...HERMES_CATALOG, categories: undefined };
    expect(commandsFromHermesCatalog(noCategories).map((c) => c.id)).toEqual(["/new", "/status"]);
  });

  it("answers an empty list for a payload it cannot read", () => {
    expect(commandsFromHermesCatalog(null)).toEqual([]);
    expect(commandsFromHermesCatalog({ pairs: "nope" })).toEqual([]);
  });

  it("is NOT the OpenClaw list — the two harnesses publish different commands", () => {
    const openclaw = commandsFromOpenClawList(OPENCLAW_LIST).map((c) => c.id);
    const hermes = commandsFromHermesCatalog(HERMES_CATALOG).map((c) => c.id);
    expect(openclaw).toContain("/help");
    expect(hermes).not.toContain("/help");
    expect(hermes).toContain("/undo");
    expect(openclaw).not.toContain("/undo");
  });
});

describe("when the popover belongs on screen", () => {
  it("opens on a leading slash and narrows as the owner types", () => {
    expect(slashQueryAt("/", 1)).toBe("/");
    expect(slashQueryAt("/mo", 3)).toBe("/mo");
  });

  it("closes once the command is over and arguments have started", () => {
    // Otherwise the menu would eat the Enter meant to SEND `/model gemma`.
    expect(slashQueryAt("/model gemma", 11)).toBeNull();
    expect(slashQueryAt("/model ", 7)).toBeNull();
  });

  it("stays shut for a message that merely contains, or opens with, a path", () => {
    expect(slashQueryAt("what does /help do", 18)).toBeNull();
    expect(slashQueryAt("hello", 5)).toBeNull();
    expect(slashQueryAt("", 0)).toBeNull();
    // A pasted multi-line block is never a command.
    expect(slashQueryAt("/one\ntwo", 8)).toBeNull();
  });

  it("answers the WHOLE token wherever inside it the caret sits", () => {
    // Returning only the head made accepting a row keep the tail: `/status`
    // with the caret at 4 became `/statustus`.
    expect(slashQueryAt("/status", 4)).toBe("/status");
    expect(slashQueryAt("/status", 7)).toBe("/status");
  });

  it("stays shut for a caret that is not inside the token, or is not known", () => {
    // Position 0 used to answer `""` — "everything matches" — so the whole
    // catalogue opened over a draft nobody was completing.
    expect(slashQueryAt("/status", 0)).toBeNull();
    // -1 is the hook's "the draft changed somewhere other than this composer,
    // so where the caret is is not known". It must never open a menu.
    expect(slashQueryAt("/status", -1)).toBeNull();
    expect(slashQueryAt("/status", 99)).toBeNull();
  });

  it("stays shut on a finished draft whose caret was clicked back to the front", () => {
    // The concrete regression: click before the `m` of `/model gemma-4`, or
    // press Home, and the menu opened on the full list — then Enter, which the
    // owner meant as "send this line", accepted the top row and rewrote the
    // draft as `/statusmodel gemma-4`.
    expect(slashQueryAt("/model gemma-4", 1)).toBeNull();
    expect(slashQueryAt("/model gemma-4", 0)).toBeNull();
    expect(slashQueryAt("/model gemma-4", 6)).toBeNull();
  });
});

describe("filtering", () => {
  const all = commandsFromOpenClawList(OPENCLAW_LIST);

  it("offers everything for a bare slash", () => {
    expect(filterSlashCommands(all, "/").map((c) => c.id)).toEqual([
      "/help",
      "/status",
      "/model",
      "/tools",
      "/diagram_maker",
    ]);
  });

  it("filters on what has been typed", () => {
    expect(filterSlashCommands(all, "/mo").map((c) => c.id)).toEqual(["/model"]);
    expect(filterSlashCommands(all, "/st").map((c) => c.id)).toEqual(["/status"]);
  });

  it("puts a prefix match above a contained one", () => {
    // `/tools` starts with "to"; `/diagram_maker` does not contain it at all,
    // but `/status` does not either — `ma` proves the ordering rule.
    expect(filterSlashCommands(all, "/ma").map((c) => c.id)).toEqual(["/diagram_maker"]);
    expect(filterSlashCommands(all, "/el").map((c) => c.id)).toEqual(["/help", "/model"]);
  });

  it("is case-insensitive and caps what it renders", () => {
    expect(filterSlashCommands(all, "/MO").map((c) => c.id)).toEqual(["/model"]);
    expect(filterSlashCommands(all, "/", 2)).toHaveLength(2);
  });

  it("matches nothing for a command this harness does not publish", () => {
    expect(filterSlashCommands(all, "/frobnicate")).toEqual([]);
  });
});

describe("accepting a row", () => {
  const all = commandsFromOpenClawList(OPENCLAW_LIST);
  const byId = (id: string) => all.find((c) => c.id === id)!;

  it("puts a no-argument command in bare, so Enter sends it straight away", () => {
    expect(applySlashCommand("/he", 3, byId("/help"))).toEqual({
      text: "/help",
      caret: 5,
    });
  });

  it("puts a command that takes arguments in with the caret after a space", () => {
    expect(applySlashCommand("/mo", 3, byId("/model"))).toEqual({
      text: "/model ",
      caret: 7,
    });
  });

  it("replaces the WHOLE token, not just the text before the caret", () => {
    // `/helplp` was the shape of the real defect: accepting `/help` with the
    // caret parked two characters from the end kept the tail it was replacing.
    expect(applySlashCommand("/help", 3, byId("/help"))).toEqual({
      text: "/help",
      caret: 5,
    });
    // …and the same with a command that takes arguments, whose trailing space
    // must not smuggle the tail back either.
    expect(applySlashCommand("/status", 4, byId("/status"))).toEqual({
      text: "/status ",
      caret: 8,
    });
    expect(applySlashCommand("/mod", 2, byId("/model"))).toEqual({
      text: "/model ",
      caret: 7,
    });
  });

  it("uses the HARNESS's acceptsArgs for the trailing space, not a hint it could build", () => {
    // `/status` publishes `acceptsArgs: true` and no `args` at all — 36 of the
    // owner's 73 commands do — so a hint-based guess sent it bare on the very
    // next Enter.
    expect(applySlashCommand("/st", 3, byId("/status"))).toEqual({
      text: "/status ",
      caret: 8,
    });
    // …and one that genuinely takes none is still inserted bare.
    expect(applySlashCommand("/he", 3, byId("/help"))).toEqual({
      text: "/help",
      caret: 5,
    });
  });

  it("is a no-op where there is no token to complete, never a rewrite", () => {
    // Unreachable through the popover, which only opens on a token. What it
    // must never do is throw the owner's draft away.
    expect(applySlashCommand("just a message", 14, byId("/status"))).toEqual({
      text: "just a message",
      caret: 14,
    });
  });
});

describe("what the send path treats as a command", () => {
  it("recognises a command-shaped first token", () => {
    expect(isSlashCommandMessage("/status")).toBe(true);
    expect(isSlashCommandMessage("  /model gemma  ")).toBe(true);
    expect(isSlashCommandMessage("/reload-mcp")).toBe(true);
  });

  it("leaves an ordinary message alone, including one that opens with a path", () => {
    expect(isSlashCommandMessage("/home/clawbox/notes.md is the one")).toBe(false);
    expect(isSlashCommandMessage("/")).toBe(false);
    expect(isSlashCommandMessage("//")).toBe(false);
    expect(isSlashCommandMessage("tell me about /status")).toBe(false);
    expect(isSlashCommandMessage("")).toBe(false);
  });
});

describe("rows off the wire", () => {
  it("rejects a row that could render as a blank, insertable line", () => {
    const ok = { id: "/help", usage: "/help", description: "d", acceptsArgs: false, source: "harness" };
    expect(isSlashCommand(ok)).toBe(true);
    expect(isSlashCommand({ ...ok, id: "help" })).toBe(false);
    expect(isSlashCommand({ ...ok, id: "/" })).toBe(false);
    expect(isSlashCommand({ ...ok, id: 7 })).toBe(false);
    expect(isSlashCommand({ ...ok, source: "elsewhere" })).toBe(false);
    // A row with no `acceptsArgs` cannot say whether accepting it should leave
    // a trailing space, so it is not a row this composer can use.
    expect(isSlashCommand({ id: "/x", usage: "/x", description: "d", source: "harness" })).toBe(false);
    expect(isSlashCommand(null)).toBe(false);
  });
});
