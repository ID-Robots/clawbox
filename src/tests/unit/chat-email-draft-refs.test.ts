// `EMAIL_DRAFT:<id>` lines in an assistant reply become send-approval cards.

import { describe, expect, it } from "vitest";
import { MAX_DRAFT_REFS, parseDraftId, splitDraftRefs, streamingDraftRefsText } from "@/lib/chat-email-draft-refs";
import { splitEmailRefs } from "@/lib/chat-email-refs";

describe("splitDraftRefs", () => {
  it("lifts the directive out of the reply", () => {
    expect(splitDraftRefs("Here is the draft to Ivan.\n\nEMAIL_DRAFT:AAMk-1=")).toEqual({
      text: "Here is the draft to Ivan.",
      draftIds: ["AAMk-1="],
    });
  });

  it("forgives quoting and case, drops repeats, keeps order", () => {
    expect(splitDraftRefs("a\n`EMAIL_DRAFT:x1`\nemail_draft: \"y2\"\nEmail_Draft:x1")).toEqual({ text: "a", draftIds: ["x1", "y2"] });
    expect(splitDraftRefs("EMAIL_DRAFT:`x1`").draftIds).toEqual(["x1"]);
  });

  it("keeps a line that names nothing usable, and anything inside a code fence", () => {
    const raw = "Use it like this:\n```\nEMAIL_DRAFT:example\n```\nEMAIL_DRAFT:not an id\nEMAIL_DRAFT:";
    expect(splitDraftRefs(raw)).toEqual({ text: raw, draftIds: [] });
  });

  it("closes a fence only with its own marker, so a tilde example keeps its directive", () => {
    const raw = "Like this:\n```markdown\n~~~\nEMAIL_DRAFT:example\n~~~\n```";
    expect(splitDraftRefs(raw)).toEqual({ text: raw, draftIds: [] });
    // And a fence that really closes still ends.
    expect(splitDraftRefs("```\nEMAIL_DRAFT:example\n```\nEMAIL_DRAFT:d1").draftIds).toEqual(["d1"]);
  });

  it("only at the start of a line", () => {
    const raw = "I wrote EMAIL_DRAFT:abc for you";
    expect(splitDraftRefs(raw)).toEqual({ text: raw, draftIds: [] });
  });

  it("caps the cards under one reply, keeping the rest as text", () => {
    const lines = Array.from({ length: MAX_DRAFT_REFS + 2 }, (_, i) => `EMAIL_DRAFT:d${i}`);
    const split = splitDraftRefs(lines.join("\n"));
    expect(split.draftIds).toHaveLength(MAX_DRAFT_REFS);
    expect(split.text).toBe(lines.slice(MAX_DRAFT_REFS).join("\n"));
  });

  it("leaves a reply without a directive exactly as it was", () => {
    const raw = "  Spacing\n\n\n kept  ";
    expect(splitDraftRefs(raw).text).toBe(raw);
  });

  it("is not mistaken for, and does not disturb, the EMAIL: directive", () => {
    const raw = "Two things.\nEMAIL:4471\nEMAIL_DRAFT:d-9";
    const mail = splitEmailRefs(raw);
    expect(mail.uids).toEqual([4471]);
    expect(splitDraftRefs(mail.text)).toEqual({ text: "Two things.", draftIds: ["d-9"] });
  });

  it("reads ids by the server's pattern", () => {
    expect(parseDraftId(" AAMk+/= ")).toBe("AAMk+/=");
    expect(parseDraftId("a?b")).toBeNull();
    expect(parseDraftId("")).toBeNull();
  });
});

describe("streamingDraftRefsText", () => {
  it("never shows the directive while it is still arriving", () => {
    for (const tail of [
      "EMAIL_", "EMAIL_D", "EMAIL_DRAF", "EMAIL_DRAFT", "EMAIL_DRAFT:", "EMAIL_DRAFT:AAM", "EMAIL_DRAFT:`AAMk",
      // The whole-line backtick wrapper, still unfinished: neither the keyword
      // nor the id it already names may flash on screen.
      "`EMAIL_DR", "`EMAIL_DRAFT", "`EMAIL_DRAFT:", "`EMAIL_DRAFT:d1",
    ]) {
      expect(streamingDraftRefsText(`Ready.\n${tail}`), tail).toBe("Ready.");
    }
    expect(streamingDraftRefsText("Ready.\nEMAIL_DRAFT:x\nMore")).toBe("Ready.\nMore");
    // A finished wrapper is a card's directive, not a tail.
    expect(streamingDraftRefsText("Ready.\n`EMAIL_DRAFT:d1`")).toBe("Ready.");
    expect(streamingDraftRefsText("Plain text")).toBe("Plain text");
  });

  it("keeps ordinary text and a finished fenced example", () => {
    for (const raw of [
      "Ready.\nemail_drama",
      "Ready.\n`code`",
      "Ready.\nEMAIL_DRAFTS",
      "Show it:\n```\nEMAIL_DRAFT:example\n```",
    ]) {
      expect(streamingDraftRefsText(raw), raw).toBe(raw);
    }
  });

  it("stays linear on a long line of spaces", () => {
    const raw = `EMAIL_DRAFT:${" ".repeat(50_000)}\nx`;
    const started = performance.now();
    streamingDraftRefsText(raw);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
