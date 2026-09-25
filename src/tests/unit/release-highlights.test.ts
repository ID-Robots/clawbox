/**
 * TASK-1205: the Highlights of a release, read out of its notes for the
 * /updating screen's "What's new" panel.
 *
 * What is pinned here:
 *  - the real 4.1.0 and 4.0.0 notes in this checkout (which are also the
 *    GitHub release bodies) give their Highlights, joined across wrapped lines
 *    and without a single Markdown mark;
 *  - the 3.9 shape (`**Title** — body`) splits the same way;
 *  - notes with no Highlights section — the older "What's Changed" PR lists —
 *    give NOTHING, so the panel shows its fallback rather than PR titles;
 *  - the output is capped, and whatever the input, the parser never throws.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  capText,
  MAX_BODY_CHARS,
  MAX_HIGHLIGHTS,
  MAX_TITLE_CHARS,
  parseReleaseHighlights,
  plainInline,
  splitHighlight,
} from "@/lib/release-highlights";

const notes = (version: string) =>
  fs.readFileSync(path.join(process.cwd(), `RELEASE-NOTES-${version}.md`), "utf-8");

describe("parseReleaseHighlights on the releases this repo shipped", () => {
  it("reads the four 4.1.0 highlights, title and body, in order", () => {
    const highlights = parseReleaseHighlights(notes("4.1.0"));
    expect(highlights.map((h) => h.title)).toEqual([
      "More of the phone for the chat",
      "A conversation that cannot reopen says why",
      "Web apps from before 4.0 find their data",
      "Coding Agent pull requests merge when green",
    ]);
    // Wrapped lines are joined into one sentence, with single spaces.
    expect(highlights[0].body).toBe(
      "On a phone the chat opens full screen, its header and the message box's options fold away, "
        + "and the text can be set from 85% to 150%. Both choices are remembered on that phone.",
    );
    expect(highlights[3].body).toMatch(/A pull request labelled hold, or one into main, is never merged\.$/);
  });

  it("matches the desktop card's English copy of the same highlights", async () => {
    // The card's catalogue says it was taken from these notes; the parser must
    // read the notes the same way a person did.
    const { whatsNewEn } = await import("@/lib/edition-translations/en-whats-new");
    const [first] = parseReleaseHighlights(notes("4.1.0"));
    expect(first.title).toBe(whatsNewEn["whatsNew.phoneFullscreenTitle"]);
    expect(first.body).toBe(whatsNewEn["whatsNew.phoneFullscreenBody"]);
  });

  it("caps the 4.0.0 notes' eight highlights at the panel's handful, and strips the code span", () => {
    const highlights = parseReleaseHighlights(notes("4.0.0"));
    expect(highlights).toHaveLength(MAX_HIGHLIGHTS);
    expect(highlights[0].title).toBe("Coding Agent");
    const hostname = highlights.find((h) => h.title === "A hostname that stays");
    expect(hostname?.body).toContain("<boxHandle>.clawbox.tech");
    for (const h of highlights) {
      expect(`${h.title} ${h.body}`).not.toMatch(/\*\*|`/);
    }
  });
});

describe("parseReleaseHighlights on other shapes", () => {
  it("splits the 3.9 `**Title** — body` bullets", () => {
    const body = [
      "## Highlights",
      "",
      "- **Hermes edition** — a single-harness SKU locked at install time (`openclaw` | `hermes` | `dual`).",
      "- **Local model hardening** — Gemma 4 reasoning-effort handling.",
      "",
      "Full list of changes below.",
      "",
      "## What's Changed",
      "* Harden gateway recovery after updates by @yalexx in https://github.com/ID-Robots/clawbox/pull/263",
    ].join("\n");
    expect(parseReleaseHighlights(body)).toEqual([
      { title: "Hermes edition", body: "a single-harness SKU locked at install time (openclaw | hermes | dual)." },
      { title: "Local model hardening", body: "Gemma 4 reasoning-effort handling." },
    ]);
  });

  it("gives nothing for notes without a Highlights section — never the PR list", () => {
    const body = "## What's Changed\n* fix(mascot): stop crab teleporting by @yalexx in https://github.com/x/y/pull/268\n";
    expect(parseReleaseHighlights(body)).toEqual([]);
  });

  it("stops at the next heading, skips nested bullets and reads CRLF notes", () => {
    const body = [
      "# ClawBox 9.9.0",
      "### Highlights",
      "- **One.** First",
      "  continues here.",
      "  - a nested detail that is not a highlight",
      "    that wraps too",
      "- A bullet with no bold lead",
      "## Upgrade notes",
      "- **Not a highlight.** Upgrade text.",
    ].join("\r\n");
    expect(parseReleaseHighlights(body)).toEqual([
      { title: "One", body: "First continues here." },
      { title: "", body: "A bullet with no bold lead" },
    ]);
  });

  it("reduces links, images, HTML, emphasis and entities to their words", () => {
    const body = "## Highlights\n- **[Docs](https://x.y) & more:** Read <b>this</b> ![img](a.png) _now_ &amp; *then* &lt;ok&gt;.";
    expect(parseReleaseHighlights(body)).toEqual([{ title: "Docs & more", body: "Read this img now & then <ok>." }]);
  });

  it("caps long titles and bodies with an ellipsis", () => {
    const long = "word ".repeat(200).trim();
    const [item] = parseReleaseHighlights(`## Highlights\n- **${long}** ${long}`);
    expect(item.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(item.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(item.title.endsWith("…")).toBe(true);
    expect(item.body.endsWith("…")).toBe(true);
  });

  it("honours a smaller cap and never throws on junk", () => {
    const body = "## Highlights\n- **A.** a\n- **B.** b\n- **C.** c";
    expect(parseReleaseHighlights(body, 2).map((h) => h.title)).toEqual(["A", "B"]);
    expect(parseReleaseHighlights(body, -1)).toEqual([]);
    for (const junk of [undefined, null, 42, {}, "", "## Highlights", "## Highlights\n\n- ", "**"]) {
      expect(parseReleaseHighlights(junk)).toEqual([]);
    }
  });
});

describe("the helpers", () => {
  it("capText leaves short text alone and cuts at a word", () => {
    expect(capText("short", 10)).toBe("short");
    expect(capText("alpha beta gamma delta", 12)).toBe("alpha beta…");
    expect(capText("abcdefghijklmnop", 8)).toBe("abcdefg…");
  });

  it("plainInline keeps a lone asterisk or underscore that is not emphasis", () => {
    expect(plainInline("5 * 3 = 15 and snake_case_name")).toBe("5 * 3 = 15 and snake_case_name");
  });

  it("splitHighlight takes a colon lead as well as a full stop", () => {
    expect(splitHighlight("**Faster updates:** less waiting")).toEqual({ title: "Faster updates", body: "less waiting" });
  });
});
