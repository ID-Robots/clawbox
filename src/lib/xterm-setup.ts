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
  type TerminalFontDef,
  type TerminalSettings,
} from "@/lib/terminal-settings";

type XTerm = import("@xterm/xterm").Terminal;
type XFitAddon = import("@xterm/addon-fit").FitAddon;

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

/** How long the first cell waits for the settings and the web font before it is drawn with what is there. */
export const FONT_WAIT_MS = 1500;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
  ]).finally(() => { if (timer !== null) clearTimeout(timer); });
}

/**
 * A shipped face, loaded before the grid is measured — bounded, so a slow disk
 * never holds the shell. Answers whether the wait ran out and the load itself,
 * so a terminal drawn on the fallback face can be refitted the moment the real
 * one lands. The device's own monospace needs no wait.
 *
 * Every terminal must do this before it draws: xterm measures each glyph's
 * width once, and a face that arrives later is drawn into the widths of the
 * fallback. In the stack the terminal fonts share, the first fallback with a
 * space is the colour-emoji face, whose space is twice a cell — measured
 * there and drawn in the real face, every space came out zero wide.
 */
export async function loadTerminalFont(font: TerminalFontDef, size: number): Promise<{ late: boolean; loading: Promise<boolean> | null }> {
  if (!font.face || typeof document === "undefined" || !("fonts" in document)) return { late: false, loading: null };
  let loading: Promise<boolean>;
  try {
    // Bold as well: xterm measures bold glyphs on their own, and bold text
    // measured on the fallback lost its spaces the same way.
    loading = Promise.all([
      document.fonts.load(`${size}px "${font.face}"`),
      document.fonts.load(`bold ${size}px "${font.face}"`).catch(() => []),
    ]).then(([regular]) => regular.length > 0, () => false);
  } catch {
    return { late: false, loading: null };
  }
  const late = await withTimeout(loading.then(() => false), FONT_WAIT_MS);
  return { late: late === undefined, loading };
}

/**
 * Re-measure the grid on the face that has just arrived: xterm measures on a
 * font CHANGE, so the family is set away and back.
 */
const FALLBACK_FONT_FAMILY = '"DejaVu Sans Mono", "Liberation Mono", monospace';
export function refitForFont(term: XTerm, fitAddon: XFitAddon, family: string): void {
  term.options.fontFamily = FALLBACK_FONT_FAMILY;
  term.options.fontFamily = family;
  fitAddon.fit();
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
export function terminalBufferText(term: Pick<XTerm, "buffer">): string {
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
