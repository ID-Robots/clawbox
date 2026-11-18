import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

import { splitDraftRefs } from "@/lib/chat-email-draft-refs";
import { splitEmailRefs } from "@/lib/chat-email-refs";
import {
  stripDraftDirectives,
  stripEmailDirectives,
} from "../../../scripts/openclaw-plugins/clawbox-email-directives/email-directives.mjs";

// Starts a python3 process: vitest's 5 s default is not enough on a loaded CI
// runner (src/tests/unit/test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// THE PIN for `EMAIL_DRAFT:<id>` — a draft waiting for the person's Send.
//
//   src/lib/chat-email-draft-refs.ts                   the chat's send-approval cards (TS)
//   scripts/openclaw-plugins/…/email-directives.mjs    stripped on OpenClaw's channels (JS)
//   scripts/hermes-plugins/…/email_directives.py       stripped on Hermes' channels (Py)
//
// A line the chat turns into a card must be stripped from a Telegram reply,
// and a line the chat keeps as text must reach Telegram unchanged. Each
// plugin strips `EMAIL:` lines first and then `EMAIL_DRAFT:` lines, the order
// the chat applies them in, so that order is what is compared.

const REPO = path.resolve(__dirname, "../../..");
const PY_PLUGIN_DIR = path.join(REPO, "scripts/hermes-plugins/clawbox_email_directives");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const chat = (raw: string): string => splitDraftRefs(splitEmailRefs(raw).text).text;
const openclaw = (raw: string): string => stripDraftDirectives(stripEmailDirectives(raw));

function hermes(inputs: string[]): string[] {
  const program = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from email_directives import strip_draft_directives, strip_email_directives",
    "print(json.dumps([strip_draft_directives(strip_email_directives(t)) for t in json.loads(sys.stdin.read())]))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", program, PY_PLUGIN_DIR], { input: JSON.stringify(inputs), encoding: "utf-8" }));
}

/** Input, and what every surface must deliver. */
const CASES: [string, string][] = [
  ["I drafted it.\n\nEMAIL_DRAFT:AAMk-1=", "I drafted it."],
  ["Done.\n`EMAIL_DRAFT:AAMk-1=`", "Done."],
  ["Done.\nEMAIL_DRAFT:`AAMk-1=`", "Done."],
  ["Done.\nemail_draft: \"x1\"\nEmail_Draft:x1", "Done."],
  ["Two.\nEMAIL:4471\nEMAIL_DRAFT:d-9", "Two."],
  ["```\nEMAIL_DRAFT:example\n```", "```\nEMAIL_DRAFT:example\n```"],
  // A tilde run INSIDE a backtick fence is content, not that fence's closer:
  // the directive stays inside the example and never becomes a card.
  ["```markdown\n~~~\nEMAIL_DRAFT:example\n~~~\n```", "```markdown\n~~~\nEMAIL_DRAFT:example\n~~~\n```"],
  // The same the other way round, and a longer closer than its opener.
  ["~~~\n```\nEMAIL_DRAFT:example\n```\n~~~", "~~~\n```\nEMAIL_DRAFT:example\n```\n~~~"],
  ["````\nEMAIL_DRAFT:example\n```\nEMAIL_DRAFT:example\n````", "````\nEMAIL_DRAFT:example\n```\nEMAIL_DRAFT:example\n````"],
  // A fence that closes still ends: the line after it is a directive again.
  ["```\nEMAIL_DRAFT:example\n```\nEMAIL_DRAFT:d1", "```\nEMAIL_DRAFT:example\n```"],
  ["Use EMAIL_DRAFT:abc inline", "Use EMAIL_DRAFT:abc inline"],
  ["EMAIL_DRAFT:not an id", "EMAIL_DRAFT:not an id"],
  ["EMAIL_DRAFT:", "EMAIL_DRAFT:"],
  ["EMAIL_DRAFT:..", "EMAIL_DRAFT:.."],
  ["EMAIL_DRAFT:.", "EMAIL_DRAFT:."],
  ["EMAIL_DRAFT:a..b", ""],
  ["EMAIL_DRAFT:abc@mail.example", ""],
  [`EMAIL_DRAFT:${"a".repeat(512)}`, ""],
  [`EMAIL_DRAFT:${"a".repeat(513)}`, `EMAIL_DRAFT:${"a".repeat(513)}`],
  ["x\r\nEMAIL_DRAFT:d1\r\ny", "x\r\ny"],
  ["EMAIL-DRAFT:d1", "EMAIL-DRAFT:d1"],
  ["EMAIL_DRAFTS:d1", "EMAIL_DRAFTS:d1"],
  [Array.from({ length: 7 }, (_, i) => `EMAIL_DRAFT:d${i}`).join("\n"), "EMAIL_DRAFT:d5\nEMAIL_DRAFT:d6"],
  ["  Spacing\n\n\n kept  ", "  Spacing\n\n\n kept  "],
  ["Hi\n\n\nEMAIL_DRAFT:d1\n\n\nBye", "Hi\n\nBye"],
];

describe("EMAIL_DRAFT: directive grammar — one rule, three implementations", () => {
  it("has a python3 to run the Hermes copy with — this suite is the drift guard", () => {
    expect(hasPython3).toBe(true);
  });

  it("the chat answers the table as written", () => {
    expect(CASES.map(([raw]) => chat(raw))).toEqual(CASES.map(([, want]) => want));
  });

  it("OpenClaw's channel plugin answers it identically", () => {
    expect(CASES.map(([raw]) => openclaw(raw))).toEqual(CASES.map(([, want]) => want));
  });

  it("Hermes' channel plugin answers it identically", () => {
    expect(hermes(CASES.map(([raw]) => raw))).toEqual(CASES.map(([, want]) => want));
  });

  const BOUNDARY_CODE_POINTS = [
    ...Array.from({ length: 0x20 }, (_, i) => i),
    0x7f, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
    ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
    0x200b, 0x200c, 0x200d, 0x2060, 0x180e,
  ];

  it("all three agree on every whitespace-boundary character", () => {
    const inputs: string[] = [];
    for (const cp of BOUNDARY_CODE_POINTS) {
      const c = String.fromCodePoint(cp);
      inputs.push(`Done.\n${c}EMAIL_DRAFT:d1`);
      inputs.push(`Done.\nEMAIL_DRAFT:${c}d1${c}`);
      inputs.push(`Done.\nEMAIL_DRAFT:d1${c}`);
      inputs.push(`Done.\n${c}\`EMAIL_DRAFT:d1\`${c}`);
      inputs.push(`${c}\`\`\`\nEMAIL_DRAFT:d1\n\`\`\``);
      for (const q of ["`", '"', "'"]) {
        inputs.push(`Done.\nEMAIL_DRAFT:${q}d1${c}${q}`);
        inputs.push(`Done.\nEMAIL_DRAFT:${q}${c}d1${q}`);
      }
    }
    const ts = inputs.map(chat);
    const js = inputs.map(openclaw);
    const py = hermes(inputs);
    const disagreements = inputs
      .map((raw, i) => ({ raw, ts: ts[i], js: js[i], py: py[i] }))
      .filter((row) => row.ts !== row.js || row.ts !== row.py)
      .map((row) => JSON.stringify(row));
    expect(disagreements).toEqual([]);
  });

  it("all three agree on every code point either runtime could fold onto the keyword", () => {
    const KEYWORD = "email_draft";
    const letters = [...new Set(KEYWORD.replace("_", "").split(""))];
    const program = [
      "import json, re, sys",
      "letters = json.loads(sys.argv[1])",
      "out = {l: [] for l in letters}",
      "for cp in range(0x110000):",
      "    if 0xd800 <= cp <= 0xdfff: continue",
      "    ch = chr(cp)",
      "    for l in letters:",
      "        if ch != l and (re.fullmatch(l, ch, re.IGNORECASE) or ch.lower() == l or (len(ch.upper()) == 1 and ch.upper().lower() == l)):",
      "            out[l].append(cp)",
      "print(json.dumps(out))",
    ].join("\n");
    const py = JSON.parse(execFileSync("python3", ["-c", program, JSON.stringify(letters)], { encoding: "utf-8" })) as Record<string, number[]>;
    const inputs: string[] = [];
    for (let pos = 0; pos < KEYWORD.length; pos++) {
      const letter = KEYWORD[pos];
      if (letter === "_") continue;
      const candidates = new Set<number>(py[letter] ?? []);
      for (let cp = 0x80; cp <= 0xffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const ch = String.fromCodePoint(cp);
        if (new RegExp(`^${letter}$`, "i").test(ch) || ch.toLowerCase() === letter) candidates.add(cp);
      }
      for (const cp of candidates) {
        const variant = KEYWORD.slice(0, pos) + String.fromCodePoint(cp) + KEYWORD.slice(pos + 1);
        inputs.push(`Done.\n${variant}:d1`);
        inputs.push(`Done.\nEMAIL_DRAFT:d0\n${variant}:d1`);
      }
    }
    expect(inputs.length).toBeGreaterThan(0);
    const ts = inputs.map(chat);
    const js = inputs.map(openclaw);
    const pyOut = hermes(inputs);
    const disagreements = inputs
      .map((raw, i) => ({ raw, ts: ts[i], js: js[i], py: pyOut[i] }))
      .filter((row) => row.ts !== row.js || row.ts !== row.py)
      .map((row) => JSON.stringify(row));
    expect(disagreements).toEqual([]);
  });

  it("a non-string is not a crash in either plugin", () => {
    expect(stripDraftDirectives(undefined as unknown as string)).toBe("");
    const out = execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); from email_directives import strip_draft_directives; print(repr(strip_draft_directives(None)))", PY_PLUGIN_DIR], { encoding: "utf-8" });
    expect(out.trim()).toBe("''");
  });
});
