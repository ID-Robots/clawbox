/**
 * What the Map's card says about a picked page (page-blurb.ts): the
 * frontmatter's own summary first, else the first paragraph of prose,
 * Markdown out, cut at a sentence end within 400 characters.
 */
import { describe, expect, it } from "vitest";
import { BLURB_MAX, cutAtSentence, firstProse, pageBlurb, plainText } from "@/lib/prime-radiant/page-blurb";

describe("pageBlurb", () => {
  it("prefers the frontmatter's summary, then its description", () => {
    expect(pageBlurb({ summary: "Acme Widgets Ltd makes **blue** widgets." }, "Body text.")).toBe("Acme Widgets Ltd makes blue widgets.");
    expect(pageBlurb({ description: "The returns policy." }, "Body text.")).toBe("The returns policy.");
    expect(pageBlurb({ summary: "  ", description: 4 }, "Body text.")).toBe("Body text.");
  });

  it("takes the first paragraph of prose, past headings, lists, tables, quotes and code", () => {
    const body = [
      "# Widget pricing",
      "",
      "- small: 4 EUR",
      "- large: 9 EUR",
      "",
      "| size | price |",
      "| --- | --- |",
      "",
      "> A quote from the catalogue.",
      "",
      "```",
      "not prose either",
      "```",
      "",
      "Prices follow the [Acme catalogue](https://example.com/catalogue) and the",
      "[[entities/acme-widgets|Acme]] list, see `prices.csv` and [[concepts/widget-sizes]].",
      "",
      "A second paragraph.",
    ].join("\n");
    expect(pageBlurb(null, body)).toBe("Prices follow the Acme catalogue and the Acme list, see prices.csv and widget sizes.");
  });

  it("finds the prose right under a heading, with no blank line between them", () => {
    expect(firstProse("# Books to read\nA running list of books to read this year.")).toBe("A running list of books to read this year.");
    expect(firstProse("Intro line\n## Details\nMore text.")).toBe("Intro line");
    expect(firstProse("## Facts\n- one\n## About\nWhat this page is for.")).toBe("What this page is for.");
  });

  it("is null for a page with no prose at all", () => {
    expect(pageBlurb(null, "## Facts\n\n- one\n- two\n")).toBeNull();
    expect(pageBlurb(null, "")).toBeNull();
    expect(firstProse("Heading\n=======\n\n```\ncode\n```\n")).toBeNull();
  });

  it("cuts a long paragraph at the last sentence end that fits", () => {
    const sentence = "Acme Widgets Ltd ships blue widgets to every office in the region every week. ";
    const long = sentence.repeat(12).trim();
    const cut = pageBlurb(null, long)!;
    expect(cut.length).toBeLessThanOrEqual(BLURB_MAX);
    expect(cut.length).toBeGreaterThan(300);
    expect(cut.endsWith("week.")).toBe(true);
  });

  it("cuts at a word, with an ellipsis, when no sentence ends in reach", () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const cut = cutAtSentence(words);
    expect(cut.length).toBeLessThanOrEqual(BLURB_MAX);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/\s…$/);
  });

  it("takes Markdown out but leaves the words", () => {
    expect(plainText("**Bold**, _italic_, ~~gone~~ <b>tag</b> ![img](x.png) [^1] snake_case_name")).toBe("Bold, italic, gone tag snake_case_name");
  });
});

describe("plainText and markup", () => {
  it("leaves no tag behind when tags are nested or broken", () => {
    for (const s of ["<<b>script>alert(1)</script>", "<scr<b>ipt>x", "a <b>bold</b> word", "1 < 2 and 3 > 2"]) {
      const out = plainText(s);
      expect(out).not.toMatch(/[<>]/);
      expect(out.toLowerCase()).not.toContain("<script");
    }
    expect(plainText("a <b>bold</b> word")).toBe("a bold word");
  });
});
