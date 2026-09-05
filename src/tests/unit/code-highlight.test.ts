/**
 * Colour for code (src/lib/code-highlight.ts): Prism's tokens answered as
 * lines of typed pieces whose text, joined back, is exactly the input —
 * and drawn as text, never markup, by the editor that reads them.
 */
import { describe, expect, it } from "vitest";
import { highlightLines, MAX_HIGHLIGHT_CHARS, plainLines, splitLines } from "@/lib/code-highlight";
import { CODE_LANGUAGES } from "@/lib/code-language";

const joined = (lines: ReturnType<typeof highlightLines>) => lines.map((line) => line.map((p) => p.text).join("")).join("\n");

describe("highlightLines", () => {
  it("colours HTML: tags, attribute names and values, and the text between them plain", () => {
    const src = `<p class="x">hi <b>there</b></p>\n`;
    const lines = highlightLines(src, "markup");
    expect(joined(lines)).toBe(src);
    expect(lines).toHaveLength(2);
    const types = lines[0].map((p) => p.type);
    expect(types).toContain("tag");
    expect(types).toContain("attr-name");
    expect(types).toContain("attr-value");
    expect(lines[0].find((p) => p.text === "hi ")?.type).toBeNull();
    expect(lines[1]).toEqual([]);
  });

  it("colours a script block's body with the JavaScript grammar, not as one markup token", () => {
    const lines = highlightLines(`<script>const a = "s"; // c</script>`, "markup");
    const types = new Set(lines[0].map((p) => p.type));
    expect(types).toContain("keyword");
    expect(types).toContain("string");
    expect(types).toContain("comment");
    expect([...types].some((t) => t?.startsWith("language-"))).toBe(false);
  });

  it("carries a token that spans lines across them and keeps every line's text", () => {
    const src = "a();\n/* one\ntwo */\nb();";
    const lines = highlightLines(src, "javascript");
    expect(joined(lines)).toBe(src);
    expect(lines[1][0]).toEqual({ type: "comment", text: "/* one" });
    expect(lines[2][0]).toEqual({ type: "comment", text: "two */" });
    expect(lines[0].find((p) => p.text === "a")?.type).toBe("function");
  });

  it("round-trips every loaded grammar over a sample and colours something in each", () => {
    const samples: Record<string, string> = {
      markup: "<a href='x'>y</a>", css: "a { color: red; }", scss: "$x: 1px; a { b: $x; }", javascript: "let x = 1;", jsx: "<A b={1} />",
      typescript: "const x: number = 1;", tsx: "const a = <b/>;", json: "{\"a\": 1}", python: "def f():\n    return 1", bash: "echo \"$HOME\"",
      yaml: "a: 1\nb: [x]", markdown: "# Title\n*em*", sql: "SELECT a FROM b;", go: "func main() {}", rust: "fn main() {}", c: "int main() { return 0; }",
      cpp: "class A {};", java: "class A {}", ruby: "def f; end", toml: "[a]\nb = 1", docker: "FROM node:22\nRUN ls", ini: "[s]\nk=v",
    };
    for (const lang of CODE_LANGUAGES) {
      const src = samples[lang];
      expect(src, lang).toBeDefined();
      const lines = highlightLines(src, lang);
      expect(joined(lines), lang).toBe(src);
      expect(lines.flat().some((p) => p.type !== null), lang).toBe(true);
    }
  });

  it("answers plain lines for no grammar, an unknown one, and a text past the cap", () => {
    expect(highlightLines("a\nb", null)).toEqual([[{ type: null, text: "a" }], [{ type: null, text: "b" }]]);
    expect(highlightLines("<a>", "klingon")).toEqual([[{ type: null, text: "<a>" }]]);
    const big = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(highlightLines(big, "javascript")[0]).toEqual([{ type: null, text: big }]);
  });
});

describe("the line helpers", () => {
  it("cut pieces at every newline, an empty line an empty list, and never lose a character", () => {
    expect(splitLines([{ type: "a", text: "x\n\ny" }, { type: null, text: "z\n" }])).toEqual([
      [{ type: "a", text: "x" }],
      [],
      [{ type: "a", text: "y" }, { type: null, text: "z" }],
      [],
    ]);
    expect(plainLines("")).toEqual([[]]);
    expect(plainLines("a\n")).toEqual([[{ type: null, text: "a" }], []]);
  });
});
