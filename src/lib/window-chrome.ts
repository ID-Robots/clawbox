/**
 * The desktop window chrome's tokens — the mascot chat popup's shell
 * (src/components/ChatPopup.tsx), shared by ChromeWindow so every window
 * reads as one family with the chat.
 *
 * Plain TS, no React: the two literals below are the ONLY places a value is
 * spelled out in JS. Everything else points at the CSS custom properties in
 * the "WINDOW CHROME" block of src/app/globals.css, and a unit test
 * (src/tests/unit/window-chrome-tokens.test.ts) pins the two to each other.
 */

/** The window ground. The ONE colour literal: xterm's theme cannot read a CSS var(). */
export const WIN_GROUND = "#0d1117";

/** The strip's height. The ONE number JS needs (drag centring); pinned to --win-strip-h. */
export const WIN_STRIP_HEIGHT = 36;

/** The strip's top-down fade — exported so the tokens test can compare CSS to TS without parsing the gradient. */
export const WIN_STRIP_FADE =
  "linear-gradient(180deg, rgba(8,12,22,0.95) 0%, rgba(8,12,22,0.8) 40%, rgba(8,12,22,0.45) 70%, rgba(8,12,22,0) 100%)";

export const win = {
  ground: "var(--win-ground)",
  radius: "var(--win-radius)",
  stripFade: "var(--win-strip-fade)",
  shadow: "var(--win-shadow)",
  shadowIdle: "var(--win-shadow-idle)",
} as const;
