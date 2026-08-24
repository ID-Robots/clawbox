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
  return { status: res.status, body: (await res.json()) as { secrets?: Record<string, boolean> } };
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
  it("reads nothing through a path that is not a regular file, and does not hang", async () => {
    const { readHermesEnv } = await import("@/lib/hermes-skill-secrets");
    execFileSync("mkfifo", [envPath()]);
    await expect(
      Promise.race([
        readHermesEnv(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("readHermesEnv hung on a fifo")), 2000)),
      ]),
    ).resolves.toEqual(new Map());
  });

  it("reads nothing when the path is a directory", async () => {
    const { readHermesEnv } = await import("@/lib/hermes-skill-secrets");
    await fs.mkdir(envPath());
    expect(await readHermesEnv()).toEqual(new Map());
  });

  it("is 404 off Hermes, like the rest of the skills family", async () => {
    const harness = await import("@/lib/harness");
    vi.mocked(harness.getActiveHarness).mockResolvedValue("openclaw" as never);
    expect((await post({ key: "BRAVE_API_KEY", value: "x" })).status).toBe(404);
    expect((await get("BRAVE_API_KEY")).status).toBe(404);
  });
});
