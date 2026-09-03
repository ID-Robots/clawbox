import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

import { splitEmailRefs } from "@/lib/chat-email-refs";
import { stripEmailDirectives } from "../../../scripts/openclaw-plugins/clawbox-email-directives/email-directives.mjs";
import { EMAIL_DIRECTIVE_CASES } from "@/tests/fixtures/email-directive-cases";

// THE PIN. `EMAIL:<uid>` is understood in three places by three languages:
//
//   src/lib/chat-email-refs.ts                    the chat window's cards (TS)
//   scripts/hermes-plugins/hooks/…/email_directives.py   the Hermes plugin (Py)
//   scripts/openclaw-plugins/…/email-directives.mjs      the OpenClaw plugin (JS)
//
// They cannot share a file — each is loaded by a different runtime, two of them
// inside a harness's own process — so the risk is drift: a rule tightened in
// one and not the others, and a line the chat keeps as text silently stripped
// from a Telegram reply (or the other way round, which is the bug this whole
// task exists to remove). This file is the only thing standing against that: it
// runs one case table through all three and asserts a single answer.
//
// A `\d` that means something different in Python than in JavaScript is exactly
// the shape of drift meant here, which is why the table carries Arabic-Indic
// digits.

const REPO = path.resolve(__dirname, "../../..");
const PY_PLUGIN_DIR = path.join(REPO, "scripts/hermes-plugins/hooks/clawbox_email_directives");

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Every case through the Python module in ONE interpreter start: a spawn per
 * case turned a 20 ms assertion into a second of process setup.
 */
function pythonAnswers(inputs: string[]): string[] {
  const program = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from email_directives import strip_email_directives",
    "print(json.dumps([strip_email_directives(t) for t in json.loads(sys.stdin.read())]))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", program, PY_PLUGIN_DIR], {
    input: JSON.stringify(inputs),
    encoding: "utf-8",
  });
  return JSON.parse(out);
}

describe("EMAIL: directive grammar — one rule, three implementations", () => {
  it.each(EMAIL_DIRECTIVE_CASES)("TypeScript (the chat's own parser): $name", ({ input, stripped }) => {
    expect(splitEmailRefs(input).text).toBe(stripped);
  });

  it.each(EMAIL_DIRECTIVE_CASES)("JavaScript (the OpenClaw plugin): $name", ({ input, stripped }) => {
    expect(stripEmailDirectives(input)).toBe(stripped);
  });

  (hasPython3 ? it : it.skip)("Python (the Hermes plugin) answers the whole table identically", () => {
    const answers = pythonAnswers(EMAIL_DIRECTIVE_CASES.map((c) => c.input));
    expect(answers).toEqual(EMAIL_DIRECTIVE_CASES.map((c) => c.stripped));
  });

  it("a non-string is not a crash in either plugin — a hook must never break delivery", () => {
    // The gateway hands the hook whatever the payload carried; `undefined` for
    // an attachment-only reply is the realistic one. Throwing here would be a
    // hook error on every such reply.
    expect(stripEmailDirectives(undefined as unknown as string)).toBe("");
    expect(stripEmailDirectives(null as unknown as string)).toBe("");
  });
});
