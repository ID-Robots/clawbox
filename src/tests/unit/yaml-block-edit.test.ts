import { describe, expect, it } from "vitest";

import {
  formatYamlScalar,
  getYamlPath,
  setYamlPath,
  unsetYamlPath,
  YamlEditUnsupported,
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
