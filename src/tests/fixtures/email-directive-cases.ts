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
