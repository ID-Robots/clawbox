import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  applyEnvValues,
  envLineDefinesKey,
  getHermesEnvValue,
  hermesEnvPath,
  parseEnvValue,
  parseHermesEnv,
  quoteEnvValue,
  readHermesEnv,
  setHermesEnvValues,
} from "@/lib/hermes-env";

describe("quoteEnvValue", () => {
  it("leaves plain values unquoted", () => {
    expect(quoteEnvValue("true")).toBe("true");
    expect(quoteEnvValue("15551234567")).toBe("15551234567");
    expect(quoteEnvValue("self-chat")).toBe("self-chat");
    expect(quoteEnvValue("15551234567,15559876543")).toBe("15551234567,15559876543");
  });

  it("keeps an empty value empty rather than writing a pair of quotes", () => {
    expect(quoteEnvValue("")).toBe("");
  });

  it("quotes anything dotenv would otherwise misread", () => {
    // A bare # would start a comment and silently truncate the value.
    expect(quoteEnvValue("a#b")).toBe('"a#b"');
    expect(quoteEnvValue("two words")).toBe('"two words"');
    expect(quoteEnvValue(" padded ")).toBe('" padded "');
    expect(quoteEnvValue("it's")).toBe(`"it's"`);
  });

  it("escapes backslashes and double quotes", () => {
    expect(quoteEnvValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteEnvValue("back\\slash here")).toBe('"back\\\\slash here"');
  });
});

describe("parseEnvValue", () => {
  it("round-trips everything quoteEnvValue produces", () => {
    for (const value of ["true", "", "a#b", "two words", " padded ", 'say "hi"', "back\\slash here"]) {
      expect(parseEnvValue(quoteEnvValue(value))).toBe(value);
    }
  });

  it("does not unescape inside single quotes", () => {
    expect(parseEnvValue(`'raw\\value'`)).toBe("raw\\value");
  });
});

describe("envLineDefinesKey", () => {
  it("matches both the plain and the export form", () => {
    expect(envLineDefinesKey("WHATSAPP_ENABLED=true", "WHATSAPP_ENABLED")).toBe(true);
    expect(envLineDefinesKey("export WHATSAPP_ENABLED=true", "WHATSAPP_ENABLED")).toBe(true);
    expect(envLineDefinesKey("  export   WHATSAPP_ENABLED=true", "WHATSAPP_ENABLED")).toBe(true);
  });

  it("does not match a longer key with the same prefix", () => {
    expect(envLineDefinesKey("WHATSAPP_ENABLED_EXTRA=true", "WHATSAPP_ENABLED")).toBe(false);
    expect(envLineDefinesKey("# WHATSAPP_ENABLED=true", "WHATSAPP_ENABLED")).toBe(false);
  });
});

describe("applyEnvValues", () => {
  it("appends a new key and keeps a trailing newline", () => {
    expect(applyEnvValues("A=1\n", { B: "2" })).toBe("A=1\nB=2\n");
  });

  it("replaces in place, preserving surrounding lines and comments", () => {
    const before = "# comment\nA=1\nB=old\nC=3\n";
    expect(applyEnvValues(before, { B: "new" })).toBe("# comment\nA=1\nB=new\nC=3\n");
  });

  it("replaces an export-prefixed line rather than appending a duplicate", () => {
    // Appending a second line here is the upstream bug that made a later
    // delete resurrect the old exported value.
    expect(applyEnvValues("export A=1\n", { A: "2" })).toBe("A=2\n");
  });

  it("deletes a key when the value is null", () => {
    expect(applyEnvValues("A=1\nB=2\n", { A: null })).toBe("B=2\n");
    // Deleting the only key leaves an empty file, not a stray newline.
    expect(applyEnvValues("A=1\n", { A: null })).toBe("");
  });

  it("is a no-op for deleting a key that was never there", () => {
    expect(applyEnvValues("A=1\n", { Z: null })).toBe("A=1\n");
  });

  it("rewrites EVERY definition of a duplicated key, not just the first", () => {
    // parseHermesEnv (like Hermes' load_env) lets the LAST definition win, so
    // touching only the first produced a write that read back unchanged.
    const before = "A=old\nB=keep\nA=newer\n";
    const after = applyEnvValues(before, { A: "written" });
    expect(after).toBe("A=written\nB=keep\n");
    expect(parseHermesEnv(after).A).toBe("written");
  });

  it("deletes every definition, so a duplicate cannot resurrect the old value", () => {
    const after = applyEnvValues("A=old\nB=keep\nA=newer\n", { A: null });
    expect(after).toBe("B=keep\n");
    expect(parseHermesEnv(after).A).toBeUndefined();
  });

  it("matches a duplicate written in the export form too", () => {
    const after = applyEnvValues("A=old\nexport A=newer\n", { A: "written" });
    expect(after).toBe("A=written\n");
  });

  it("does not grow blank lines when applied repeatedly", () => {
    let text = "";
    for (let i = 0; i < 3; i++) text = applyEnvValues(text, { A: String(i) });
    expect(text).toBe("A=2\n");
  });

  it("strips newlines from a value so it cannot forge a second assignment", () => {
    expect(applyEnvValues("", { A: "one\nADMIN=yes" })).toBe("A=oneADMIN=yes\n");
  });

  it("normalises CRLF input", () => {
    expect(applyEnvValues("A=1\r\nB=2\r\n", { B: "3" })).toBe("A=1\nB=3\n");
  });

  it("rejects an invalid variable name", () => {
    expect(() => applyEnvValues("", { "BAD-KEY": "1" })).toThrow(/Invalid environment variable name/);
    expect(() => applyEnvValues("", { "1LEADING": "1" })).toThrow(/Invalid environment variable name/);
  });
});

describe("parseHermesEnv", () => {
  it("skips comments and blanks, strips export, splits on the first =", () => {
    const env = parseHermesEnv(["# note", "", "A=1", "export B=2", "C=x=y"].join("\n"));
    expect(env).toEqual({ A: "1", B: "2", C: "x=y" });
  });

  it("unquotes values", () => {
    expect(parseHermesEnv('A="two words"\n')).toEqual({ A: "two words" });
  });

  it("tolerates a BOM", () => {
    expect(parseHermesEnv("﻿A=1\n")).toEqual({ A: "1" });
  });
});

describe("setHermesEnvValues on disk", () => {
  let dir: string;
  const originalHome = process.env.HERMES_HOME;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-env-"));
    process.env.HERMES_HOME = dir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a missing .env at 0600", async () => {
    await setHermesEnvValues({ WHATSAPP_ENABLED: "true" });
    const stat = await fs.stat(hermesEnvPath());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await readHermesEnv()).toEqual({ WHATSAPP_ENABLED: "true" });
  });

  it("preserves the existing file mode instead of widening it", async () => {
    // 0640, not 0600: setHermesEnvValues CREATES a missing file at 0600, so a
    // 0600 fixture passes this assertion even with the mode-preserving code
    // deleted. The mode has to differ from the default for the test to mean
    // anything. umask cannot interfere — chmod sets the mode outright.
    await fs.writeFile(hermesEnvPath(), "A=1\n", { mode: 0o640 });
    await fs.chmod(hermesEnvPath(), 0o640);
    await setHermesEnvValues({ B: "2" });
    expect((await fs.stat(hermesEnvPath())).mode & 0o777).toBe(0o640);
  });

  it("leaves no temp file behind", async () => {
    await setHermesEnvValues({ A: "1" });
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.includes("tmp"))).toEqual([]);
  });

  it("serialises concurrent writes so neither is dropped", async () => {
    await Promise.all([
      setHermesEnvValues({ A: "1" }),
      setHermesEnvValues({ B: "2" }),
      setHermesEnvValues({ C: "3" }),
    ]);
    expect(await readHermesEnv()).toEqual({ A: "1", B: "2", C: "3" });
  });

  it("reads a single value and returns null for an absent key", async () => {
    await setHermesEnvValues({ A: "1" });
    expect(await getHermesEnvValue("A")).toBe("1");
    expect(await getHermesEnvValue("NOPE")).toBeNull();
  });

  it("treats a missing .env as empty rather than throwing", async () => {
    expect(await readHermesEnv()).toEqual({});
    expect(await getHermesEnvValue("A")).toBeNull();
  });

  it("treats a missing ~/.hermes as empty too", async () => {
    // ENOTDIR rather than ENOENT: a path component exists but is not a
    // directory. Still "nothing configured", not a fault.
    process.env.HERMES_HOME = path.join(dir, "not-a-dir", "hermes");
    await fs.writeFile(path.join(dir, "not-a-dir"), "");
    expect(await readHermesEnv()).toEqual({});
  });

  it("propagates a real read failure instead of reporting an empty env", async () => {
    // The bug this guards: `catch { return {} }` flattened EVERY failure into
    // "nothing configured yet", so an unreadable .env made
    // readHermesWhatsappStatus answer `not_configured` with an empty allowlist
    // — the panel told the owner his channel was simply not set up while the
    // real cause was an unreadable file. A fault has to reach the caller.
    //
    // A directory at the .env path yields EISDIR on every platform and for
    // every user, which chmod 0o000 does not: CI containers often run as root,
    // where the permission bits are ignored and the read would succeed.
    await fs.mkdir(hermesEnvPath(), { recursive: true });
    await expect(readHermesEnv()).rejects.toMatchObject({ code: "EISDIR" });
    await expect(getHermesEnvValue("A")).rejects.toMatchObject({ code: "EISDIR" });
  });
});
