import { describe, expect, it } from "vitest";
import { audioLabel, plainTextForLabel } from "@/lib/chat-markdown";

/**
 * An accessible name is SPOKEN, so it cannot carry markdown source.
 *
 * The audio player under a spoken reply used to be labelled with the raw
 * `msg.text`, so a reply the model wrote as `*"seventeen copper bells"*` was
 * announced as "asterisk quote seventeen copper bells quote asterisk", and a
 * reply containing a link read the whole URL out. Observed live on box .177 on
 * beta 084e3f7 before this change.
 *
 * The contract this file locks down: whatever `renderInline`/`renderText`
 * treat as markup, this strips — the two must not drift into disagreeing about
 * what counts as syntax.
 */
describe("plainTextForLabel", () => {
  it("drops emphasis markers but keeps the words", () => {
    expect(plainTextForLabel('Sent — *"Seventeen copper bells."*')).toBe('Sent — "Seventeen copper bells."');
    expect(plainTextForLabel("that is **very** important")).toBe("that is very important");
  });

  it("keeps a link's text and drops its URL", () => {
    // The URL is the part that is unbearable out loud, and it is never the
    // information the listener wanted.
    expect(plainTextForLabel("see [the docs](https://clawbox.com/docs/a/b/c) for more"))
      .toBe("see the docs for more");
  });

  it("unwraps inline and fenced code instead of reading backticks", () => {
    expect(plainTextForLabel("run `openclaw health` now")).toBe("run openclaw health now");
    expect(plainTextForLabel("before\n```bash\nls -la\n```\nafter")).toBe("before ls -la after");
  });

  it("removes heading hashes and list bullets", () => {
    expect(plainTextForLabel("## Result\n- first\n- second")).toBe("Result first second");
  });

  it("strips more than renderText renders, never less", () => {
    // renderText only promotes ## and ### to headings, and only bullets a
    // paragraph made entirely of them. This deliberately drops a lone # and a
    // stray bullet too: on screen a leftover marker is invisible noise, spoken
    // aloud it is a word the listener has to discard.
    expect(plainTextForLabel("# Title")).toBe("Title");
    expect(plainTextForLabel("#### Deep")).toBe("Deep");
    expect(plainTextForLabel("intro\n- lone bullet")).toBe("intro lone bullet");
  });

  it("collapses newlines so the name is one utterance", () => {
    expect(plainTextForLabel("one\n\n\ntwo\n   three")).toBe("one two three");
  });

  it("truncates on a word boundary rather than mid-word", () => {
    const out = plainTextForLabel("the harbour lantern turns amber at quarter past four", 20);
    expect(out).toBe("the harbour lantern…");
    // The old behaviour — a bare slice — would have said "the harbour lanter".
    expect(out).not.toContain("lanter…");
  });

  it("still truncates a single unbroken token", () => {
    // No word boundary to honour: cutting is better than an unbounded name.
    const out = plainTextForLabel("x".repeat(60), 20);
    expect(out).toBe("x".repeat(20) + "…");
  });

  it("reads a table as words, not as pipes", () => {
    // renderText draws these as a real table, so the walls are layout. Spoken
    // verbatim the old output was "pipe Part pipe Value pipe pipe dash dash
    // dash…", which is the whole label gone to punctuation.
    const table = "## Hardware\n| Part | Value |\n| --- | --- |\n| CPU | 6 cores |\n| RAM | 7.6 GB |";
    const spoken = plainTextForLabel(table);
    expect(spoken).toBe("Hardware Part Value CPU 6 cores RAM 7.6 GB");
    expect(spoken).not.toContain("|");
    expect(spoken).not.toContain("---");
  });

  it("speaks an escaped pipe as the pipe the table shows, not as a backslash", () => {
    // renderText puts a literal | in the cell for an escaped pipe. Splitting the label on
    // every bare | left the backslash in, so the reader heard "x backslash y"
    // while the table said "x | y". Both sides now use splitTableRow.
    const spoken = plainTextForLabel("| esc | x \\| y |");
    expect(spoken).toBe("esc x | y");
    expect(spoken).not.toContain("\\");
  });

  it("leaves a short plain message exactly as it is", () => {
    expect(plainTextForLabel("The lantern is green.")).toBe("The lantern is green.");
  });

  it("returns an empty string for whitespace-only text", () => {
    // The caller falls back to the bare "Audio reply" label on empty output,
    // so this must not produce a stray separator.
    expect(plainTextForLabel("   \n\n  ")).toBe("");
  });
});

describe("audioLabel", () => {
  /**
   * Shared by both chat surfaces since TASK-698 — the mascot chat and the
   * full-screen one each draw a player, and every previous rule about this
   * label had to be fixed twice.
   */
  it("names the clip by what the bubble shows", () => {
    expect(audioLabel("The lantern is green.", "Audio reply"))
      .toBe("Audio reply: The lantern is green.");
  });

  it("falls back to the bare prefix when there is nothing to say", () => {
    expect(audioLabel("", "Audio reply")).toBe("Audio reply");
    expect(audioLabel(undefined, "Audio reply")).toBe("Audio reply");
    expect(audioLabel("   \n ", "Audio reply")).toBe("Audio reply");
  });

  it("never announces a directive, because both surfaces lift them before rendering", () => {
    // The property the move exists to guarantee: a label is read out verbatim,
    // and the STORED text keeps its `EMAIL:` ids while a caption can carry a
    // `MEDIA:` path. Callers hand this the body text the bubble draws — the
    // one both directives have already been taken out of.
    const bodyText = "Here is the summary.";
    const label = audioLabel(bodyText, "Audio reply");
    expect(label).not.toContain("EMAIL:");
    expect(label).not.toContain("MEDIA:");
    expect(label).not.toContain("/home/clawbox/.openclaw/media");
  });

  it("keeps the label short enough to be useful out loud", () => {
    const long = "word ".repeat(60);
    const label = audioLabel(long, "Audio reply");
    // The prefix plus a budgeted 100 characters and the ellipsis.
    expect(label.length).toBeLessThan("Audio reply: ".length + 105);
    expect(label.endsWith("\u2026")).toBe(true);
  });
});
