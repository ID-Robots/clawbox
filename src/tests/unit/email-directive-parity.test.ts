import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

import { splitEmailRefs } from "@/lib/chat-email-refs";
import { stripEmailDirectives } from "../../../scripts/openclaw-plugins/clawbox-email-directives/email-directives.mjs";
import { EMAIL_DIRECTIVE_CASES } from "@/tests/fixtures/email-directive-cases";

// THE PIN. `EMAIL:<uid>` is understood in three places by three languages:
//
//   src/lib/chat-email-refs.ts                    the chat window's cards (TS)
//   scripts/hermes-plugins/…/email_directives.py    the Hermes plugin (Py)
//   scripts/openclaw-plugins/…/email-directives.mjs   the OpenClaw plugin (JS)
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
const PY_PLUGIN_DIR = path.join(REPO, "scripts/hermes-plugins/clawbox_email_directives");

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
  // ASSERTED, NOT SKIPPED ON. `describe.skip`/`it.skip` on a missing `python3`
  // turned the only thing standing between the three grammars into a green
  // no-op: the guard would leave the build with nothing saying so. That is the
  // same failure `check:sudoers` was given its own CI step for. `ubuntu-latest`
  // ships python3, so this costs nothing where it runs and is loud where it
  // would otherwise be silent.
  it("has a python3 to run the Hermes copy with — this suite is the drift guard", () => {
    expect(hasPython3).toBe(true);
  });

  it.each(EMAIL_DIRECTIVE_CASES)("TypeScript (the chat's own parser): $name", ({ input, stripped }) => {
    expect(splitEmailRefs(input).text).toBe(stripped);
  });

  it.each(EMAIL_DIRECTIVE_CASES)("JavaScript (the OpenClaw plugin): $name", ({ input, stripped }) => {
    expect(stripEmailDirectives(input)).toBe(stripped);
  });

  it("Python (the Hermes plugin) answers the whole table identically", () => {
    const answers = pythonAnswers(EMAIL_DIRECTIVE_CASES.map((c) => c.input));
    expect(answers).toEqual(EMAIL_DIRECTIVE_CASES.map((c) => c.stripped));
  });

  // The table above pins cases a person thought of. This pins the whole axis
  // the three languages actually disagree on: what counts as whitespace. It is
  // where the drift was found — JavaScript trims U+FEFF and Python does not,
  // Python strips U+001C-U+001F and JavaScript does not — so every character
  // anywhere near the boundary is put through all three and they must AGREE.
  // No expected value is written down here on purpose: agreement is the
  // property, and hardcoding an answer would just be a fourth opinion.
  const BOUNDARY_CODE_POINTS = [
    // C0 controls, which is where Python's str.strip() is broader.
    ...Array.from({ length: 0x20 }, (_, i) => i),
    0x7f,
    // Everything JavaScript calls WhiteSpace or a LineTerminator.
    0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
    // Near neighbours that are NOT whitespace in either language.
    0x200b, 0x200c, 0x200d, 0x2060, 0x180e,
  ];

  it("the three agree on every whitespace-boundary character", () => {
    const inputs: string[] = [];
    for (const cp of BOUNDARY_CODE_POINTS) {
      const c = String.fromCodePoint(cp);
      // Before the directive, inside it, around the payload, and against the
      // fence — the four places a trim decision changes the answer.
      inputs.push(`Done.\n${c}EMAIL:4471`);
      inputs.push(`Done.\nEMAIL:${c}4471${c}`);
      inputs.push(`Done.\nEMAIL:4471${c}`);
      inputs.push(`${c}\`\`\`\nEMAIL:1\n\`\`\``);
      // ...and INSIDE the quotes, which is the only position that separated
      // the two grammars: JavaScript's `.` excludes \r, \u2028 and \u2029 and
      // Python's excludes only \n, so with `\s*(.*)$` the JS copies kept a
      // line Python carded — 18 disagreements over exactly this sweep. The
      // three earlier positions could not see it, which is why it is here.
      for (const q of ["`", '"', "'"]) {
        inputs.push(`Done.\nEMAIL:${q}4471${c}${q}`);
        inputs.push(`Done.\nEMAIL:${q}${c}4471${q}`);
      }
    }
    const ts = inputs.map((raw) => splitEmailRefs(raw).text);
    const js = inputs.map((raw) => stripEmailDirectives(raw));
    const py = pythonAnswers(inputs);
    // Reported as a list of disagreements rather than a first-mismatch throw, so
    // a drift shows every character it affects in one run.
    const disagreements = inputs
      .map((raw, i) => ({ raw, ts: ts[i], js: js[i], py: py[i] }))
      .filter((row) => row.ts !== row.js || row.ts !== row.py)
      .map((row) => JSON.stringify(row));
    expect(disagreements).toEqual([]);
  });

  // ── The line grammar must be LINEAR in the length of a line ───────────────
  //
  // The parser's input is model output relaying attacker-influenced content: an
  // email body is exactly that. `^email:\s*(.*)$` made that a denial of
  // service — `\s*` and `.*` overlap on the space character, and `$` (no `m`
  // flag) can only match at the end of the input while `.` cannot cross `\r`,
  // `\u2028` or `\u2029`. A line that starts `email:`, carries a long run of
  // spaces and holds one of those three terminators away from its end forces
  // the engine through every split of the spaces between the two quantifiers.
  //
  // Measured on the old pattern through `stripEmailDirectives` on this machine:
  // 8.3 ms at 2,000 spaces, 134.4 ms at 8,000, 433.6 ms at 16,000, 1,924.4 ms at
  // 32,000 — 4x per doubling, the signature of an O(n^2) scan. An Orin Nano is
  // several times slower again, and the OpenClaw hook is fail-open with a 15 s
  // ceiling: the box pegs a core and then delivers the reply UNSTRIPPED.
  //
  // The same shape as `src/tests/unit/local-model-profile.test.ts`: a generous
  // absolute ceiling plus a growth ratio, because the point is the shape of the
  // curve and not a benchmark.
  describe("the line grammar is linear in the length of a line", () => {
    /** `email:` + n spaces + a line terminator that is not at the end. */
    const pathological = (n: number) => `email:${" ".repeat(n)}x\ry`;

    const timeMs = (strip: (raw: string) => string, input: string): number => {
      const started = performance.now();
      strip(input);
      return performance.now() - started;
    };

    /**
     * The FASTEST of five runs, not one run.
     *
     * The ratio below compares two sub-millisecond measurements, where a single
     * GC pause on a loaded runner is larger than the thing being measured. The
     * minimum is the robust statistic here: a pause has to land on all five
     * runs to move it. Measured over twelve rounds on this machine it gives the
     * same ratio to two decimal places every time; a single measurement did
     * not.
     */
    const bestMs = (strip: (raw: string) => string, input: string): number => {
      let best = Infinity;
      for (let i = 0; i < 5; i++) best = Math.min(best, timeMs(strip, input));
      return best;
    };

    const PARSERS: [string, (raw: string) => string][] = [
      ["TypeScript (the chat's own parser)", (raw) => splitEmailRefs(raw).text],
      ["JavaScript (the OpenClaw plugin)", (raw) => stripEmailDirectives(raw)],
    ];

    it.each(PARSERS)("%s does not blow up on a long run of spaces", (_name, strip) => {
      // Linear needs well under a millisecond for 100k characters; the old
      // pattern needs ~19 s here and ~5 s on a fast machine, so 2 s sits
      // between the two with room for a loaded CI runner.
      expect(timeMs(strip, pathological(100_000))).toBeLessThan(2_000);
    }, 60_000);

    it.each(PARSERS)("%s costs the same whether or not the line backtracks", (_name, strip) => {
      // The SAME LENGTH either way — the only difference is the `\r` held back
      // from the end, which is what the two quantifiers used to fight over. A
      // ratio rather than a wall clock, so this reads the algorithm and not the
      // machine: a linear scan answers both in the same time, the old pattern
      // needed 3,635x longer at 16k characters and 19,075x at 32k.
      const benign = (n: number) => `email:${" ".repeat(n)}xy`;
      // Warm the JIT so the first call's compile time is not read as cost.
      bestMs(strip, benign(1_000));
      bestMs(strip, pathological(1_000));
      const flat = Math.max(bestMs(strip, benign(32_000)), 0.05);
      const backtracking = bestMs(strip, pathological(32_000));
      // TWO WAYS TO PASS, because both sides are a fraction of a millisecond
      // and a ratio of two such numbers is noise over noise if either one is
      // disturbed. `backtracking` under 25 ms is on its own proof of a linear
      // scan — the old pattern needed 1,924 ms at this size, a 77x separation —
      // so the ratio only has to carry the argument when the absolute number is
      // large enough to mean something. Measured here: 0.05 ms and a ratio of
      // 0.46; with the old pattern, 570 ms and a ratio of 11,391.
      const linear = backtracking < 25 || backtracking / flat < 50;
      // Asserted as an object so a failure prints the numbers rather than
      // `expected false to be true`.
      expect({ backtracking, flat, ratio: backtracking / flat, linear }).toMatchObject({ linear: true });
    }, 60_000);
  });

  it("a non-string is not a crash in either plugin — a hook must never break delivery", () => {
    // The gateway hands the hook whatever the payload carried; `undefined` for
    // an attachment-only reply is the realistic one. Throwing here would be a
    // hook error on every such reply.
    expect(stripEmailDirectives(undefined as unknown as string)).toBe("");
    expect(stripEmailDirectives(null as unknown as string)).toBe("");
  });
});
