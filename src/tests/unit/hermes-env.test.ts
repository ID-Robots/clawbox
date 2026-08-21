// These assertions encode Hermes' OWN .env semantics (hermes_cli/config.py
// _quote_env_value / _env_line_defines_key / save_env_value, read from the
// v0.20.5 checkout on a device). If a Hermes upgrade changes them, this file is
// where it should fail — not on a customer's box, where the symptom would be a
// mail password that silently stops being read.

import { describe, expect, it } from "vitest";
import { applyEnvValues, envLineDefinesKey, quoteEnvValue, removeEnvValues } from "@/lib/hermes-env";

describe("quoteEnvValue", () => {
  it("leaves a plain value unquoted", () => {
    expect(quoteEnvValue("smtp.gmail.com")).toBe("smtp.gmail.com");
    expect(quoteEnvValue("587")).toBe("587");
  });

  it("quotes a value containing spaces — Gmail app passwords are shown with them", () => {
    expect(quoteEnvValue("abcd efgh ijkl mnop")).toBe('"abcd efgh ijkl mnop"');
  });

  it("quotes a value containing a comment character", () => {
    expect(quoteEnvValue("pa#ss")).toBe('"pa#ss"');
  });

  it("escapes backslashes and double quotes", () => {
    expect(quoteEnvValue('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("returns the empty string unchanged", () => {
    expect(quoteEnvValue("")).toBe("");
  });
});

describe("envLineDefinesKey", () => {
  it("matches a plain assignment", () => {
    expect(envLineDefinesKey("EMAIL_ADDRESS=a@b.com", "EMAIL_ADDRESS")).toBe(true);
  });

  it("matches an export-prefixed assignment", () => {
    expect(envLineDefinesKey("export EMAIL_ADDRESS=a@b.com", "EMAIL_ADDRESS")).toBe(true);
  });

  it("does not match a commented template line", () => {
    // ~/.hermes/.env ships with every key commented out; overwriting those
    // would corrupt the file the user reads to understand their options.
    expect(envLineDefinesKey("# EMAIL_ADDRESS=agent@example.com", "EMAIL_ADDRESS")).toBe(false);
  });

  it("does not match a different key with the same prefix", () => {
    expect(envLineDefinesKey("EMAIL_ADDRESS_EXTRA=x", "EMAIL_ADDRESS")).toBe(false);
  });
});

describe("applyEnvValues", () => {
  it("appends a key that is not present", () => {
    expect(applyEnvValues("FOO=1\n", { EMAIL_ADDRESS: "a@b.com" })).toBe("FOO=1\nEMAIL_ADDRESS=a@b.com\n");
  });

  it("replaces in place rather than appending a second assignment", () => {
    const out = applyEnvValues("EMAIL_ADDRESS=old@b.com\nFOO=1\n", { EMAIL_ADDRESS: "new@b.com" });
    expect(out).toBe("EMAIL_ADDRESS=new@b.com\nFOO=1\n");
    expect(out.match(/EMAIL_ADDRESS=/g)).toHaveLength(1);
  });

  it("replaces an export-prefixed line instead of shadowing it", () => {
    const out = applyEnvValues("export EMAIL_ADDRESS=old@b.com\n", { EMAIL_ADDRESS: "new@b.com" });
    expect(out).toBe("EMAIL_ADDRESS=new@b.com\n");
  });

  it("leaves commented template lines untouched", () => {
    const before = "# EMAIL_ADDRESS=agent@example.com\n# EMAIL_PASSWORD=\n";
    const out = applyEnvValues(before, { EMAIL_ADDRESS: "a@b.com" });
    expect(out).toContain("# EMAIL_ADDRESS=agent@example.com");
    expect(out).toContain("EMAIL_ADDRESS=a@b.com");
  });

  it("strips CR/LF so a value cannot forge a second assignment", () => {
    const out = applyEnvValues("", { EMAIL_PASSWORD: "secret\nEMAIL_ALLOWED_USERS=attacker@evil.test" });
    expect(out).toBe("EMAIL_PASSWORD=secretEMAIL_ALLOWED_USERS=attacker@evil.test\n");
    expect(out.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("does not grow blank lines when written repeatedly", () => {
    let text = "";
    for (let i = 0; i < 5; i++) text = applyEnvValues(text, { EMAIL_SMTP_PORT: "587" });
    expect(text).toBe("EMAIL_SMTP_PORT=587\n");
  });

  it("rejects an invalid variable name", () => {
    expect(() => applyEnvValues("", { "BAD KEY": "x" })).toThrow(/Invalid environment variable name/);
  });
});

describe("removeEnvValues", () => {
  it("drops plain and export-prefixed assignments and keeps everything else", () => {
    const before = [
      "# EMAIL_ADDRESS=template",
      "EMAIL_ADDRESS=a@b.com",
      "export EMAIL_PASSWORD=secret",
      "TELEGRAM_BOT_TOKEN=keepme",
      "",
    ].join("\n");
    const out = removeEnvValues(before, ["EMAIL_ADDRESS", "EMAIL_PASSWORD"]);
    expect(out).toBe("# EMAIL_ADDRESS=template\nTELEGRAM_BOT_TOKEN=keepme\n");
  });

  it("is a no-op when nothing matches", () => {
    expect(removeEnvValues("FOO=1\n", ["EMAIL_ADDRESS"])).toBe("FOO=1\n");
  });
});
