/**
 * What one line of a coding run's progress feed MEANS, for a card to draw.
 *
 * The run record's `progress` is written by the runner (coding-agent.ts,
 * pushProgress) in the vocabulary of the harness: a tool_use block becomes its
 * tool's name — "Write style.css", "$ node --check app.js",
 * "mcp__clawbox__browser_screenshot" — and a text block is the agent's own
 * sentence. The Coding Agent app can print that as-is; the chat card cannot.
 * "mcp__clawbox__browser_screenshot" on a chip in the owner's chat is the
 * harness leaking through, and the owner asked for it to be a good-looking
 * element instead. This module is the one place that translation lives, so the
 * card and its tests agree on it and the raw `mcp__` name can never be shown.
 *
 * Pure: a string in, a description out, nothing read from the device. The
 * English `label` is a fallback; a card with translations picks the locale's
 * word by `labelKey` and shows `detail` (a file name, a command) verbatim.
 */

export type ProgressKind = "tool" | "file" | "command" | "text";

/**
 * The translated label a chip wants. A card maps these through the labels it
 * is handed (see CodingAgentActivityPill) rather than translating here, which
 * keeps this module free of the i18n context and testable as a function.
 */
export type ProgressLabelKey =
  | "screenshot"
  | "lookingAtPage"
  | "openingPage"
  | "drivingPage"
  | "closingPage"
  | "write"
  | "edit"
  | "read";

export interface ProgressDescription {
  kind: ProgressKind;
  /** English rendering of the step; the card prefers its own copy for `labelKey`. */
  label: string;
  /** A Material Symbols Rounded glyph name — the app ships the full font. */
  icon: string;
  /** The file, the command, the search pattern — shown after the label, never translated. */
  detail?: string;
  labelKey?: ProgressLabelKey;
}

/**
 * The clawbox browser family a run can call (mcp/tools/browser.ts), grouped
 * the way the owner reads them: looking, opening, driving. `browser_open` and
 * `browser_navigate` both put a page on screen; click/type/keypress/scroll
 * are all "the run is working the page" — the difference between a click and
 * a keypress is noise at chat-card size.
 */
const BROWSER_TOOLS: Record<string, { labelKey: ProgressLabelKey; label: string; icon: string }> = {
  browser_screenshot: { labelKey: "screenshot", label: "Screenshot", icon: "photo_camera" },
  browser_view_local: { labelKey: "lookingAtPage", label: "Looking at the page", icon: "visibility" },
  browser_open: { labelKey: "openingPage", label: "Opening a page", icon: "open_in_browser" },
  browser_navigate: { labelKey: "openingPage", label: "Opening a page", icon: "open_in_browser" },
  browser_click: { labelKey: "drivingPage", label: "Driving the page", icon: "touch_app" },
  browser_type: { labelKey: "drivingPage", label: "Driving the page", icon: "touch_app" },
  browser_keypress: { labelKey: "drivingPage", label: "Driving the page", icon: "touch_app" },
  browser_scroll: { labelKey: "drivingPage", label: "Driving the page", icon: "touch_app" },
  browser_close: { labelKey: "closingPage", label: "Closing the page", icon: "close" },
};

/** The file tools the runner names by verb + path (Read is named the same way). */
const FILE_TOOLS: Record<string, { labelKey: ProgressLabelKey; label: string; icon: string }> = {
  Write: { labelKey: "write", label: "Writing", icon: "edit_document" },
  Edit: { labelKey: "edit", label: "Editing", icon: "edit" },
  NotebookEdit: { labelKey: "edit", label: "Editing", icon: "edit" },
  Read: { labelKey: "read", label: "Reading", icon: "description" },
};

/** A tool name as the harness reports it: `mcp__<server>__<tool>` or bare. */
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9-]+__([A-Za-z0-9_]+)$/;
const BARE_TOOL_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** Where every run's folder lives on the box; a command echoing it is all noise. */
const DEVICE_PREFIX = "/home/clawbox/clawbox/";
/** A chip's width, roughly — a longer command is cut with an ellipsis. */
const MAX_COMMAND_CHARS = 60;

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function describeProgressLine(raw: string): ProgressDescription {
  const line = (raw ?? "").replace(/\s+/g, " ").trim();

  // "$ node --check …" — the runner's own prefix for a Bash tool_use.
  if (line.startsWith("$")) {
    const command = line.slice(1).trim().split(DEVICE_PREFIX).join("");
    return { kind: "command", label: shorten(command, MAX_COMMAND_CHARS), icon: "terminal" };
  }

  // "Write style.css" / "Edit src/app.js" / "Read index.html" / a bare "Write"
  // when the run passed no path (the runner writes the verb and nothing else).
  const fileMatch = /^(Write|Edit|NotebookEdit|Read)(?:\s+(.*))?$/.exec(line);
  if (fileMatch) {
    const tool = FILE_TOOLS[fileMatch[1]];
    const target = (fileMatch[2] ?? "").trim();
    return {
      kind: "file",
      label: tool.label,
      labelKey: tool.labelKey,
      icon: tool.icon,
      ...(target ? { detail: basename(target) } : {}),
    };
  }

  // A tool called by name and nothing else: the MCP form the harness reports
  // ("mcp__clawbox__browser_screenshot") or the bare name.
  const mcp = MCP_TOOL_RE.exec(line);
  const toolName = mcp ? mcp[1] : BARE_TOOL_RE.test(line) ? line : null;
  if (toolName) {
    const known = BROWSER_TOOLS[toolName];
    if (known) return { kind: "tool", ...known };
    // Not one of ours — still never the raw mcp__ name; the tool's own words
    // with the underscores taken out is the most honest label left.
    return { kind: "tool", label: toolName.replace(/_/g, " "), icon: "extension" };
  }

  return { kind: "text", label: line, icon: "notes" };
}
