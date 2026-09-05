import { describe, expect, it } from "vitest";

import {
  formatYamlScalar,
  getTopLevelScalar,
  getYamlPath,
  setYamlPath,
  unsetYamlPath,
  YamlEditUnsupported,
  hasYamlPath,
} from "@/lib/yaml-block-edit";

/**
 * The editor exists so that writing one key into ~/.hermes/config.yaml stops
 * deleting the rest of the file. Everything here is about what SURVIVES a
 * write, not about YAML in general.
 */

const SAMPLE = `# ── Top banner ──
dashboard:
  basic_auth:
    username: clawbox
    # who may open the dashboard
    session_ttl_seconds: 604800
_config_version: 38
model:
  provider: openrouter
  default: anthropic/claude-sonnet-4

# ── Fallback Model ──
# Uncomment to enable.
#
# fallback_model:
#   provider: openrouter
`;

describe("setYamlPath", () => {
  it("changes only the line it targets", () => {
    const out = setYamlPath(SAMPLE, ["model", "provider"], "clawlocal");
    expect(getYamlPath(out, ["model", "provider"])).toBe("clawlocal");
    const before = SAMPLE.split("\n");
    const after = out.split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.filter((line, i) => line !== before[i]);
    expect(changed).toEqual(["  provider: clawlocal"]);
  });

  it("creates a missing nested block without disturbing the comments", () => {
    const out = setYamlPath(SAMPLE, ["providers", "clawlocal", "base_url"], "http://127.0.0.1/setup-api/local-ai/ollama/v1");
    expect(getYamlPath(out, ["providers", "clawlocal", "base_url"])).toBe(
      "http://127.0.0.1/setup-api/local-ai/ollama/v1",
    );
    // A url is a plain scalar in YAML — `:` only separates a mapping when a
    // space follows it — so it is written the way a person would write it.
    expect(out).toContain("    base_url: http://127.0.0.1/setup-api/local-ai/ollama/v1");
    for (const line of SAMPLE.split("\n").filter((l) => l.startsWith("#"))) {
      expect(out).toContain(line);
    }
  });

  it("puts a new top-level key above the trailing comment banner, not below it", () => {
    const out = setYamlPath(SAMPLE, ["providers", "clawlocal", "api_mode"], "openai");
    const lines = out.split("\n");
    expect(lines.indexOf("providers:")).toBeLessThan(lines.indexOf("# ── Fallback Model ──"));
  });

  it("adds a key to an existing block in place", () => {
    const out = setYamlPath(SAMPLE, ["model", "context_length"], "65536");
    expect(out).toContain("  default: anthropic/claude-sonnet-4\n  context_length: 65536\n");
    expect(getYamlPath(out, ["model", "context_length"])).toBe("65536");
  });

  it("keeps a trailing comment on a line it rewrites", () => {
    const withComment = "model:\n  provider: openrouter # chosen in Settings\n";
    const out = setYamlPath(withComment, ["model", "provider"], "clawlocal");
    expect(out).toBe("model:\n  provider: clawlocal # chosen in Settings\n");
  });

  it("writes into an empty file", () => {
    const out = setYamlPath("", ["model", "provider"], "clawlocal");
    expect(out).toBe("model:\n  provider: clawlocal");
    expect(getYamlPath(out, ["model", "provider"])).toBe("clawlocal");
  });

  it("refuses to replace a block with a scalar", () => {
    // `model:` owns two children. Overwriting it would delete them silently.
    expect(() => setYamlPath(SAMPLE, ["model"], "clawlocal")).toThrow(YamlEditUnsupported);
  });

  it("refuses shapes it does not understand rather than guessing", () => {
    expect(() => setYamlPath("model: {provider: x}\n", ["model", "provider"], "y")).toThrow(YamlEditUnsupported);
    expect(() => setYamlPath("model:\n  - openrouter\n", ["model", "provider"], "y")).toThrow(YamlEditUnsupported);
    expect(() => setYamlPath('"model":\n  provider: x\n', ["model", "provider"], "y")).toThrow(YamlEditUnsupported);
    expect(() => setYamlPath("model:\n  provider: a\n  provider: b\n", ["model", "provider"], "y")).toThrow(
      YamlEditUnsupported,
    );
    expect(() => setYamlPath("---\nmodel:\n  provider: a\n", ["model", "provider"], "y")).toThrow(YamlEditUnsupported);
  });
});

describe("unsetYamlPath", () => {
  it("removes the key and prunes the block it emptied", () => {
    let out = setYamlPath(SAMPLE, ["providers", "clawlocal", "base_url"], "http://127.0.0.1/x");
    out = setYamlPath(out, ["providers", "clawlocal", "api_mode"], "openai");
    out = unsetYamlPath(out, ["providers", "clawlocal", "base_url"]);
    expect(out).toContain("providers:");
    out = unsetYamlPath(out, ["providers", "clawlocal", "api_mode"]);
    // Last child gone → `clawlocal:` and `providers:` go with it. A stranded
    // `providers:` reads back as null, which is not the config we started from.
    expect(out).not.toContain("providers:");
    expect(out).not.toContain("clawlocal");
    expect(out).toBe(SAMPLE);
  });

  it("leaves siblings alone", () => {
    const out = unsetYamlPath(SAMPLE, ["model", "default"]);
    expect(getYamlPath(out, ["model", "provider"])).toBe("openrouter");
    expect(getYamlPath(out, ["model", "default"])).toBeNull();
  });

  it("is a no-op on a key that is not there", () => {
    expect(unsetYamlPath(SAMPLE, ["providers", "clawlocal", "api_key"])).toBe(SAMPLE);
  });
});

describe("formatYamlScalar", () => {
  it("leaves ordinary values plain", () => {
    expect(formatYamlScalar("openai")).toBe("openai");
    expect(formatYamlScalar("qwen2.5:3b")).toBe("qwen2.5:3b");
    expect(formatYamlScalar("http://127.0.0.1/setup-api/local-ai/ollama/v1")).toBe(
      "http://127.0.0.1/setup-api/local-ai/ollama/v1",
    );
  });

  it("quotes anything that would not read back as itself", () => {
    // A `#` would start a comment; a leading `-` reads as a sequence entry.
    expect(formatYamlScalar("tok#en")).toBe('"tok#en"');
    expect(formatYamlScalar("-dash")).toBe('"-dash"');
    expect(formatYamlScalar(" padded ")).toBe('" padded "');
    expect(formatYamlScalar('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("round-trips a quoted value", () => {
    const out = setYamlPath("", ["providers", "clawlocal", "api_key"], "a#b c\"d");
    expect(getYamlPath(out, ["providers", "clawlocal", "api_key"])).toBe("a#b c\"d");
  });
});

/**
 * `getYamlPath` answers null both for "no such key" and for a key written with
 * an empty value, and a reader that applies defaults has to tell those apart:
 * YAML reads `foo:` as a null VALUE, so substituting a default there overrides
 * something somebody actually wrote. That is a security bug on the one caller
 * that has it (the Hermes shell-scan status), so the distinction is pinned.
 */
describe("hasYamlPath", () => {
  const text = "security:\n  tirith_enabled:\n  tirith_path: \"tirith\"\n";

  it("is true for a key written with no value, where getYamlPath answers null", () => {
    expect(getYamlPath(text, ["security", "tirith_enabled"])).toBeNull();
    expect(hasYamlPath(text, ["security", "tirith_enabled"])).toBe(true);
  });

  it("is false for a key that is genuinely absent", () => {
    expect(hasYamlPath(text, ["security", "tirith_fail_open"])).toBe(false);
    expect(hasYamlPath(text, ["nothing", "here"])).toBe(false);
  });

  it("is true for an ordinary key with a value", () => {
    expect(hasYamlPath(text, ["security", "tirith_path"])).toBe(true);
  });
});

/**
 * A trailing `# comment` beside a QUOTED value.
 *
 * The comment splitter was written for the editor, which replaces the whole
 * value, so it deliberately gave up on a value that opens with a quote and
 * handed the caller the quote, the value and the comment as one string. The
 * readers below inherited that: `TOKEN: "…"  # main bot` — a line a hand-fed
 * config is exactly where you find — read back as `"…"  # main bot`, which is
 * not the value anybody wrote and, for a credential, is a confident "this box
 * has nothing here" over a box that has one.
 *
 * PyYAML — what Hermes' own env bridge loads config.yaml with — reads every
 * shape below as the same value, so this is the table the readers owe it.
 */
describe("a trailing comment beside a quoted value", () => {
  const TOKEN = "111111:AAHrealBotSecret_abc";

  const cases: Array<[string, string]> = [
    ["plain", `TELEGRAM_BOT_TOKEN: ${TOKEN}\n`],
    ["plain with a trailing comment", `TELEGRAM_BOT_TOKEN: ${TOKEN}  # main bot\n`],
    ["double-quoted", `TELEGRAM_BOT_TOKEN: "${TOKEN}"\n`],
    ["double-quoted with a trailing comment", `TELEGRAM_BOT_TOKEN: "${TOKEN}"  # main bot\n`],
    ["single-quoted with a trailing comment", `TELEGRAM_BOT_TOKEN: '${TOKEN}'  # main bot\n`],
    ["quoted key AND quoted value with a comment", `"TELEGRAM_BOT_TOKEN": "${TOKEN}" # main bot\n`],
  ];

  it.each(cases)("getTopLevelScalar reads the value out of a %s line", (_name, text) => {
    expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN").value).toBe(TOKEN);
  });

  it.each(cases.filter(([name]) => !name.startsWith("quoted key")))(
    "getYamlPath reads the value out of a %s line",
    (_name, text) => {
      expect(getYamlPath(text, ["TELEGRAM_BOT_TOKEN"])).toBe(TOKEN);
    },
  );

  // PyYAML needs no space between the closing quote and the `#` — the flow
  // scalar has ended. Requiring one made this "we could not look", which is a
  // permanent 503 on the approvals gate over a config that is fine.
  it("reads a comment written flush against the closing quote", () => {
    expect(getTopLevelScalar(`TELEGRAM_BOT_TOKEN: "${TOKEN}"# main bot\n`, "TELEGRAM_BOT_TOKEN")).toEqual({
      value: TOKEN,
      readable: true,
    });
  });

  // ...and the separator goes back on when the value is rewritten, because
  // `newvalue# c` is a value, not a value plus a comment.
  it("setYamlPath re-separates a comment that was flush against the quote", () => {
    expect(setYamlPath(`api_key: "old"# the key\n`, ["api_key"], "new")).toBe(`api_key: new # the key\n`);
  });

  // A `#` INSIDE the quotes is data, which is the case the splitter was
  // protecting and must keep protecting.
  it("keeps a # that is inside the quotes", () => {
    expect(getTopLevelScalar(`api_key: "a#b c"  # not part of it\n`, "api_key").value).toBe("a#b c");
    expect(getYamlPath(`api_key: 'a#b'\n`, ["api_key"])).toBe("a#b");
  });

  // The editor's own reason for the special case: a rewrite must not eat the
  // comment beside the value it replaces.
  it("setYamlPath preserves the comment beside a quoted value it replaces", () => {
    const out = setYamlPath(`api_key: "old"  # the key\n`, ["api_key"], "new");
    expect(out).toBe(`api_key: new  # the key\n`);
  });
});

/**
 * "There is a value here and we cannot name it" is not "there is nothing here".
 *
 * Hermes' env bridge exports config.yaml's top-level SCALARS into the
 * environment, so a key holding a block scalar or a tagged value does reach the
 * gateway — this reader just cannot resolve it. Answering `null` there is the
 * same confident "no bot" as missing a quoted key, so the shapes it cannot read
 * are reported as unreadable and the caller degrades instead of deciding.
 */
describe("getTopLevelScalar on a value it cannot resolve", () => {
  it.each([
    ["a literal block scalar", "TELEGRAM_BOT_TOKEN: |\n  111111:AAH\n"],
    ["a folded block scalar", "TELEGRAM_BOT_TOKEN: >\n  111111:AAH\n"],
    ["a tagged value", 'TELEGRAM_BOT_TOKEN: !!str "111111:AAH"\n'],
    ["an alias", "TELEGRAM_BOT_TOKEN: *token\n"],
    ["an anchor", "TELEGRAM_BOT_TOKEN: &token 111111:AAH\n"],
    ["a flow mapping", "TELEGRAM_BOT_TOKEN: { source: env }\n"],
    ["an unterminated quote", 'TELEGRAM_BOT_TOKEN: "111111:AAH\n'],
  ])("says it could not read %s", (_name, text) => {
    expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN")).toEqual({ value: null, readable: false });
  });

  // A key written with no value at all is a YAML null, which the bridge does
  // not export — that IS "nothing here", confidently.
  it("reads a key with no value as an absent value, confidently", () => {
    expect(getTopLevelScalar("TELEGRAM_BOT_TOKEN:\n", "TELEGRAM_BOT_TOKEN")).toEqual({
      value: null,
      readable: true,
    });
  });

  it("reads a key that opens a nested block as an absent value, confidently", () => {
    expect(getTopLevelScalar("skills:\n  TELEGRAM_BOT_TOKEN: x\n", "TELEGRAM_BOT_TOKEN")).toEqual({
      value: null,
      readable: true,
    });
  });

  // YAML lets the whole root mapping sit at one uniform indent, and PyYAML
  // reads it as top-level. Anchoring at column 0 answered a confident "this box
  // has no bot" for such a file — the fail-open, one spelling further out.
  it("reads a root mapping that is uniformly indented", () => {
    expect(
      getTopLevelScalar("  TELEGRAM_BOT_TOKEN: 111111:AAH\n  other: 1\n", "TELEGRAM_BOT_TOKEN"),
    ).toEqual({ value: "111111:AAH", readable: true });
  });

  // ...without turning a genuinely NESTED key of the same name into the
  // answer: a skills block may carry its own, and the bridge exports only the
  // root mapping's scalars.
  it("still ignores a nested key when the root mapping is at column 0", () => {
    expect(
      getTopLevelScalar("skills:\n  config:\n    TELEGRAM_BOT_TOKEN: 111111:AAH\nmodel: x\n", "TELEGRAM_BOT_TOKEN"),
    ).toEqual({ value: null, readable: true });
  });

  it("reads an absent key as an absent value, confidently", () => {
    expect(getTopLevelScalar("model: openrouter/x\n", "TELEGRAM_BOT_TOKEN")).toEqual({
      value: null,
      readable: true,
    });
  });
});

/**
 * YAML 1.2's double-quoted escapes, resolved the way PyYAML resolves them.
 *
 * PyYAML is what Hermes' own env bridge loads config.yaml with, so it decides
 * what the gateway ends up polling. Undoing only the four escapes this module's
 * WRITER emits left every other one as its own literal text with
 * `readable: true`, and two of them decode to characters that are legal inside
 * a Telegram token:
 *
 *   `"111111:\x41AH..."` PyYAML gives `111111:AAH...`; this reader gave the
 *                        literal text, which `BOT_TOKEN_RE` rejects: a
 *                        confident "this box has no bot" over a box with one.
 *   `"11111\x30:AAH..."` PyYAML gives `111110:AAH...`, a DIFFERENT bot id, so
 *                        even stripping the backslash names the wrong bot.
 *
 * Every row below is what PyYAML 6.x returns for that line, checked against it
 * rather than reasoned about. An escape PyYAML RAISES on has to come back
 * `readable: false` - this module's own rule, "a value it cannot resolve is not
 * an answer".
 */
describe("double-quoted escapes, as PyYAML resolves them", () => {
  // [what it is, the text between the quotes, what PyYAML makes of it]
  const resolved: Array<[string, string, string]> = [
    ["a NUL", "a\\0b", "a\u0000b"],
    ["a bell", "a\\ab", "a\u0007b"],
    ["a backspace", "a\\bb", "a\u0008b"],
    ["a tab", "a\\tb", "a\u0009b"],
    ["an escaped literal tab", "a\\\u0009b", "a\u0009b"],
    ["a line feed", "a\\nb", "a\u000Ab"],
    ["a vertical tab", "a\\vb", "a\u000Bb"],
    ["a form feed", "a\\fb", "a\u000Cb"],
    ["a carriage return", "a\\rb", "a\u000Db"],
    ["an escape character", "a\\eb", "a\u001Bb"],
    ["an escaped space", "a\\ b", "a b"],
    ['an escaped double quote', 'a\\"b', 'a"b'],
    ["an escaped slash", "a\\/b", "a/b"],
    ["an escaped backslash", "a\\\\b", "a\\b"],
    ["a next line", "a\\Nb", "a\u0085b"],
    ["a non-breaking space", "a\\_b", "a\u00A0b"],
    ["a line separator", "a\\Lb", "a\u2028b"],
    ["a paragraph separator", "a\\Pb", "a\u2029b"],
    ["a hex escape", "a\\x41b", "aAb"],
    ["a 16-bit unicode escape", "a\\u0041b", "aAb"],
    ["a 32-bit unicode escape", "a\\U00000041b", "aAb"],
    // PyYAML hands a lone surrogate straight through, so this reader may not
    // refuse a value the bridge would have exported.
    ["a lone surrogate", "a\\ud800b", "a\uD800b"],
  ];

  it.each(resolved)("resolves %s", (_name, body, expected) => {
    expect(getTopLevelScalar(`K: "${body}"\n`, "K")).toEqual({ value: expected, readable: true });
  });

  // The two rows the same-bot guard is actually about.
  it("resolves an escape inside a bot token", () => {
    expect(
      getTopLevelScalar('TELEGRAM_BOT_TOKEN: "111111:\\x41AHrealBotSecret_abc"\n', "TELEGRAM_BOT_TOKEN"),
    ).toEqual({ value: "111111:AAHrealBotSecret_abc", readable: true });
  });

  it("resolves an escape that changes the bot id", () => {
    expect(
      getTopLevelScalar('TELEGRAM_BOT_TOKEN: "11111\\x30:AAHrealBotSecret_abc"\n', "TELEGRAM_BOT_TOKEN"),
    ).toEqual({ value: "111110:AAHrealBotSecret_abc", readable: true });
  });

  // PyYAML RAISES on each of these, so the file does not load at all and any
  // value invented here is nobody's. `readable: false` is the honest answer.
  it.each([
    ["an escape YAML does not define", "a\\qb"],
    ["a hex escape with non-hex digits", "a\\xZZb"],
    ["a hex escape with too few digits", "a\\x4"],
    ["a unicode escape above the Unicode range", "a\\U0011FFFFb"],
    ["a 32-bit unicode escape with too few digits", "a\\UD800"],
  ])("says it could not read %s", (_name, body) => {
    expect(getTopLevelScalar(`K: "${body}"\n`, "K")).toEqual({ value: null, readable: false });
  });

  // Single quotes have exactly one escape, `''`. A backslash is ordinary data
  // there, and decoding it would invent a value PyYAML never produced.
  it("leaves a backslash alone inside single quotes", () => {
    expect(getTopLevelScalar("K: 'a\\x41b'\n", "K")).toEqual({ value: "a\\x41b", readable: true });
  });

  it("undoes doubled single quotes and nothing else", () => {
    expect(getTopLevelScalar("K: 'a''''b'\n", "K")).toEqual({ value: "a''b", readable: true });
  });

  // The writer's own round trip: `formatYamlScalar` writes a literal
  // backslash-n as `\\n`, and undoing `\n` before `\\` read that back as a line
  // break - a value that did not survive its own writer.
  it("reads back a value this module wrote that holds a literal backslash", () => {
    const out = setYamlPath("api_key: old\n", ["api_key"], "a\\nb");
    expect(getYamlPath(out, ["api_key"])).toBe("a\\nb");
  });
});

/**
 * A line is a mapping entry only when the colon is followed by a space or ends
 * the line - PyYAML's `check_value`, in block context.
 *
 * `TELEGRAM_BOT_TOKEN:111111:AAH...` is a plain SCALAR document to PyYAML: there
 * is no mapping, so the bridge exports nothing and no gateway polls anything.
 * Reading a bot out of it is a false success on every panel - `/telegram/status`
 * runs getMe on it and prints a username, `/telegram/pairing` says configured,
 * and the wizard marks Telegram done, for a bot nothing is listening to.
 */
describe("getTopLevelScalar and the space after the colon", () => {
  it("does not read a key out of a line with no space after the colon", () => {
    expect(getTopLevelScalar("TELEGRAM_BOT_TOKEN:111111:AAHrealBotSecret_abc\n", "TELEGRAM_BOT_TOKEN")).toEqual({
      value: null,
      readable: true,
    });
  });

  // A tab on either side of the colon makes PyYAML raise on the WHOLE document
  // (measured on 6.0.1 and on the 5.4.1 the Hermes box ships), so the bridge
  // exports nothing - and a bot read out of such a line is a username printed
  // by /telegram/status for a config no gateway can load. The answer is "could
  // not look" rather than "confidently nothing": nothing in a file that does
  // not load is evidence about the bot, in either direction. See "a document
  // PyYAML will not load" below, which is the same rule reached from the file
  // rather than from this key's own line.
  it.each([
    ["a tab after the colon", "TELEGRAM_BOT_TOKEN:	111111:AAH"],
    ["a tab before the colon", "TELEGRAM_BOT_TOKEN	: 111111:AAH"],
  ])("does not read a key out of a line with %s", (_name, line) => {
    expect(getTopLevelScalar(`${line}\n`, "TELEGRAM_BOT_TOKEN")).toEqual({ value: null, readable: false });
  });

  it("still reads a key whose colon ends the line, and one written with a space before it", () => {
    expect(getTopLevelScalar("TELEGRAM_BOT_TOKEN:\n", "TELEGRAM_BOT_TOKEN").readable).toBe(true);
    expect(getTopLevelScalar("TELEGRAM_BOT_TOKEN : 111111:AAH\n", "TELEGRAM_BOT_TOKEN")).toEqual({
      value: "111111:AAH",
      readable: true,
    });
  });
});

/**
 * A quoted value may run over several lines, and PyYAML does not require the
 * continuation to be indented. A continuation line is not a line of its own:
 * reading it as one puts a decoy in front of the real key, and can pull the
 * root indent BELOW the root mapping so the real key line is then skipped as
 * somebody else's. Both answer confidently about a key nobody wrote.
 */
describe("getTopLevelScalar and multi-line quoted values", () => {
  it("does not take a decoy out of the inside of a quoted value", () => {
    const text = 'TELEGRAM_BOT_TOKEN: 111111:AAA\nnotes: "hello\nTELEGRAM_BOT_TOKEN: DECOY\n"\n';
    expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN")).toEqual({ value: "111111:AAA", readable: true });
  });

  // ...and a SEQUENCE ITEM is a value position too. PyYAML loads this document
  // without complaint and answers the real token; reading the item's second
  // line as a line of its own named DECOY as this box's bot - the one shape
  // left where a file that loads still got a confident wrong answer.
  it("does not take a decoy out of a flow scalar a sequence item opened", () => {
    const text = 'TELEGRAM_BOT_TOKEN: 111111:AAA\nlist:\n  - "hello\nTELEGRAM_BOT_TOKEN: DECOY\n"\n';
    expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN")).toEqual({ value: "111111:AAA", readable: true });
  });

  it("does not take a decoy out of a single-quoted value either", () => {
    const text = "TELEGRAM_BOT_TOKEN: 111111:AAA\nnotes: 'hello\nTELEGRAM_BOT_TOKEN: DECOY\n'\n";
    expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN")).toEqual({ value: "111111:AAA", readable: true });
  });

  // A BLOCK scalar's content is text, not YAML: a quote or an apostrophe in it
  // opens nothing. A persona, a system prompt or a pasted command routinely
  // carries one, and PyYAML loads both documents below without complaint -
  // reading the content as an opener swallowed the real key line after it
  // (a confident "no bot") or left a quote open to the end of the file
  // (a permanent "we could not look" -> 503 bot_unknown over a valid config).
  it("does not read a block scalar's content as opening a quoted value", () => {
    const apostrophe = "notes: |\n  path: 'C:/tmp\nTELEGRAM_BOT_TOKEN: 111111:AAA\n# don't edit this file\n";
    const quoteBeforeTheKey =
      'persona: |\n  Greeting: "Hello there\n  and welcome.\nTELEGRAM_BOT_TOKEN: 111111:AAA\n';
    const quoteAfterTheKey = 'TELEGRAM_BOT_TOKEN: 111111:AAA\npersona: |\n  Greeting: "Hello there\n';

    for (const text of [apostrophe, quoteBeforeTheKey, quoteAfterTheKey]) {
      expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN")).toEqual({ value: "111111:AAA", readable: true });
    }
  });

  // ...and a key nested UNDER the block scalar's key is still nobody's business
  // of ours, because the block ends where the indentation does.
  it("ends a block scalar at the first line that is not deeper than its key", () => {
    const text = "notes: |\n  TELEGRAM_BOT_TOKEN: DECOY\nmodel: x\n";
    expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN")).toEqual({ value: null, readable: true });
  });

  // A quote that never closes swallows every line after it, and the key's own
  // line may be one of them. PyYAML raises on the whole document there, so
  // nothing read past that point is evidence - including the absence of a key.
  it("says it could not look when a quote never closes", () => {
    const before = 'TELEGRAM_BOT_TOKEN: 111111:AAA\nnotes: "never closed\n';
    const after = 'notes: "never closed\nTELEGRAM_BOT_TOKEN: 111111:AAA\n';

    expect(getTopLevelScalar(before, "TELEGRAM_BOT_TOKEN")).toEqual({ value: null, readable: false });
    expect(getTopLevelScalar(after, "TELEGRAM_BOT_TOKEN")).toEqual({ value: null, readable: false });
  });

  it("does not let a continuation line lower the root indent", () => {
    const text = '  notes: "hello\n hidden: x\n"\n  TELEGRAM_BOT_TOKEN: 111111:AAA\n';
    expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN")).toEqual({ value: "111111:AAA", readable: true });
  });
});

/**
 * A document PyYAML REFUSES to load is not a document this reader may answer a
 * bot out of.
 *
 * Hermes' env bridge loads config.yaml with PyYAML. When PyYAML raises, the
 * bridge exports nothing at all and the gateway polls no bot — so a token read
 * out of such a file is a bot that does not exist, named confidently:
 * `/telegram/status` runs getMe on it and prints a username, `/telegram/pairing`
 * answers `configured: true`, the wizard marks Telegram done, and
 * `/setup-api/telegram/configure`'s same-bot guard refuses a token that would in
 * fact have been fine. The owner is told the bot is configured, sees it dead,
 * and is blocked from re-entering it — both directions wrong, out of a file
 * nothing loads.
 *
 * The two constructs a config.yaml actually meets are a TAB and a second
 * DOCUMENT. Every row below is measured against PyYAML 6.0.1 (the reader must
 * agree with the library, not with the spec): tabs are legal inside a quoted
 * scalar, inside a comment, and inside a block scalar's text, and illegal
 * anywhere a token may start — including in a block's own indentation, and
 * including between a value and its trailing `#`, which is the shape a
 * hand-edited file reaches first.
 */
describe("getTopLevelScalar and a document PyYAML will not load", () => {
  const TOKEN = "111111:AAHrealBotSecret_abc";

  it.each([
    ["a tab between the value and its trailing comment", `TELEGRAM_BOT_TOKEN: ${TOKEN}\t# note\n`],
    ["a tab indenting a key elsewhere in the file", `TELEGRAM_BOT_TOKEN: ${TOKEN}\nroot:\n\tnested: 1\n`],
    ["a tab after another key's colon", `TELEGRAM_BOT_TOKEN: ${TOKEN}\nother:\tvalue\n`],
    ["a tab where a block scalar's content begins", `notes: |\n\tx: "one\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`],
    ["a tab inside a block scalar's own indentation", `notes: |\n  a\n \tb\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`],
    ["a second document", `TELEGRAM_BOT_TOKEN: ${TOKEN}\n---\nTELEGRAM_BOT_TOKEN: DECOY\n`],
    ["a value that only looks like a folded header", `other: >=1.0\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`],
    ["a value that only looks like a block header", `other: |pipe\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`],
    ["content after a document end marker", `TELEGRAM_BOT_TOKEN: ${TOKEN}\n...\nTELEGRAM_BOT_TOKEN: DECOY\n`],
    ["a directive with no document start after it", `%YAML 1.1\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`],
    ["a document marker inside a multi-line quoted value", `notes: "hello\n---\nworld"\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`],
    ["a # that is NOT a comment, with a tab after it", `other: x#a\tb\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`],
  ])("says it could not look when the file has %s", (_name, text) => {
    expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN")).toEqual({ value: null, readable: false });
  });

  // ...and the mirror image, which is the whole reason the check is not a bare
  // `text.includes("\t")`: every one of these loads on PyYAML 6.0.1 and carries
  // a real bot, so refusing them would answer "we could not read this device's
  // Telegram configuration" over a box that is working.
  it.each([
    ["a tab inside a comment line", `TELEGRAM_BOT_TOKEN: ${TOKEN}\n# a\tb\n`, TOKEN],
    ["a tab inside a trailing comment", `TELEGRAM_BOT_TOKEN: ${TOKEN} # a\tb\n`, TOKEN],
    ["a tab inside a quoted value", 'TELEGRAM_BOT_TOKEN: "111111:AAH\tx"\n', "111111:AAH\tx"],
    ["a tab in a block scalar's text", `notes: |\n  a\tb\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a tab at the block content indent", `notes: |\n  a\n  \tb\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["an explicit start for the only document", `---\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a document end marker at EOF", `TELEGRAM_BOT_TOKEN: ${TOKEN}\n...\n`, TOKEN],
    ["--- inside a block scalar", `notes: |\n  ---\n  more\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a # with no space in front of it", "TELEGRAM_BOT_TOKEN: 111111:AAH#x\n", "111111:AAH#x"],
    ["an apostrophe in another key's plain value", `other: don't stop\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a tab in a SEQUENCE ITEM's block scalar", `list:\n  - |\n    a\tb\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a tab in a TAGGED block scalar", `notes: !!str |\n  a\tb\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a tab in an ANCHORED block scalar", `notes: &n |\n  a\tb\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a tab in a block under a key with a # in it", `a#b: |\n  x\ty\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a tab in a block under a key with a colon in it", `a:b: |\n  x\ty\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a bad-header-looking line inside a block's text", `list:\n  - |\n    other: >=1.0\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a tab at the explicit block indent", `notes: |2\n    a\n  \tb\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a tab in a comment opened straight after a quote", `other: "x"#a\tb\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a tab in a comment opened straight after a flow collection", `other: [a]#c\td\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a directive before the only document's start marker", `%YAML 1.1\n---\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a block header with an indent and a chomp", `notes: |2-\n  x: "one\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
    ["a block header with a trailing comment", `notes: | # a note\n  x: "one\nTELEGRAM_BOT_TOKEN: ${TOKEN}\n`, TOKEN],
  ])("still reads the token from a file with %s", (_name, text, value) => {
    expect(getTopLevelScalar(text, "TELEGRAM_BOT_TOKEN")).toEqual({ value, readable: true });
  });
});
