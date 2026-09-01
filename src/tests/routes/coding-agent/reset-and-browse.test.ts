/**
 * The two routes the setup wizard added.
 *
 * POST /setup-api/coding-agent/reset — puts every setting back and returns the
 * owner to the wizard. Owner-only for the same reason as `enable`: middleware
 * admits the MCP bearer on every /setup-api path, and the wizard it reopens is
 * the consent screen for a delegated shell.
 *
 * GET /setup-api/coding-agent/browse — the folder picker. It is a directory
 * lister the owner's browser calls, so the properties pinned here are the ones
 * that keep it from becoming a second, weaker way to walk the disk: it never
 * leaves the browse root, it never lists a file, and a protected secret store
 * is answered exactly like a folder that is not there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

const SESSION_SECRET = "b".repeat(64);

let base: string;
let restore: () => void;

function ownerCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

beforeEach(() => {
  restore = saveEnv("SESSION_SECRET", "HOME", "FILES_ROOT", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-browse-"));
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.HOME = base;
  process.env.FILES_ROOT = base;
  vi.resetModules();
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("GET /setup-api/coding-agent/browse", () => {
  const browse = async (dir?: string, cookie: string | null = ownerCookie()) => {
    const { GET } = await import("@/app/setup-api/coding-agent/browse/route");
    const url = `http://localhost/setup-api/coding-agent/browse${dir === undefined ? "" : `?dir=${encodeURIComponent(dir)}`}`;
    const { NextRequest } = await import("next/server");
    return GET(new NextRequest(url, { headers: cookie ? { cookie } : {} }));
  };

  it("refuses without an owner session — the agent holds the bearer", async () => {
    const res = await browse(undefined, null);
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
  });

  it("lists folders only, never files", async () => {
    fs.mkdirSync(path.join(base, "Projects"));
    fs.writeFileSync(path.join(base, "notes.txt"), "hi");
    const body = await (await browse()).json();
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["Projects"]);
  });

  it("answers absolute paths — what the caller posts back as the folder", async () => {
    fs.mkdirSync(path.join(base, "Projects"));
    const body = await (await browse()).json();
    expect(body.entries[0].path).toBe(path.join(fs.realpathSync(base), "Projects"));
    expect(path.isAbsolute(body.entries[0].path)).toBe(true);
  });

  it("has no parent at the root, and one below it", async () => {
    fs.mkdirSync(path.join(base, "Projects"));
    expect((await (await browse()).json()).parent).toBeNull();
    const child = await (await browse("Projects")).json();
    expect(child.parent).toBe(fs.realpathSync(base));
  });

  it("skips hidden folders — .ssh and .openclaw are not project folders", async () => {
    fs.mkdirSync(path.join(base, ".ssh"));
    fs.mkdirSync(path.join(base, "Projects"));
    const body = await (await browse()).json();
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["Projects"]);
  });

  it("takes the absolute path the picker hands back", async () => {
    // The listing answers absolute paths and the picker posts one straight
    // back, so reading it as root-relative would look for
    // <root>/home/clawbox/Projects and 404 the folder the owner just tapped.
    fs.mkdirSync(path.join(base, "Projects", "site"), { recursive: true });
    const root = fs.realpathSync(base);
    const body = await (await browse(path.join(root, "Projects"))).json();
    expect(body.path).toBe(path.join(root, "Projects"));
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["site"]);
  });

  it("refuses an absolute path outside the root", async () => {
    const res = await browse("/etc");
    expect(res.status).toBe(404);
  });

  it("refuses a symlink inside the root that leads out of it", async () => {
    // The lexical check cannot see this one: the name is inside the tree and
    // only the resolved target is not.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "coding-outside-"));
    try {
      fs.symlinkSync(outside, path.join(base, "escape"));
      expect((await browse("escape")).status).toBe(404);
      // ...and it is not offered in the listing either, since a symlink is not
      // a directory to readdir's withFileTypes.
      const body = await (await browse()).json();
      expect(body.entries.map((e: { name: string }) => e.name)).not.toContain("escape");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("cannot be walked out of the root", async () => {
    for (const escape of ["../../etc", "/etc", "Projects/../../../etc"]) {
      const res = await browse(escape);
      expect(res.status, escape).toBe(404);
    }
  });

  it("answers 404, not 500, for a folder that is not there", async () => {
    expect((await browse("nope")).status).toBe(404);
  });
});

describe("POST /setup-api/coding-agent/reset", () => {
  it("refuses the MCP bearer and a bare request alike", async () => {
    const { POST } = await import("@/app/setup-api/coding-agent/reset/route");
    const res = await POST(new Request("http://localhost/setup-api/coding-agent/reset", { method: "POST" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
  });

  it("clears the finished run history too — start over means start over", async () => {
    // A reset that left last week's runs listed under a freshly-configured
    // agent was not starting over: the owner finished the wizard and was met
    // by the run they had just reset away.
    const lib = await import("@/lib/coding-agent");
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/coding-agent.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function resetCodingAgentSetup"));
    expect(body.slice(0, body.indexOf("\n}"))).toContain("clearFinishedRuns()");
    // Held runs (live, paused, drafted) are NOT history and must survive —
    // that is clearFinishedRuns' own rule, which reset borrows rather than
    // reimplements.
    expect(typeof lib.clearFinishedRuns).toBe("function");
  });

  it("clears every setting key, the switch included", async () => {
    const { CODING_AGENT_RESET_KEYS } = await import("@/lib/coding-agent");
    // The list is what reset actually writes; a setting added later without a
    // line here would survive a reset and quietly outlive the wizard.
    expect([...CODING_AGENT_RESET_KEYS]).toEqual([
      "coding_agent_default_directory",
      "coding_agent_effort",
      "coding_agent_max_turns",
      "coding_agent_token_limit",
      "coding_agent_review_pass",
      // The auto-PR switch is standing consent for the box to push and merge
      // the agent's work, so "start over" must take it back too.
      "coding_agent_auto_pr",
      "coding_agent_setup_complete",
      "coding_agent_enabled",
    ]);
  });
});
