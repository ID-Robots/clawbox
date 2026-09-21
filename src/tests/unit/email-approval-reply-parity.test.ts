// THE PIN for "is this message an approval reply?", across three languages.
//
// The rule lives in three places, and it has to, because each is loaded by a
// different runtime and two of them run inside a harness's own process:
//
//   src/lib/email-approval-reply.ts                    the authority (TS)
//   scripts/openclaw-plugins/…/email-approvals.mjs     the before_dispatch hook (JS)
//   scripts/hermes-plugins/…/approvals.py              the pre_gateway_dispatch hook (Py)
//
// The two plugin copies exist for one reason: the hook runs on EVERY inbound
// message on every channel, and only a message that already looks like an
// approval may cost an HTTP call. So each plugin applies the shape locally
// first — and the moment one of them drifts, the owner types "send AB2CD" on
// one edition and it works, on the other it reaches the agent instead.
//
// Drift in the LOOSE direction is the one that matters most and is asserted
// hardest below: a plugin whose shape is wider than the TS parser's posts
// ordinary conversation to /setup-api/email/chat-reply, where it is refused —
// so nothing is sent, but every such message pays a loopback round trip on the
// gateway's own dispatch path. Drift the other way is worse for the owner: an
// approval that never leaves the plugin.
//
// THE VERBS ARE PART OF THE SHAPE, in all three. They were left out of the two
// plugin copies at first — "which words mean approve is the device's decision"
// — and that made this file blind to the bug it exists to catch: a bare
// `[A-Za-z]{1,10}` matches "hello", so "hello there" and "good night" were
// posted to /email/chat-reply on their way past and counted against its attempt
// budget, and the table had no such case in it, so every assertion passed. The
// plugins still DECIDE nothing — approve-versus-delete is settled once, on the
// device — they only decide whether to ask.

import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { APPROVE_WORDS, REJECT_WORDS, parseApprovalReply } from "@/lib/email-approval-reply";

// Starts a real python3: vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const PY_PLUGIN_DIR = path.join(REPO, "scripts/hermes-plugins/clawbox_email_directives");
const MJS_PLUGIN = path.join(
  REPO,
  "scripts/openclaw-plugins/clawbox-email-directives/email-approvals.mjs",
);

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Messages that must reach the shape test on all three, and messages that must
 * not. The point of the table is the BOUNDARY: what a person types beside an
 * approval, and what an approval looks like when it is nearly one.
 */
const CASES: { text: string; approval: boolean }[] = [
  // The thing itself, in the forms a phone keyboard produces.
  { text: "send AB2CD", approval: true },
  { text: "SEND ab2cd", approval: true },
  { text: " approve  AB2CD ", approval: true },
  { text: "delete AB2CD", approval: true },
  { text: "deny AB2CD", approval: true },
  { text: "no AB2CD", approval: true },
  // Both one-letter verbs, which the alternation has to reach past the longer
  // words that start with the same letter.
  { text: "y AB2CD", approval: true },
  { text: "n AB2CD", approval: true },
  // ORDINARY TWO-WORD CONVERSATION. These are the cases whose absence made this
  // file green while every one of them was being posted to the device.
  { text: "hello there", approval: false },
  { text: "thanks again", approval: false },
  { text: "good night", approval: false },
  { text: "call later", approval: false },
  { text: "see Peter", approval: false },
  { text: "ok done", approval: false },
  { text: "sending AB2CD", approval: false },
  // A verb and a code and NOTHING else. Everything below is conversation.
  { text: "send", approval: false },
  { text: "send it", approval: false },
  { text: "send the invoice AB2CD", approval: false },
  { text: "send AB2CD please", approval: false },
  { text: "AB2CD", approval: false },
  { text: "", approval: false },
  { text: "   ", approval: false },
  { text: "can you send Ivan the invoice tomorrow?", approval: false },
  // The code is five characters, exactly — the length the store mints.
  { text: "send AB2C", approval: false },
  { text: "send AB2CDE", approval: false },
  // A newline is not whitespace a single-line command may hide behind: a
  // multi-line message is a message, and \s in one language is not \s in
  // another, which is exactly the drift this file exists to catch.
  { text: "send AB2CD\nand also mail Ivan", approval: false },
  // Stray whitespace at either end is trimmed off in all three, so this IS
  // the command; what a newline may never do is join two things into one.
  { text: "\nsend AB2CD", approval: true },
  { text: "send AB2CD\n", approval: true },
  { text: "hi\nsend AB2CD", approval: false },
  // U+FEFF: whitespace to JavaScript's trim(), not to Python's strip(). Left
  // unhandled this one character made the same pasted code an approval on one
  // edition and conversation on the other.
  { text: "send AB2CD\ufeff", approval: true },
  { text: "\ufeffsend AB2CD", approval: true },
  // Non-ASCII digits: `\d` means different things in Python and JavaScript.
  { text: "send \u0662\u0663\u0664\u0665\u0666", approval: false },
  { text: "\u0438\u0437\u043f\u0440\u0430\u0442\u0438 AB2CD", approval: false },
];

/** The mjs plugin's own predicate, exercised through the module it ships. */
async function jsShape(inputs: string[]): Promise<boolean[]> {
  const mod = (await import(MJS_PLUGIN)) as { looksLikeApproval?: (t: string) => boolean };
  // Exported for exactly this test; a plugin that stops exporting it has moved
  // the rule somewhere this file cannot see, which is a failure in itself.
  expect(typeof mod.looksLikeApproval).toBe("function");
  return inputs.map((text) => mod.looksLikeApproval!(text));
}

/** Every case through the Python module in ONE interpreter start. */
function pythonShape(inputs: string[]): boolean[] {
  const program = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from approvals import looks_like_approval",
    "print(json.dumps([looks_like_approval(t) for t in json.loads(sys.stdin.read())]))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", program, PY_PLUGIN_DIR], {
    input: JSON.stringify(inputs),
    encoding: "utf-8",
  });
  return JSON.parse(out) as boolean[];
}

describe("the approval reply shape, on both harnesses and on the device", () => {
  it("the TS parser answers the table", () => {
    for (const { text, approval } of CASES) {
      expect({ text, approval: parseApprovalReply(text) !== null }).toEqual({ text, approval });
    }
  });

  it("the OpenClaw plugin's shape agrees with the TS parser, case for case", async () => {
    const answers = await jsShape(CASES.map((c) => c.text));
    for (const [i, { text, approval }] of CASES.entries()) {
      expect({ text, shape: answers[i] }).toEqual({ text, shape: approval });
    }
  });

  it.skipIf(!hasPython3)("the Hermes plugin's shape agrees with the TS parser, case for case", () => {
    const answers = pythonShape(CASES.map((c) => c.text));
    for (const [i, { text, approval }] of CASES.entries()) {
      expect({ text, shape: answers[i] }).toEqual({ text, shape: approval });
    }
  });

  it("both plugins carry the SAME word list the device does", () => {
    // The lists are three literals in three languages; nothing can share them.
    // So they are compared here, by value, rather than trusted to a comment —
    // a verb added on the device and not in a plugin is an approval the owner
    // types that never leaves his phone.
    const expected = [...APPROVE_WORDS, ...REJECT_WORDS].map((w) => w.toLowerCase()).sort();

    const fromMjs = /APPROVAL_WORDS = \[([\s\S]*?)\]/.exec(fs.readFileSync(MJS_PLUGIN, "utf-8"));
    expect(fromMjs).not.toBeNull();
    expect([...fromMjs![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort()).toEqual(expected);

    const py = fs.readFileSync(path.join(PY_PLUGIN_DIR, "approvals.py"), "utf-8");
    const fromPy = /APPROVAL_WORDS = \(([\s\S]*?)\)/.exec(py);
    expect(fromPy).not.toBeNull();
    expect([...fromPy![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort()).toEqual(expected);
  });
});
