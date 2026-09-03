/**
 * The `EMAIL:<uid>` grammar, as a table three implementations must agree on.
 *
 * `splitEmailRefs` (src/lib/chat-email-refs.ts) decides what a ClawBox chat
 * turns into a card. Two outbound plugins have to make the SAME decision on the
 * way to a channel or a voice — one inside the Hermes agent (Python), one
 * inside the OpenClaw gateway (JavaScript) — and neither can import the
 * TypeScript. So the rule lives in three files, and this table is what stops
 * them drifting: `src/tests/unit/email-directive-parity.test.ts` runs every
 * case through all three and asserts one answer.
 *
 * A case is `input` and the text that must come out. The ids are not asserted
 * here — only the plugins' output text is user-visible, and `splitEmailRefs`
 * already has its own suite for the uid list.
 */
export interface EmailDirectiveCase {
  /** What the case is pinning, in the words a failure should read as. */
  name: string;
  /** Assistant reply text as it arrives. */
  input: string;
  /** The text every implementation must produce. */
  stripped: string;
}

export const EMAIL_DIRECTIVE_CASES: EmailDirectiveCase[] = [
  {
    name: "the directive lines the owner saw in Telegram",
    input: "Here are your last two emails.\nEMAIL:10960\nEMAIL:10959",
    stripped: "Here are your last two emails.",
  },
  {
    name: "backticks, which is how this repo's own instruction writes the id",
    input: "The email is waiting for your approval.\nEMAIL:`4471`",
    stripped: "The email is waiting for your approval.",
  },
  {
    name: "double quotes",
    input: 'Done.\nEMAIL:"4471"',
    stripped: "Done.",
  },
  {
    name: "single quotes",
    input: "Done.\nEMAIL:'4471'",
    stripped: "Done.",
  },
  {
    name: "lower case and padding",
    input: "Done.\n   email:  4471   ",
    stripped: "Done.",
  },
  {
    name: "a reply with no directive is returned untouched",
    input: "Your ClawBox is ready.",
    stripped: "Your ClawBox is ready.",
  },
  {
    name: "prose that merely contains the word is not a directive",
    input: "Reply to that address — email: bob@example.com — and it will reach me.",
    stripped: "Reply to that address — email: bob@example.com — and it will reach me.",
  },
  {
    name: "a payload that is not an id is KEPT, never silently swallowed",
    input: "I could not find it.\nEMAIL:not-a-number",
    stripped: "I could not find it.\nEMAIL:not-a-number",
  },
  {
    name: "zero is not a UID",
    input: "Done.\nEMAIL:0",
    stripped: "Done.\nEMAIL:0",
  },
  {
    name: "past the 32-bit UID range",
    input: "Done.\nEMAIL:4294967296",
    stripped: "Done.\nEMAIL:4294967296",
  },
  {
    name: "the top of the UID range is a UID",
    input: "Done.\nEMAIL:4294967295",
    stripped: "Done.",
  },
  {
    name: "a signed number is model output that only starts like one",
    input: "Done.\nEMAIL:+7",
    stripped: "Done.\nEMAIL:+7",
  },
  {
    name: "a decimal is not a UID either",
    input: "Done.\nEMAIL:7.0",
    stripped: "Done.\nEMAIL:7.0",
  },
  {
    name: "Arabic-Indic digits are not ASCII digits (Python's \\d says otherwise)",
    input: "Done.\nEMAIL:٤٤٧١",
    stripped: "Done.\nEMAIL:٤٤٧١",
  },
  {
    name: "a dotted capital I is not an ASCII i (Python's IGNORECASE says otherwise)",
    // U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE. Python's `re.IGNORECASE`
    // is Unicode-aware and folds it onto `i`, so `EMAİL:7` matched the keyword
    // and the Hermes copy DELETED a line the chat window and the OpenClaw
    // plugin both keep as text — ECMAScript's `/i` canonicalisation refuses any
    // non-ASCII character whose fold is ASCII. `re.ASCII` is what makes the
    // three read the keyword identically. The first line is there because all
    // three bail out early on a reply with no ASCII `email:` in it at all.
    input: "Done.\nEMAIL:4471\nEMAİL:7",
    stripped: "Done.\nEMAİL:7",
  },
  {
    name: "a dotless i is not an ASCII i either",
    // U+0131 LATIN SMALL LETTER DOTLESS I, the other half of the Turkish pair:
    // Python folds it onto `I` and stripped `emaıl:7` as well.
    input: "Done.\nEMAIL:4471\nemaıl:7",
    stripped: "Done.\nemaıl:7",
  },
  {
    name: "a byte-order mark before the directive is still a directive",
    // JavaScript's trim() and \s remove U+FEFF; Python's str.strip() does not.
    // Left to each language's default, the Hermes plugin kept this line and the
    // owner got `EMAIL:4471` on Telegram — the exact bug this task closes.
    input: "Done.\n\uFEFFEMAIL:4471",
    stripped: "Done.",
  },
  {
    name: "a file separator is not whitespace to JavaScript, so the line stays text",
    // The other direction: U+001C-U+001F are whitespace to Python and not to
    // JavaScript, so the Python copy would have DELETED a line the chat window
    // keeps — and mis-tracked the fence state on the way past.
    input: "Done.\n\u001cEMAIL:4471",
    stripped: "Done.\n\u001cEMAIL:4471",
  },
  {
    name: "an ideographic space is whitespace to both",
    input: "Done.\n\u3000EMAIL:\u30004471\u3000",
    stripped: "Done.",
  },
  {
    name: "a non-breaking space around the payload trims",
    input: "Done.\nEMAIL:\u00a04471\u00a0",
    stripped: "Done.",
  },
  {
    name: "a reply EXPLAINING the syntax keeps it, because a fence is not a directive",
    input: "Write it like this:\n```\nEMAIL:4471\n```\nand the chat makes a card.",
    stripped: "Write it like this:\n```\nEMAIL:4471\n```\nand the chat makes a card.",
  },
  {
    name: "a tilde fence counts as a fence",
    input: "Like so:\n~~~\nEMAIL:4471\n~~~",
    stripped: "Like so:\n~~~\nEMAIL:4471\n~~~",
  },
  {
    name: "a repeated id is dropped once and not twice",
    input: "One message.\nEMAIL:7\nEMAIL:7",
    stripped: "One message.",
  },
  {
    name: "a directive between two paragraphs leaves the prose joined",
    input: "Above.\nEMAIL:1\nBelow.",
    stripped: "Above.\nBelow.",
  },
  {
    name: "the blank line a removed directive leaves behind is collapsed",
    input: "Above.\n\nEMAIL:1\n\nBelow.",
    stripped: "Above.\n\nBelow.",
  },
  {
    name: "past the cap of 25 the line goes back to being text",
    input: [
      "Twenty-six of them.",
      ...Array.from({ length: 26 }, (_, i) => `EMAIL:${i + 1}`),
    ].join("\n"),
    stripped: "Twenty-six of them.\nEMAIL:26",
  },
  {
    name: "a line terminator INSIDE the quotes — the axis the three used to differ on",
    // JavaScript's `.` excludes \r, \u2028 and \u2029; Python's excludes only
    // \n. With `\s*(.*)$` the JS copies could not match past the \r and kept
    // the line, while Python matched, unwrapped the quotes and carded it —
    // 27 disagreements across a generated sweep, all this one shape. `[\s\S]`
    // is what makes the three read the payload identically.
    input: "Done.\nEMAIL:'4471\r'",
    stripped: "Done.",
  },
  {
    name: "a line separator inside the quotes reads the same way",
    input: "Done.\nEMAIL:`4471\u2028`",
    stripped: "Done.",
  },
  {
    name: "a paragraph separator inside the quotes reads the same way",
    input: 'Done.\nEMAIL:"4471\u2029"',
    stripped: "Done.",
  },
  {
    name: "a directive whose payload is only spaces and a line terminator is still text",
    // The pathological shape from the ReDoS test, at a length a person can
    // read: it must cost nothing AND still be kept, because it names no id.
    input: "Done.\nEMAIL:      x\ry",
    stripped: "Done.\nEMAIL:      x\ry",
  },
  {
    name: "a reply that merely MENTIONS an address is not re-spaced either",
    // The word `email:` is not a licence to reformat: this reply carries no
    // directive, so it must leave exactly as it arrived — trailing newline,
    // blank run and all — the same as one that never says the word.
    input: "Mail me: email: bob@example.com\n\n\n\nRegards,\n",
    stripped: "Mail me: email: bob@example.com\n\n\n\nRegards,\n",
  },
  {
    name: "the empty string",
    input: "",
    stripped: "",
  },
  {
    name: "a reply that is nothing but a directive strips to nothing",
    input: "EMAIL:4471",
    stripped: "",
  },
];
