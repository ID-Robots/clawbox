import { describe, expect, it } from "vitest";
import { splitEmailRefs } from "@/lib/chat-email-refs";

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
