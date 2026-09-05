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

  it("reads an absent key as an absent value, confidently", () => {
    expect(getTopLevelScalar("model: openrouter/x\n", "TELEGRAM_BOT_TOKEN")).toEqual({
      value: null,
      readable: true,
    });
  });
});
