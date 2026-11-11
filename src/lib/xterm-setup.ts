/**
 * The xterm.js setup every terminal on the desktop shares: the Terminal app
 * (src/components/TerminalApp.tsx) and the update's raw log panel
 * (src/components/UpdateRawLog.tsx). One loader and one set of options, so
 * the two look the same and a change to either is a change to both.
 *
 * Client only: the modules are loaded on first use.
 */
import {
  terminalFontFor,
  terminalThemeFor,
  type TerminalSettings,
} from "@/lib/terminal-settings";

export interface XtermModules {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
  WebLinksAddon: typeof import("@xterm/addon-web-links").WebLinksAddon;
  /** Unicode 11 widths; null where the addon would not load (xterm's own tables then). */
  Unicode11Addon: typeof import("@xterm/addon-unicode11").Unicode11Addon | null;
}

let xtermModules: Promise<XtermModules> | null = null;

/**
 * xterm and its addons, loaded ONCE however many terminals ask at the same
 * moment — a restored desktop mounts every Terminal tab at once (TASK-1306).
 * A load that fails is not kept: the next Reconnect loads again.
 */
export function loadXtermModules(): Promise<XtermModules> {
  if (!xtermModules) {
    const loading = (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      let Unicode11Addon: XtermModules["Unicode11Addon"] = null;
      try {
        ({ Unicode11Addon } = await import("@xterm/addon-unicode11"));
      } catch {
        // xterm's own Unicode 6 tables: emoji may count as one cell.
      }
      return { Terminal, FitAddon, WebLinksAddon, Unicode11Addon };
    })();
    xtermModules = loading;
    loading.catch(() => {
      if (xtermModules === loading) xtermModules = null;
    });
  }
  return xtermModules;
}

/** The xterm options a settings value decides — every one of them can change on a live terminal. */
export function xtermLiveOptions(settings: TerminalSettings) {
  const theme = terminalThemeFor(settings.theme);
  return {
    theme: theme.colors,
    fontFamily: terminalFontFor(settings.font).family,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    // A light ground needs the colours an app chose for a dark one nudged
    // until they read; on a dark ground every colour is drawn exactly as sent,
    // truecolor included.
    minimumContrastRatio: theme.tone === "light" ? 3 : 1,
  };
}

/** How every terminal draws its cells, whatever the settings say. */
export const XTERM_LOOK = {
  letterSpacing: 0,
  cursorInactiveStyle: "outline",
  // The background is opaque, so transparency bought nothing and cost the
  // renderer its fast path — on a redraw-heavy TUI that showed as tearing.
  allowTransparency: false,
  // Claude Code marks emphasis with bold. Remapping bold onto the BRIGHT
  // palette (xterm's default) recoloured its text instead of weighting it.
  drawBoldTextInBrightColors: false,
  fontWeight: "normal",
  fontWeightBold: "bold",
  // Unicode 11 widths are "proposed" API in xterm 6.
  allowProposedApi: true,
  // WebGL draws box drawing and block elements itself, so `╭─╮ │ ╰─╯`
  // joins at every line height, and scales a glyph that would spill
  // into the next cell (an emoji, a Nerd Font icon) back into its own.
  customGlyphs: true,
  rescaleOverlappingGlyphs: true,
} as const;

/**
 * The buffer's whole text — scrollback and screen — with every wrapped row
 * joined back onto the line it continues, so "Copy all" pastes the lines the
 * program printed rather than the width the window happened to be.
 */
export function terminalBufferText(term: Pick<import("@xterm/xterm").Terminal, "buffer">): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    // A row that continues on the next keeps its trailing spaces: they are
    // text the program wrote, not the padding after it.
    const continues = buffer.getLine(y + 1)?.isWrapped === true;
    const text = line.translateToString(!continues);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
