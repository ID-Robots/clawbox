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
// The plugin copies are deliberately allowed to be SHAPE-only. They do not know
// the verbs, and they must not: which words mean approve and which mean delete
// is a decision the device makes, and a plugin that split them would be a
// second place to get "no" wrong.

import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseApprovalReply } from "@/lib/email-approval-reply";

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
  // A verb and a code and NOTHING else. Everything below is conversation.
  { text: "send", approval: false },
  { text: "send it", approval: false },
  { text: "send the invoice AB2CD", approval: false },
  { text: "send AB2CD please", approval: false },
  { text: "AB2CD", approval: false },
  { text: "", approval: false },
  { text: "   ", approval: false },
  { text: "can you send Ivan the invoice tomorrow?", approval: false },
  // Length bounds, both ends, on both halves.
  { text: "send ABC", approval: false },
  { text: "send ABCDEFGHI", approval: false },
  { text: "supercalifra AB2CD", approval: false },
  // A newline is not whitespace a single-line command may hide behind: a
  // multi-line message is a message, and \s in one language is not \s in
  // another, which is exactly the drift this file exists to catch.
  { text: "send AB2CD\nand also mail Ivan", approval: false },
  // Stray whitespace at either end is trimmed off in all three, so this IS
  // the command; what a newline may never do is join two things into one.
  { text: "\nsend AB2CD", approval: true },
  { text: "send AB2CD\n", approval: true },
  { text: "hi\nsend AB2CD", approval: false },
  // Non-ASCII digits: `\d` means different things in Python and JavaScript.
  { text: "send ٢٣٤٥٦", approval: false },
  { text: "изпрати AB2CD", approval: false },
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

  it("the verbs live only on the device, never in a plugin", () => {
    // A plugin that learned the verbs would be a second place to decide what
    // "no" means. Asserted by reading the shipped files rather than by trusting
    // the comment that says so.
    for (const file of [MJS_PLUGIN, path.join(PY_PLUGIN_DIR, "approvals.py")]) {
      const source = fs.readFileSync(file, "utf-8");
      // The words appear in prose in both headers; what must not appear is a
      // set or list of them being tested against.
      expect(source).not.toMatch(/\bAPPROVE_WORDS\b|\bREJECT_WORDS\b/);
    }
  });
});
