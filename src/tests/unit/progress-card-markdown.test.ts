import { describe, expect, it } from "vitest";
import {
  parseProgressInline,
  parseProgressMarkdown,
  progressBarFromAttributes,
  progressInlineText,
  sanitizeProgressHref,
  splitTableRow,
  type ProgressBlock,
  type ProgressInline,
} from "@/lib/progress-card-markdown";

/**
 * The progress card's Markdown sanitiser (TASK-896).
 *
 * The note is written by the agent, which reads the web and email, so it is
 * attacker-reachable text. The card draws this tree as React elements; these
 * tests pin that the tree can only ever contain the documented subset —
 * formatting, tables, http(s)/mailto links and `<progress>` bars — and that
 * every other piece of raw HTML is gone (tags) or gone with its content
 * (script-like elements), never passed through.
 */

/** Every string and every href anywhere in a tree, for "this never survives" checks. */
function flatten(value: unknown): string {
  return JSON.stringify(value);
}

function inlineTypes(nodes: ProgressInline[]): string[] {
  return nodes.map((node) => node.type);
}

describe("parseProgressMarkdown — the documented subset", () => {
  it("parses the docs' example: a labelled bar first, a sentence, then a table", () => {
    const blocks = parseProgressMarkdown([
      '<progress aria-label="Tests · 3/7" value="3" max="7"></progress>',
      "",
      "Tests are running.",
      "",
      "| check      | state   |",
      "| ---------- | ------- |",
      "| unit tests | passed  |",
      "| live flow  | running |",
    ].join("\n"));
    expect(blocks.map((b) => b.type)).toEqual(["progress", "paragraph", "table"]);
    expect(blocks[0]).toEqual({ type: "progress", value: 3, max: 7, label: "Tests · 3/7" });
    const table = blocks[2] as Extract<ProgressBlock, { type: "table" }>;
    expect(table.header.map(progressInlineText)).toEqual(["check", "state"]);
    expect(table.rows.map((row) => row.map(progressInlineText))).toEqual([
      ["unit tests", "passed"],
      ["live flow", "running"],
    ]);
  });

  it("parses the task's LANE / UNIT / NOW ON table with bold, links and a bar in a cell", () => {
    const blocks = parseProgressMarkdown([
      "**Overnight coding queue — running until 08:00**",
      "",
      "| LANE | UNIT | NOW ON |",
      "|:-----|:----:|-------:|",
      '| api | `auth` | [PR #12](https://github.com/o/r/pull/12) <progress value="2" max="4"></progress> |',
    ].join("\n"));
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "strong", children: [{ type: "text", text: "Overnight coding queue — running until 08:00" }] }],
    });
    const table = blocks[1] as Extract<ProgressBlock, { type: "table" }>;
    expect(table.align).toEqual(["left", "center", "right"]);
    const nowOn = table.rows[0][2];
    expect(nowOn[0]).toEqual({ type: "link", href: "https://github.com/o/r/pull/12", children: [{ type: "text", text: "PR #12" }] });
    expect(nowOn.find((n) => n.type === "progress")).toEqual({ type: "progress", value: 2, max: 4, label: null });
    expect(table.rows[0][1]).toEqual([{ type: "code", text: "auth" }]);
  });

  it("keeps an escaped pipe and a pipe inside code as cell text", () => {
    expect(splitTableRow("| a \\| b | `x|y` | c |")).toEqual(["a | b", "`x|y`", "c"]);
  });

  it("pads short rows and drops cells past the header's width", () => {
    const [table] = parseProgressMarkdown("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |") as Array<Extract<ProgressBlock, { type: "table" }>>;
    expect(table.rows.map((row) => row.map(progressInlineText))).toEqual([["1", ""], ["1", "2"]]);
  });

  it("does not take a header and delimiter that disagree on columns for a table", () => {
    const blocks = parseProgressMarkdown("| a | b |\n|---|\nplain");
    expect(blocks.some((b) => b.type === "table")).toBe(false);
  });

  it("parses headings, lists, task lists, quotes, rules and fenced code", () => {
    const blocks = parseProgressMarkdown([
      "## Status",
      "- first",
      "  - nested",
      "- [x] done thing",
      "- [ ] open thing",
      "",
      "1. one",
      "2. two",
      "",
      "> quoted **note**",
      "",
      "---",
      "```",
      "<b>literal</b>",
      "```",
    ].join("\n"));
    expect(blocks.map((b) => b.type)).toEqual(["heading", "list", "list", "quote", "rule", "code"]);
    const bullets = blocks[1] as Extract<ProgressBlock, { type: "list" }>;
    expect(bullets.ordered).toBe(false);
    expect(bullets.items.map((i) => [progressInlineText(i.children), i.depth, i.checked])).toEqual([
      ["first", 0, null],
      ["nested", 1, null],
      ["done thing", 0, true],
      ["open thing", 0, false],
    ]);
    const numbered = blocks[2] as Extract<ProgressBlock, { type: "list" }>;
    expect(numbered.ordered).toBe(true);
    expect(numbered.items).toHaveLength(2);
    // Fenced code keeps its characters as text: it is drawn as text, so a tag in it is harmless.
    expect(blocks[5]).toEqual({ type: "code", text: "<b>literal</b>" });
  });

  it("parses bold, italic, strikethrough and code spans, leaving intraword underscores alone", () => {
    const nodes = parseProgressInline("**bold** *it* _also_ ~~gone~~ `x < y` snake_case_name");
    expect(inlineTypes(nodes)).toEqual(["strong", "text", "em", "text", "em", "text", "del", "text", "code", "text"]);
    expect(nodes[8]).toEqual({ type: "code", text: "x < y" });
    expect(nodes[9]).toEqual({ type: "text", text: " snake_case_name" });
  });

  it("keeps an unmatched marker as a literal character", () => {
    expect(progressInlineText(parseProgressInline("2 * 3 = 6 and **open"))).toBe("2 * 3 = 6 and **open");
  });

  it("links bare URLs without swallowing the sentence's punctuation", () => {
    const nodes = parseProgressInline("See https://example.com/a_(b). Then go.");
    expect(nodes[1]).toEqual({ type: "link", href: "https://example.com/a_(b)", children: [{ type: "text", text: "https://example.com/a_(b)" }] });
    expect(nodes[2]).toEqual({ type: "text", text: ". Then go." });
  });

  it("decodes entities as text and keeps line breaks", () => {
    const nodes = parseProgressInline("a &amp; b &lt;i&gt;\nnext&nbsp;line<br>end");
    expect(inlineTypes(nodes)).toEqual(["text", "break", "text", "break", "text"]);
    expect(nodes[0]).toEqual({ type: "text", text: "a & b <i>" });
  });

  it("returns nothing for a blank note", () => {
    expect(parseProgressMarkdown("")).toEqual([]);
    expect(parseProgressMarkdown("   \n\n  ")).toEqual([]);
  });
});

describe("parseProgressMarkdown — the sanitiser", () => {
  it("drops script, style, iframe and svg WITH their content", () => {
    const blocks = parseProgressMarkdown([
      "before<script>alert(document.cookie)</script>after",
      "<style>body{display:none}</style>",
      '<iframe src="https://evil.example"></iframe>',
      '<svg onload="alert(1)"><circle/></svg>',
      "<SCRIPT type=module>\nfetch('/x')\n</SCRIPT>",
      "tail",
    ].join("\n"));
    const text = flatten(blocks);
    expect(text).not.toMatch(/alert|cookie|display:none|evil|fetch|circle/i);
    // The removed lines leave blank ones behind, so what follows them is a paragraph of its own.
    expect(blocks.map((b) => progressInlineText((b as Extract<ProgressBlock, { type: "paragraph" }>).children))).toEqual(["beforeafter", "tail"]);
  });

  it("drops an unclosed script to the end, the way the browser would read it", () => {
    const blocks = parseProgressMarkdown("safe text\n<script>alert(1)\nmore");
    expect(flatten(blocks)).not.toContain("alert");
    expect(progressInlineText((blocks[0] as Extract<ProgressBlock, { type: "paragraph" }>).children)).toBe("safe text");
  });

  it("strips other tags, handlers and all, but keeps their words", () => {
    const blocks = parseProgressMarkdown('<div class="x" onclick="steal()"><b>Bold</b> <img src=x onerror=alert(1)> <a href="javascript:alert(1)">click</a></div>');
    const text = flatten(blocks);
    expect(text).not.toMatch(/onclick|onerror|steal|javascript|<|img/i);
    expect(progressInlineText((blocks[0] as Extract<ProgressBlock, { type: "paragraph" }>).children)).toBe("Bold click");
  });

  it("removes comments, declarations and processing instructions", () => {
    const blocks = parseProgressMarkdown("a<!-- secret -->b <!DOCTYPE html><?xml version=1?>c <![CDATA[x]]>");
    expect(flatten(blocks)).not.toMatch(/secret|DOCTYPE|xml|CDATA/);
  });

  it("shows a tag inside a code span as literal characters", () => {
    const [block] = parseProgressMarkdown("use `<script>` carefully") as Array<Extract<ProgressBlock, { type: "paragraph" }>>;
    expect(block.children).toEqual([
      { type: "text", text: "use " },
      { type: "code", text: "<script>" },
      { type: "text", text: " carefully" },
    ]);
  });

  it("never produces a link to anything but http, https or mailto", () => {
    const hostile = [
      "[a](javascript:alert(1))",
      "[b](JaVaScRiPt:alert(1))",
      "[c](java\tscript:alert(1))",
      "[d](&#106;avascript:alert(1))",
      "[e](data:text/html;base64,PHNjcmlwdD4=)",
      "[f](vbscript:msgbox(1))",
      "[g](//evil.example/x)",
      "[h](/setup-api/system/power)",
      "<javascript:alert(1)>",
    ].join(" ");
    const blocks = parseProgressMarkdown(hostile);
    const links: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        const node = value as Record<string, unknown>;
        if (node.type === "link") links.push(String(node.href));
        Object.values(node).forEach(walk);
      }
    };
    walk(blocks);
    expect(links).toEqual([]);
    // The words stay, so the owner still sees what the agent meant to point at; what
    // is not even link syntax (a destination with a gap in it) stays literal text.
    const text = progressInlineText((blocks[0] as Extract<ProgressBlock, { type: "paragraph" }>).children);
    expect(text).toMatch(/^a b \[c\]\(java\s+script:alert\(1\)\) d e f g h <javascript:alert\(1\)>$/);
  });

  it("keeps a safe link and normalises it through the URL parser", () => {
    expect(sanitizeProgressHref("https://Example.com/a b")).toBe("https://example.com/a%20b");
    expect(sanitizeProgressHref("\u0001javascript:alert(1)")).toBeNull();
    expect(sanitizeProgressHref("java\nscript:alert(1)")).toBeNull();
    expect(sanitizeProgressHref("https://ex\u0000ample.com")).toBeNull();
    expect(sanitizeProgressHref(" https://example.com/path?q=1&amp;r=2 ")).toBe("https://example.com/path?q=1&r=2");
    expect(sanitizeProgressHref("HTTP://EXAMPLE.com")).toBe("http://example.com/");
    expect(sanitizeProgressHref("mailto:owner@example.com")).toBe("mailto:owner@example.com");
    expect(sanitizeProgressHref("mailto:javascript:alert(1)")).toBeNull();
    expect(sanitizeProgressHref("javascript://example.com/%0Aalert(1)")).toBeNull();
    expect(sanitizeProgressHref("https://")).toBeNull();
  });

  it("drops images, keeping only their alt text", () => {
    const [block] = parseProgressMarkdown('![build graph](https://evil.example/pixel.png "t")') as Array<Extract<ProgressBlock, { type: "paragraph" }>>;
    expect(block.children).toEqual([{ type: "text", text: "build graph" }]);
  });

  it("removes zero-width and bidirectional control characters", () => {
    const [block] = parseProgressMarkdown("safe\u202Etxt.exe\u200B ok") as Array<Extract<ProgressBlock, { type: "paragraph" }>>;
    expect(progressInlineText(block.children)).toBe("safetxt.exe ok");
  });

  it("drops a note that is nothing but stripped HTML", () => {
    expect(parseProgressMarkdown("<script>x</script>\n<!-- y -->")).toEqual([]);
  });

  // Every case here took seconds (a backtracking regex, a rescan per opener) before the scans
  // were made linear; the test's own timeout is the bound that pins it.
  it("survives pathological nesting and very long input without throwing", () => {
    const hostile = [
      "`".repeat(8000),
      "*a ".repeat(5000),
      "[".repeat(8000),
      "<progress value=1>".repeat(1500),
      "# a" + " ".repeat(8000) + "x",
      "| a |\n|" + "-".repeat(8000) + " ".repeat(4000) + "x",
      "https://x.example/" + ")".repeat(8000),
      "<a" + " b=c".repeat(3000),
      "_".repeat(4000) + "a" + "_".repeat(4000),
      "`a ".repeat(4000) + "``b ".repeat(2000),
    ];
    for (const input of hostile) expect(() => parseProgressMarkdown(input)).not.toThrow();
    expect(() => parseProgressMarkdown("*".repeat(5000) + "[".repeat(2000) + "`".repeat(3000))).not.toThrow();
    expect(() => parseProgressMarkdown(">".repeat(200) + " deep")).not.toThrow();
    const huge = parseProgressMarkdown("x".repeat(100_000));
    expect(progressInlineText((huge[0] as Extract<ProgressBlock, { type: "paragraph" }>).children).length).toBeLessThanOrEqual(16_384);
  });
});

describe("progress bars", () => {
  it("reads value, max and aria-label, and ignores every other attribute", () => {
    expect(progressBarFromAttributes(' value="3" max="7" aria-label="Tests · 3/7" onclick="x()" style="width:9999px"')).toEqual({
      value: 3, max: 7, label: "Tests · 3/7",
    });
  });

  it("clamps the value into [0, max] and defaults max to 1 the way HTML does", () => {
    expect(progressBarFromAttributes(' value="12" max="10"')).toMatchObject({ value: 10, max: 10 });
    expect(progressBarFromAttributes(' value="-4" max="10"')).toMatchObject({ value: 0, max: 10 });
    expect(progressBarFromAttributes(' value="0.4"')).toMatchObject({ value: 0.4, max: 1 });
    expect(progressBarFromAttributes(' value="3" max="0"')).toMatchObject({ value: 1, max: 1 });
    expect(progressBarFromAttributes(' value="3" max="-2"')).toMatchObject({ max: 1 });
  });

  it("treats a missing or unreadable value as an indeterminate bar", () => {
    expect(progressBarFromAttributes(' max="10"')).toEqual({ value: null, max: 10, label: null });
    expect(progressBarFromAttributes(' value="NaN" max="10"')).toMatchObject({ value: null });
    expect(progressBarFromAttributes(' value="Infinity"')).toMatchObject({ value: null });
    expect(progressBarFromAttributes(' value="1e999"')).toMatchObject({ value: null });
  });

  it("accepts unquoted and single-quoted attributes and a self-closed element", () => {
    const [block] = parseProgressMarkdown("<progress value=5 max='8' aria-label='Build' />");
    expect(block).toEqual({ type: "progress", value: 5, max: 8, label: "Build" });
  });

  it("drops the element's fallback content instead of showing it twice", () => {
    const [block] = parseProgressMarkdown('<progress value="1" max="2">50%</progress>');
    expect(block).toEqual({ type: "progress", value: 1, max: 2, label: null });
  });

  it("keeps a bar inside a sentence as an inline bar", () => {
    const [block] = parseProgressMarkdown('Upload <progress value="1" max="4"></progress> of the release') as Array<Extract<ProgressBlock, { type: "paragraph" }>>;
    expect(inlineTypes(block.children)).toEqual(["text", "progress", "text"]);
  });

  it("caps an over-long label", () => {
    const bar = progressBarFromAttributes(` value="1" aria-label="${"x".repeat(500)}"`);
    expect(bar.label).toHaveLength(160);
  });
});
