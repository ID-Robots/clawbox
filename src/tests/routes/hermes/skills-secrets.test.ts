import { execFileSync } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-452 / ux-api-key-no-input-path — the store told a customer which API key
 * a skill needs and linked to the page that issues it, then offered nowhere on
 * the device to type it. `/skills/inspect` served `{label, envVar, providerUrl}`
 * for `official/security/1password`, SkillDetail rendered all three, and the
 * only thing in the whole product that wrote ~/.hermes/.env was Telegram.
 *
 * The contract these tests pin: the key goes in, and it never comes back out.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));

let hermesHome: string;

function envPath(): string {
  return path.join(hermesHome, ".env");
}

beforeEach(async () => {
  vi.resetModules();
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-env-"));
  process.env.HERMES_HOME = hermesHome;
});

afterEach(async () => {
  delete process.env.HERMES_HOME;
  await fs.rm(hermesHome, { recursive: true, force: true });
});

async function post(body: Record<string, unknown>) {
  const { POST } = await import("@/app/setup-api/hermes/skills/secrets/route");
  const res = await POST(
    new Request("http://localhost/setup-api/hermes/skills/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(keys: string) {
  const { GET } = await import("@/app/setup-api/hermes/skills/secrets/route");
  const res = await GET(
    new Request(`http://localhost/setup-api/hermes/skills/secrets?keys=${encodeURIComponent(keys)}`),
  );
  return { status: res.status, body: (await res.json()) as { secrets?: Record<string, boolean>; code?: string } };
}

describe("skill secrets (TASK-452)", () => {
  it("stores the declared key where Hermes reads its environment", async () => {
    const { status } = await post({ key: "OP_SERVICE_ACCOUNT_TOKEN", value: "ops_abc123" });
    expect(status).toBe(200);
    const raw = await fs.readFile(envPath(), "utf8");
    expect(raw).toContain("OP_SERVICE_ACCOUNT_TOKEN=ops_abc123");
  });

  it("writes the file 0600 — it holds a credential", async () => {
    await post({ key: "OP_SERVICE_ACCOUNT_TOKEN", value: "ops_abc123" });
    const mode = (await fs.stat(envPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reports whether a key is set, and NEVER its value", async () => {
    await post({ key: "OP_SERVICE_ACCOUNT_TOKEN", value: "ops_abc123" });
    const { status, body } = await get("OP_SERVICE_ACCOUNT_TOKEN,BRAVE_API_KEY");
    expect(status).toBe(200);
    expect(body.secrets).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: true, BRAVE_API_KEY: false });
    expect(JSON.stringify(body)).not.toContain("ops_abc123");
  });

  it("replaces a key rather than appending a second assignment", async () => {
    await post({ key: "BRAVE_API_KEY", value: "first" });
    await post({ key: "BRAVE_API_KEY", value: "second" });
    const raw = await fs.readFile(envPath(), "utf8");
    expect(raw.match(/^BRAVE_API_KEY=/gm)).toHaveLength(1);
    expect(raw).toContain("BRAVE_API_KEY=second");
  });

  it("preserves other keys, including Telegram's", async () => {
    await fs.writeFile(envPath(), "TELEGRAM_BOT_TOKEN=123:abc\n# a comment\n", { mode: 0o600 });
    await post({ key: "BRAVE_API_KEY", value: "brave" });
    const raw = await fs.readFile(envPath(), "utf8");
    expect(raw).toContain("TELEGRAM_BOT_TOKEN=123:abc");
    expect(raw).toContain("BRAVE_API_KEY=brave");
  });

  it("clears a key when an empty value is sent", async () => {
    await post({ key: "BRAVE_API_KEY", value: "brave" });
    const { status, body } = await post({ key: "BRAVE_API_KEY", value: "" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ set: false });
    expect((await get("BRAVE_API_KEY")).body.secrets).toEqual({ BRAVE_API_KEY: false });
  });

  it("quotes a value that would otherwise be ambiguous, and round-trips it", async () => {
    const tricky = 'a value with spaces # and a "quote"';
    await post({ key: "WEIRD_KEY", value: tricky });
    const { readHermesEnv } = await import("@/lib/hermes-skill-secrets");
    expect((await readHermesEnv()).get("WEIRD_KEY")).toBe(tricky);
  });

  it.each([
    ["lowercase", "op_token"],
    ["a dotted config key", "skills.disabled"],
    ["an assignment", "A=B"],
    ["a shell fragment", "A; rm -rf /"],
    ["empty", ""],
  ])("refuses %s as a key name", async (_label, key) => {
    const { status } = await post({ key, value: "x" });
    expect(status).toBe(400);
    await expect(fs.access(envPath())).rejects.toThrow();
  });

  it("refuses a value carrying a newline, which would start a second assignment", async () => {
    const { status } = await post({ key: "BRAVE_API_KEY", value: "good\nEVIL=1" });
    expect(status).toBe(400);
  });

  // Removing a stored credential is destructive, so it has to be asked for
  // explicitly. Coercing a missing or non-string value to "" would have let a
  // typo in the caller silently delete a customer's API key.
  it.each([
    ["omits value entirely", { key: "BRAVE_API_KEY" }],
    ["sends null", { key: "BRAVE_API_KEY", value: null }],
    ["sends a number", { key: "BRAVE_API_KEY", value: 42 }],
    ["sends an object", { key: "BRAVE_API_KEY", value: { toString: "x" } }],
  ])("refuses a request that %s, and leaves a stored key alone", async (_label, payload) => {
    await post({ key: "BRAVE_API_KEY", value: "brave" });

    const { status } = await post(payload as Record<string, unknown>);
    expect(status).toBe(400);
    expect((await get("BRAVE_API_KEY")).body.secrets).toEqual({ BRAVE_API_KEY: true });
  });

  it.each([
    ["null", "null"],
    ["an array", '[{"key":"BRAVE_API_KEY","value":"x"}]'],
    ["a bare string", '"BRAVE_API_KEY"'],
  ])("answers 400 for a body that is %s rather than throwing", async (_label, raw) => {
    const { POST } = await import("@/app/setup-api/hermes/skills/secrets/route");
    const res = await POST(
      new Request("http://localhost/setup-api/hermes/skills/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      }),
    );
    expect(res.status).toBe(400);
  });

  // CodeQL js/http-to-file-access on the .env write (PR #465). The answer was
  // to state the whole accepted alphabet instead of blacklisting the three
  // characters that were known to hurt, so these pin the alphabet rather than
  // the old blacklist.
  it.each([
    ["a carriage return", "good\rEVIL=1"],
    ["a NUL", "good\u0000EVIL=1"],
    ["an ANSI escape that would rewrite a support engineer's terminal", "k\u001b[2Jey"],
    ["a bare control byte", "key\u0007"],
    ["a DEL", "key\u007f"],
    ["a non-ASCII character", "clé_secrète"],
  ])("refuses a value containing %s", async (_label, value) => {
    const { status } = await post({ key: "BRAVE_API_KEY", value });
    expect(status).toBe(400);
    await expect(fs.access(envPath())).rejects.toThrow();
  });

  it("accepts every printable ASCII character, which is what real tokens use", async () => {
    // 0x20..0x7E, the whole allowed range in one value.
    const all = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join("");
    expect((await post({ key: "BRAVE_API_KEY", value: all })).status).toBe(200);
    const { readHermesEnv } = await import("@/lib/hermes-skill-secrets");
    expect((await readHermesEnv()).get("BRAVE_API_KEY")).toBe(all);
  });

  it("refuses a value past the length cap and stores one at it", async () => {
    expect((await post({ key: "BRAVE_API_KEY", value: "x".repeat(4097) })).status).toBe(400);
    expect((await post({ key: "BRAVE_API_KEY", value: "x".repeat(4096) })).status).toBe(200);
  });

  // CodeQL js/file-system-race on readHermesEnv (PR #465): the size and
  // regular-file checks used to run against a stat of the path, then the read
  // ran against the path again. They now run against one open descriptor, and
  // the open is non-blocking so the regular-file check can still be reached.
  it("does not hang on a path that is not a regular file", async () => {
    const { HermesEnvUnreadableError, readHermesEnv } = await import("@/lib/hermes-skill-secrets");
    try {
      execFileSync("mkfifo", [envPath()]);
      if (!(await fs.stat(envPath())).isFIFO()) return;
    } catch {
      return; // no real FIFOs here; CI runs on Linux, which has them
    }
    // Two properties, and the first is why the open is O_NONBLOCK: it must
    // ANSWER. A blocking open of a writer-less FIFO parks the request forever.
    let timer: ReturnType<typeof setTimeout>;
    const hung = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("readHermesEnv hung on a fifo")), 2000);
    });
    let outcome: unknown;
    try {
      outcome = await Promise.race([readHermesEnv().catch((err: unknown) => err), hung]);
    } finally {
      clearTimeout(timer!);
    }
    // And the answer must be a fault. A FIFO reads as zero bytes, which would
    // otherwise be reported as "no keys are set" for a device whose secrets
    // file has been replaced by a pipe.
    expect(outcome).toBeInstanceOf(HermesEnvUnreadableError);
  });

  // Answering "nothing is set" for a file nobody could read is the wrong answer
  // twice over: the owner is shown an empty field for a credential that may
  // well be there, and a clear reports a key already gone that it never looked
  // for.
  it("raises rather than reporting an empty store when the path is a directory", async () => {
    const { HermesEnvUnreadableError, readHermesEnv } = await import("@/lib/hermes-skill-secrets");
    await fs.mkdir(envPath());
    await expect(readHermesEnv()).rejects.toBeInstanceOf(HermesEnvUnreadableError);
  });

  it("answers the presence GET 500 rather than reporting every key unset", async () => {
    await fs.mkdir(envPath());
    const { status, body } = await get("BRAVE_API_KEY");
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: "env_unreadable" });
    expect(body.secrets).toBeUndefined();
  });

  // The one CodeRabbit found: clearHermesSecret read the file, got an empty map
  // from the swallowed failure, concluded the key was already absent and
  // answered 200 {set:false} for a secret it never removed.
  it("does not report a key cleared when it could not read the file", async () => {
    await fs.mkdir(envPath());
    const { status, body } = await post({ key: "BRAVE_API_KEY", value: "" });
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: "env_unreadable" });
    expect(body).not.toMatchObject({ ok: true });
  });

  it("is 404 off Hermes, like the rest of the skills family", async () => {
    const harness = await import("@/lib/harness");
    vi.mocked(harness.getActiveHarness).mockResolvedValue("openclaw" as never);
    expect((await post({ key: "BRAVE_API_KEY", value: "x" })).status).toBe(404);
    expect((await get("BRAVE_API_KEY")).status).toBe(404);
  });
});

// ── round 2, gap 1: saving one key must not rewrite the file ────────────────
//
// Live on the box: saving ONE skill API key took ~/.hermes/.env from 24 792
// bytes to 372 — 504 lines to 12, and 116 commented-out key hints to 0. The
// module rewrote the whole file from a parsed map on the premise that it owns
// it. It does not: the installer creates that file from Hermes' own template
// ("Created ~/.hermes/.env from template") and `hermes config env-path` points
// customers at it. No live value was lost, and all of the documentation was.
//
// Same class as the config.yaml rewrite TASK-446 hit, fixed there by a
// merge-write; these are the merge-write's terms.

/** ~/.hermes/.env as the installer creates it: hints, blanks, live settings. */
function hermesTemplate(): string {
  const lines = [
    "# Hermes environment",
    "# One KEY=value per line. Uncomment a key to enable it.",
    "",
    "# ── Messaging ─────────────────────────────────────────────",
    "TELEGRAM_BOT_TOKEN=123:abc",
    "# TELEGRAM_ALLOWED_CHATS=",
    "# DISCORD_BOT_TOKEN=",
    "",
    "# ── Providers ─────────────────────────────────────────────",
    "ANTHROPIC_API_KEY=sk-ant-live",
  ];
  // The bulk of the real file: commented hints naming every variable Hermes
  // understands. These are the 116 lines the rewrite destroyed.
  for (let i = 0; i < 116; i++) lines.push(`# HERMES_OPTION_${i}=`);
  lines.push("", "# ── Local ─────────────────────────────────────────────────", "OLLAMA_HOST=127.0.0.1:11434", "");
  return lines.join("\n");
}

function commentedHints(raw: string): number {
  return raw.split("\n").filter((l) => /^#\s*[A-Za-z_][A-Za-z0-9_]*=/.test(l)).length;
}

describe("skill secrets keep the rest of .env (TASK-452 round 2, gap 1)", () => {
  it("adds a key and changes NOTHING else — the round trip that regressed", async () => {
    const before = hermesTemplate();
    await fs.writeFile(envPath(), before, { mode: 0o600 });

    const { status } = await post({ key: "BRAVE_API_KEY", value: "brv_live" });
    expect(status).toBe(200);

    const after = await fs.readFile(envPath(), "utf8");
    // The whole previous file is still there, byte for byte, and the new
    // assignment is the only addition.
    expect(after).toBe(`${before}BRAVE_API_KEY=brv_live\n`);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("keeps every commented key hint the installer's template documents", async () => {
    const before = hermesTemplate();
    await fs.writeFile(envPath(), before, { mode: 0o600 });
    expect(commentedHints(before)).toBe(118);

    await post({ key: "BRAVE_API_KEY", value: "brv_live" });

    const after = await fs.readFile(envPath(), "utf8");
    expect(commentedHints(after)).toBe(118);
    expect(after.split("\n")).toHaveLength(before.split("\n").length + 1);
  });

  it("keeps every other live setting, and their order", async () => {
    await fs.writeFile(envPath(), hermesTemplate(), { mode: 0o600 });
    await post({ key: "BRAVE_API_KEY", value: "brv_live" });

    const { readHermesEnv } = await import("@/lib/hermes-skill-secrets");
    const env = await readHermesEnv();
    expect(env.get("TELEGRAM_BOT_TOKEN")).toBe("123:abc");
    expect(env.get("ANTHROPIC_API_KEY")).toBe("sk-ant-live");
    expect(env.get("OLLAMA_HOST")).toBe("127.0.0.1:11434");
    expect(env.get("BRAVE_API_KEY")).toBe("brv_live");

    const after = await fs.readFile(envPath(), "utf8");
    expect(after.indexOf("TELEGRAM_BOT_TOKEN")).toBeLessThan(after.indexOf("ANTHROPIC_API_KEY"));
  });

  it("edits an existing key in place — exactly one line differs", async () => {
    const before = hermesTemplate();
    await fs.writeFile(envPath(), before, { mode: 0o600 });

    await post({ key: "ANTHROPIC_API_KEY", value: "sk-ant-new" });

    const after = (await fs.readFile(envPath(), "utf8")).split("\n");
    const differing = before.split("\n").map((line, i) => [line, after[i]]).filter(([a, b]) => a !== b);
    expect(differing).toEqual([["ANTHROPIC_API_KEY=sk-ant-live", "ANTHROPIC_API_KEY=sk-ant-new"]]);
  });

  it("clears a key by removing its line, and nothing else", async () => {
    const before = hermesTemplate();
    await fs.writeFile(envPath(), before, { mode: 0o600 });

    const { status } = await post({ key: "ANTHROPIC_API_KEY", value: "" });
    expect(status).toBe(200);

    const after = await fs.readFile(envPath(), "utf8");
    expect(after).toBe(before.replace("ANTHROPIC_API_KEY=sk-ant-live\n", ""));
    expect(commentedHints(after)).toBe(118);
  });

  // The `export KEY=` form has to be RECOGNISED, or the write appends a second
  // assignment below it and the old credential wins on the next read. The
  // rewritten line drops the prefix and the file is normalised to LF, because
  // that is what Hermes' own writer does to a file it edits — a skill secret
  // goes through the same writer as every other Hermes setting rather than
  // inventing a second dialect for one file.
  it("replaces an export-prefixed assignment in place instead of duplicating it", async () => {
    await fs.writeFile(envPath(), "# note\nexport BRAVE_API_KEY=old\n# tail\n", { mode: 0o600 });

    await post({ key: "BRAVE_API_KEY", value: "new" });

    expect(await fs.readFile(envPath(), "utf8")).toBe("# note\nBRAVE_API_KEY=new\n# tail\n");
  });

  // A file that assigns the same key twice is ambiguous about which one a
  // parser takes, so leaving a stale duplicate behind is how the previous
  // credential comes back.
  it("rewrites every assignment of the key, leaving no stale credential", async () => {
    await fs.writeFile(envPath(), "BRAVE_API_KEY=old1\n# hint\nBRAVE_API_KEY=old2\n", { mode: 0o600 });

    await post({ key: "BRAVE_API_KEY", value: "new" });

    const after = await fs.readFile(envPath(), "utf8");
    // The first definition is rewritten in place, so key order is stable, and
    // the shadowing duplicate is dropped rather than left holding a value.
    expect(after).toBe("BRAVE_API_KEY=new\n# hint\n");
    expect(after).not.toContain("old");
  });

  it("appends to a file with no trailing newline without joining two lines", async () => {
    await fs.writeFile(envPath(), "TELEGRAM_BOT_TOKEN=123:abc", { mode: 0o600 });

    await post({ key: "BRAVE_API_KEY", value: "brv" });

    expect(await fs.readFile(envPath(), "utf8")).toBe("TELEGRAM_BOT_TOKEN=123:abc\nBRAVE_API_KEY=brv\n");
  });

  // A file this module could not READ is a file it must not WRITE: the old code
  // fell back to an empty map, and an empty map serialises to a two-line file.
  it("refuses the write when the path is not a regular file, and leaves it alone", async () => {
    await fs.mkdir(envPath());

    const { status, body } = await post({ key: "BRAVE_API_KEY", value: "brv" });
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: "env_unreadable" });
    expect((await fs.stat(envPath())).isDirectory()).toBe(true);
  });

  it("refuses the write when the file is past the size this module will parse", async () => {
    const huge = `# big\n${"# padding padding padding\n".repeat(12_000)}TELEGRAM_BOT_TOKEN=123:abc\n`;
    await fs.writeFile(envPath(), huge, { mode: 0o600 });

    const { status, body } = await post({ key: "BRAVE_API_KEY", value: "brv" });
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: "env_unreadable" });
    expect(await fs.readFile(envPath(), "utf8")).toBe(huge);
  });

  it("leaves no temporary file behind next to the secrets file", async () => {
    await fs.writeFile(envPath(), hermesTemplate(), { mode: 0o600 });
    await post({ key: "BRAVE_API_KEY", value: "brv" });

    const entries = await fs.readdir(hermesHome);
    expect(entries.filter((name) => name.startsWith(".env."))).toEqual([]);
  });
});
