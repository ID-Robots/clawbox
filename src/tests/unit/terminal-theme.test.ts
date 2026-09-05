/**
 * The terminal's face (src/components/TerminalApp.tsx): the shipped font
 * first with the symbols and emoji faces behind it, and the code editor's
 * palette on the Coding Agent's ground.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { TERMINAL_FONT_FAMILY, terminalTheme } from "@/components/TerminalApp";

describe("the terminal's font", () => {
  it("names JetBrains Mono, then the Nerd Font symbols, then the platform emoji faces, then what the box image has", () => {
    const faces = TERMINAL_FONT_FAMILY.split(",").map((f) => f.trim().replace(/^"|"$/g, ""));
    expect(faces.slice(0, 2)).toEqual(["JetBrains Mono", "Symbols Nerd Font Mono"]);
    expect(faces).toContain("Noto Color Emoji");
    expect(faces).toContain("Apple Color Emoji");
    expect(faces).toContain("DejaVu Sans Mono");
    expect(faces[faces.length - 1]).toBe("monospace");
  });

  it("ships the faces it names and declares them from this origin", () => {
    for (const file of ["JetBrainsMono-Regular.woff2", "JetBrainsMono-Bold.woff2", "SymbolsNerdFontMono-Regular.woff2", "JetBrainsMono-OFL.txt", "SymbolsNerdFont-LICENSE.txt"]) {
      expect(fs.existsSync(path.join(process.cwd(), "public", "fonts", file)), file).toBe(true);
    }
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    expect(css).toContain('font-family: "JetBrains Mono"');
    expect(css).toContain('url("/fonts/JetBrainsMono-Regular.woff2")');
    expect(css).toContain('font-family: "Symbols Nerd Font Mono"');
    expect(css).toMatch(/unicode-range:[^;]*U\+E000-F8FF/);
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\./);
  });
});

describe("the terminal's palette", () => {
  it("sits on the ground it is given, with the editor's colours and a coral cursor", () => {
    const theme = terminalTheme("#0d1117");
    expect(theme.background).toBe("#0d1117");
    expect(theme.cursorAccent).toBe("#0d1117");
    expect(theme.cursor).toBe("#f97316");
    // The same reds, greens and blues the `.tok-*` classes use.
    expect(theme.red).toBe("#ff7b72");
    expect(theme.brightBlue).toBe("#79c0ff");
    expect(theme.brightMagenta).toBe("#d2a8ff");
    expect(theme.brightGreen).toBe("#56d364");
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    expect(css).toContain("#ff7b72");
    expect(css).toContain("#79c0ff");
  });
});
