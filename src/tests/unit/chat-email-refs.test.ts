import { describe, expect, it } from "vitest";
import { dropUnfinishedDirective, splitEmailRefs, streamingEmailRefsText } from "@/lib/chat-email-refs";

describe("lifting EMAIL: directives out of a reply", () => {
  it("takes the ids and leaves the prose", () => {
    const { text, uids } = splitEmailRefs(
      ["Here are your last two emails.", "EMAIL:4471", "EMAIL:4468"].join("\n"),
    );
    expect(text).toBe("Here are your last two emails.");
    expect(uids).toEqual([4471, 4468]);
  });

  it("leaves a reply with no directive completely alone", () => {
    const raw = "You have no new mail.";
    expect(splitEmailRefs(raw)).toEqual({ text: raw, uids: [] });
  });

  it("collapses the hole a removed line leaves in the middle of a reply", () => {
    const { text } = splitEmailRefs(["First.", "", "EMAIL:12", "", "Second."].join("\n"));
    expect(text).toBe("First.\n\nSecond.");
  });

  it("keeps the same message from being listed twice", () => {
    expect(splitEmailRefs("EMAIL:5\nEMAIL:5\nEMAIL:6").uids).toEqual([5, 6]);
  });

  it("ignores a directive inside a fenced code block, which is being explained", () => {
    const raw = ["To point at a message, write:", "```", "EMAIL:123", "```"].join("\n");
    const { text, uids } = splitEmailRefs(raw);
    expect(uids).toEqual([]);
    expect(text).toContain("EMAIL:123");
  });

  it("unwraps the quoting a model tends to add", () => {
    expect(splitEmailRefs("EMAIL:`4471`").uids).toEqual([4471]);
    expect(splitEmailRefs('EMAIL:"4471"').uids).toEqual([4471]);
  });

  it("tolerates leading whitespace on the line", () => {
    expect(splitEmailRefs("   EMAIL: 4471").uids).toEqual([4471]);
  });

  it("is case-insensitive, because a model will not be consistent", () => {
    expect(splitEmailRefs("Email:4471").uids).toEqual([4471]);
  });
});

describe("payloads that are not a message id", () => {
  it.each([
    ["a bare directive", "EMAIL:"],
    ["prose", "EMAIL: the one from Jane"],
    ["zero", "EMAIL:0"],
    ["negative", "EMAIL:-3"],
    ["a decimal", "EMAIL:7.0"],
    ["hex", "EMAIL:0x1f"],
    ["beyond the UID range", "EMAIL:99999999999"],
    ["a number with a tail", "EMAIL:12 or so"],
  ])("keeps %s as text rather than making a card from it", (_label, raw) => {
    const { text, uids } = splitEmailRefs(raw);
    expect(uids).toEqual([]);
    // Kept, not swallowed: dropping it would hide that the agent meant to
    // point at something.
    expect(text).toContain("EMAIL:");
  });

  it("does not treat a mention of email mid-sentence as a directive", () => {
    const raw = "Send an email:4471 is the reference number.";
    expect(splitEmailRefs(raw).uids).toEqual([]);
  });

  it("caps how many cards one reply can produce", () => {
    const raw = Array.from({ length: 100 }, (_, i) => `EMAIL:${i + 1}`).join("\n");
    expect(splitEmailRefs(raw).uids.length).toBeLessThanOrEqual(25);
  });

  it("carries no message content, only ids", () => {
    // The directive is an id and nothing else — a summary must not quietly
    // become a copy of the mail.
    const { uids } = splitEmailRefs("EMAIL:4471 Subject: something private");
    expect(uids).toEqual([]);
  });
});

describe("what happens at the cap (CodeRabbit #499)", () => {
  it("keeps the directives past the cap as TEXT rather than losing them", () => {
    // The rule this function follows: a line may be REMOVED only when it has
    // been turned into a card. Past the cap it becomes neither, so it stays.
    const raw = Array.from({ length: 30 }, (_, i) => `EMAIL:${i + 1}`).join("\n");
    const { text, uids } = splitEmailRefs(raw);
    expect(uids).toHaveLength(25);
    expect(text).toContain("EMAIL:26");
    expect(text).toContain("EMAIL:30");
    expect(text).not.toContain("EMAIL:25");
  });

  it("still drops a repeat, which would only duplicate a card already shown", () => {
    const { text, uids } = splitEmailRefs("Summary.\nEMAIL:7\nEMAIL:7");
    expect(uids).toEqual([7]);
    expect(text).toBe("Summary.");
  });
});

describe("the half-arrived directive in a live bubble", () => {
  it("hides a directive whose digits have not streamed yet", () => {
    // One frame of "EMAIL:" under the summary is exactly the flash the strip
    // exists to prevent — the line parses and vanishes a moment later.
    expect(streamingEmailRefsText("Jane sent the plan.\nEMAIL:")).toBe("Jane sent the plan.");
    expect(streamingEmailRefsText("Jane sent the plan.\nEMAIL: ")).toBe("Jane sent the plan.");
  });

  it("hides one whose digits have partly arrived", () => {
    expect(streamingEmailRefsText("Jane sent the plan.\nEMAIL:44")).toBe("Jane sent the plan.");
  });

  it("leaves the word alone inside a code fence, exactly as the parser does", () => {
    // The completed line would not be lifted out there, so neither is this one:
    // the fence rule is the parser's, and this asks it rather than restating it.
    const raw = "Here is the syntax:\n```\nEMAIL:";
    expect(streamingEmailRefsText(raw)).toBe(raw);
  });

  it("leaves prose that merely ends with the word alone", () => {
    const raw = "I could not reach your email:";
    expect(streamingEmailRefsText(raw)).toBe(raw);
  });

  it("hides the word before its colon has arrived", () => {
    // The likelier intermediate of the two: deltas are token-sized, so `EMAIL`
    // lands one frame ahead of `:`. A rule that started at the colon put the
    // word itself on screen for that frame and then took it away.
    expect(streamingEmailRefsText("Jane sent the plan.\nEMAIL")).toBe("Jane sent the plan.");
    expect(streamingEmailRefsText("Jane sent the plan.\nEMAI")).toBe("Jane sent the plan.");
    expect(streamingEmailRefsText("Jane sent the plan.\nE")).toBe("Jane sent the plan.");
  });

  it("hides one whose id repeats a card already on screen", () => {
    // Counting the ids answered "no new id, so this is not a directive" here:
    // the completed line is a REPEAT, the parser drops it, and the count that
    // was supposed to prove it a directive never moved. Reachable the moment a
    // listed message's uid is `1`.
    expect(streamingEmailRefsText("Summary.\nEMAIL:1\nEMAIL:")).toBe("Summary.");
    expect(streamingEmailRefsText("Summary.\nEMAIL:1\nEMAIL")).toBe("Summary.");
  });

  it("leaves one past the cap alone, because the finished line stays too", () => {
    // At the cap the parser keeps a completed directive AS TEXT, so there is
    // nothing to hide from: the line the owner sees being typed is the line
    // that will still be there when it is done. Hiding it would be the flash
    // in the other direction.
    const full = Array.from({ length: 25 }, (_, i) => `EMAIL:${i + 1}`).join("\n");
    expect(streamingEmailRefsText(`Summary.\n${full}\nEMAIL:`)).toBe("Summary.\nEMAIL:");
    expect(splitEmailRefs(`Summary.\n${full}\nEMAIL:4471`).text).toBe("Summary.\nEMAIL:4471");
  });

  it("leaves a payload that can no longer become an id alone", () => {
    // Ten digits past MAX_UID is not a directive still being typed — no further
    // digit rescues it — so it has settled as text and the parser decides.
    const raw = "Summary.\nEMAIL:9999999999";
    expect(streamingEmailRefsText(raw)).toBe(raw);
    expect(streamingEmailRefsText("Summary.\nEMAIL:12345678901")).toBe("Summary.\nEMAIL:12345678901");
  });

  it("hides a payload whose opening quote has arrived but not its closing one", () => {
    // `unwrapQuoted` accepts backticks, and the tool instruction writes the id
    // in them, so a model copying that formatting streams `EMAIL:\`4471\``. The
    // opening quote makes the payload unusable until the closing one lands, so
    // without this the line showed as text and then vanished into a card — the
    // one direction this function exists to rule out.
    expect(streamingEmailRefsText("Summary.\nEMAIL:`")).toBe("Summary.");
    expect(streamingEmailRefsText("Summary.\nEMAIL:`4471")).toBe("Summary.");
    expect(streamingEmailRefsText('Summary.\nEMAIL:"44')).toBe("Summary.");
    // And the finished form is hidden too, so it never appears at all.
    expect(streamingEmailRefsText("Summary.\nEMAIL:`4471`")).toBe("Summary.");
  });

  it("is the ordinary split for anything not still being typed", () => {
    const raw = "Jane sent the plan.\nEMAIL:4471\nAnd that is all.";
    expect(streamingEmailRefsText(raw)).toBe(splitEmailRefs(raw).text);
  });
});

describe("the directive an interrupted turn was in the middle of writing", () => {
  it("drops a half-written trailing directive from the stored turn", () => {
    // Stop stores the streaming buffer, and the render keeps an unusable
    // directive as text — so this line stayed in the transcript for good,
    // after the bubble had spent the whole turn hiding it.
    expect(dropUnfinishedDirective("Jane sent the plan.\nEMAIL:")).toBe("Jane sent the plan.");
    expect(dropUnfinishedDirective("Jane sent the plan.\nEMAIL")).toBe("Jane sent the plan.");
    expect(dropUnfinishedDirective("Jane sent the plan.\nE")).toBe("Jane sent the plan.");
  });

  it("keeps every finished directive, which is what the cards are made from", () => {
    const raw = "Summary.\nEMAIL:4471\nEMAIL:4468";
    expect(dropUnfinishedDirective(raw)).toBe(raw);
  });

  it("keeps a trailing directive that already parses, half-typed id or not", () => {
    // The line the abort caught at `EMAIL:44` may have been heading for
    // `EMAIL:4471`, and nothing can tell the two apart. It is kept, because
    // "unfinished" here means what the PARSER cannot use: dropping every
    // trailing directive instead would take the last card off every
    // interrupted turn, which is the defect this suite's siblings pin.
    // A wrong id opens a different message of the owner's own and can do no
    // more than that — see the id-carries-nothing-else note at the top.
    expect(dropUnfinishedDirective("Jane sent the plan.\nEMAIL:44")).toBe("Jane sent the plan.\nEMAIL:44");
  });

  it("keeps the prose, and touches nothing that is not a directive", () => {
    expect(dropUnfinishedDirective("I could not reach your email:")).toBe("I could not reach your email:");
    expect(dropUnfinishedDirective("Here is the syntax:\n```\nEMAIL:")).toBe("Here is the syntax:\n```\nEMAIL:");
    expect(dropUnfinishedDirective("Summary.\nEMAIL:9999999999")).toBe("Summary.\nEMAIL:9999999999");
  });

  it("leaves nothing behind when the buffer was only the directive", () => {
    // The caller stores nothing for an empty turn, which is the right outcome:
    // an id with no answer around it was never worth keeping.
    expect(dropUnfinishedDirective("EMAIL:")).toBe("");
  });

  it("stores exactly what the bubble was showing", () => {
    // The two must not answer differently — one question, asked once.
    for (const raw of [
      "Jane sent the plan.\nEMAIL:",
      "Summary.\nEMAIL:1\nEMAIL",
      "Summary.\nEMAIL:4471\nAnd that is all.",
      "I could not reach your email:",
    ]) {
      expect(splitEmailRefs(dropUnfinishedDirective(raw)).text).toBe(streamingEmailRefsText(raw));
    }
  });
});
