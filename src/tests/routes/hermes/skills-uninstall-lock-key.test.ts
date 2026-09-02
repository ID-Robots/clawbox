import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-09 — the /uninstall route resolved the raw lock KEY and nothing else, so a
 * skill whose SKILL.md name is not its lock key could not be removed by the one
 * string every card, every list and every customer sees: its display name.
 *
 * A ClawHub install lands FLAT under its slug and records that slug as both the
 * lock key and the identifier (pinned by skills-install-clawhub.test.ts's fakeHermes), while its
 * SKILL.md gives it whatever name the author wrote — `martin-weather` on disk,
 * `weather` on the card. `{"id":"weather"}` reached `hermes skills uninstall`
 * unchanged, the CLI answered "not a hub-installed skill (may be a builtin)",
 * and the route turned that into a 404.
 *
 * The repository already had the resolver: `resolveLockKey(idOrName)` is the
 * key-or-identifier pass the INSTALL route makes to name what it just installed. This
 * file pins the uninstall route to it, plus the display-name pass the install
 * route has no use for — and to refusing, never guessing, when a display name
 * answers for two installed skills.
 *
 * The CLI is faked as the box runs it: exit 0 whatever happened, the outcome
 * only in the printed sentence, and the lock entry dropped only for a key it
 * actually holds.
 */

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn() }));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: vi.fn(async () => ""),
  hermesConfigGetMany: vi.fn(async () => ({})),
  invalidateHermesConfigCache: vi.fn(),
}));

import { runHermesCli } from "@/lib/hermes-cli";
import { saveEnv } from "../../helpers/env";

const mockCli = vi.mocked(runHermesCli);

let hermesHome: string;

/** The measured shape: lock key `martin-weather`, SKILL.md name `weather`. */
const KEY = "martin-weather";
const SHOWN = "weather";

function skillsDir(): string {
  return path.join(hermesHome, "skills");
}

async function writeLock(installed: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(skillsDir(), ".hub"), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir(), ".hub", "lock.json"),
    JSON.stringify({ version: 1, installed }),
  );
}

async function readLock(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(skillsDir(), ".hub", "lock.json"), "utf8");
  return (JSON.parse(raw) as { installed: Record<string, unknown> }).installed;
}

/** A skill directory with a SKILL.md whose frontmatter name is `displayName`. */
async function writeSkillDir(dir: string, displayName: string): Promise<void> {
  const full = path.join(skillsDir(), dir);
  await fs.mkdir(full, { recursive: true });
  await fs.writeFile(path.join(full, "SKILL.md"), `---\nname: ${displayName}\n---\nbody\n`);
}

/** A hub lock entry for a flat ClawHub-style install. */
function hubEntry(key: string): Record<string, unknown> {
  return {
    install_path: key,
    files: ["SKILL.md"],
    identifier: key,
    source: "clawhub",
    trust_level: "community",
    scan_verdict: "safe",
  };
}

/**
 * `hermes skills uninstall`, as the device runs it: it resolves the positional
 * argument as a lock KEY, exits 0 either way, and says which happened only in
 * prose.
 */
function fakeHermes(): void {
  mockCli.mockImplementation(async (args: string[]) => {
    if (args[1] !== "uninstall") return { code: 0, stdout: "", stderr: "" };
    const name = args[2];
    const prompt = `\nUninstall '${name}'?\nConfirm [y/N]: `;
    const lock = await readLock();
    if (!Object.prototype.hasOwnProperty.call(lock, name)) {
      return {
        code: 0,
        stdout: `${prompt}Error: '${name}' is not a hub-installed skill (may be a builtin)\n`,
        stderr: "",
      };
    }
    const entry = lock[name] as { install_path?: string };
    delete lock[name];
    await writeLock(lock);
    await fs.rm(path.join(skillsDir(), entry.install_path ?? name), { recursive: true, force: true });
    return { code: 0, stdout: `${prompt}Uninstalled '${name}' from ${name}\n`, stderr: "" };
  });
}

async function uninstall(id: string) {
  const { POST } = await import("@/app/setup-api/hermes/skills/uninstall/route");
  const res = await POST(
    new Request("http://localhost/setup-api/hermes/skills/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Every positional argument the route handed the CLI. */
function cliArgs(): string[] {
  return mockCli.mock.calls.filter((c) => c[0][1] === "uninstall").map((c) => c[0][2]);
}

let restoreEnv: () => void;

beforeEach(async () => {
  vi.resetModules();
  restoreEnv = saveEnv("HERMES_HOME", "CLAWBOX_ROOT");
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-lockkey-"));
  process.env.HERMES_HOME = hermesHome;
  await fs.mkdir(skillsDir(), { recursive: true });
  await writeLock({ [KEY]: hubEntry(KEY) });
  await writeSkillDir(KEY, SHOWN);
  fakeHermes();
});

afterEach(async () => {
  restoreEnv();
  await fs.rm(hermesHome, { recursive: true, force: true });
});

describe("POST …/skills/uninstall — the argument is resolved to a lock key", () => {
  it("removes a skill asked for by the display name its card shows", async () => {
    const res = await uninstall(SHOWN);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    // The CLI only ever resolves lock keys, so the route has to hand it the key.
    expect(cliArgs()).toEqual([KEY]);
    expect(await readLock()).not.toHaveProperty(KEY);
  });

  it("still takes the lock key itself, unchanged", async () => {
    const res = await uninstall(KEY);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(cliArgs()).toEqual([KEY]);
    expect(await readLock()).not.toHaveProperty(KEY);
  });

  it("resolves a store identifier that is not the lock key", async () => {
    // resolveLockKey()'s own tier, reachable here for a slash-less identifier:
    // the identifier is what skill_search and the Skills page carry.
    await writeLock({ "wx-1": { ...hubEntry("wx-1"), identifier: "acme-weather" } });
    await writeSkillDir("wx-1", "Rain");
    const res = await uninstall("acme-weather");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(cliArgs()).toEqual(["wx-1"]);
  });

  it("refuses a display name two installed skills share, naming both keys", async () => {
    await writeLock({ [KEY]: hubEntry(KEY), "acme-weather": hubEntry("acme-weather") });
    await writeSkillDir("acme-weather", SHOWN);
    const res = await uninstall(SHOWN);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ambiguous_name");
    expect(res.body.candidates).toEqual(["acme-weather", KEY]);
    // Removing either would delete a skill nobody asked about.
    expect(cliArgs()).toEqual([]);
    expect(Object.keys(await readLock()).sort()).toEqual(["acme-weather", KEY]);
  });
});

describe("POST …/skills/uninstall — a tie is answered, an exact key is not a tie", () => {
  it("removes the skill whose LOCK KEY is the string, not the one that shows it", async () => {
    // The collision the agent's skill_uninstall used to refuse outright: an
    // official skill keyed `weather` beside a ClawHub one that shows as
    // `weather`. A lock key is a JSON object key, so it settles the question —
    // refusing would leave the official skill unremovable by any string.
    await writeLock({ weather: hubEntry("weather"), [KEY]: hubEntry(KEY) });
    await writeSkillDir("weather", "weather");
    const res = await uninstall("weather");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe("weather");
    expect(cliArgs()).toEqual(["weather"]);
    expect(await readLock()).toHaveProperty(KEY);
  });

  it("refuses two lock entries that share one store identifier", async () => {
    // `/skills/install` passes `name` through to `hermes skills install --name`
    // (its `--name` passthrough), so one store id can land under two keys. Picking
    // the first in lock order deletes a skill nobody named.
    await writeLock({
      "wx-a": { ...hubEntry("wx-a"), identifier: "dup-ident" },
      "wx-b": { ...hubEntry("wx-b"), identifier: "dup-ident" },
    });
    await writeSkillDir("wx-a", "A");
    await writeSkillDir("wx-b", "B");
    const res = await uninstall("dup-ident");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ambiguous_name");
    expect(res.body.candidates).toEqual(["wx-a", "wx-b"]);
    expect(cliArgs()).toEqual([]);
    expect(Object.keys(await readLock()).sort()).toEqual(["wx-a", "wx-b"]);
  });

  it("refuses when one entry's identifier is another's display name", async () => {
    // The tie F-02 was raised for, one tier over: `weather` names the store id
    // `alpha` was installed from AND the card `martin-weather` shows. Resolving
    // the identifier first would silently delete `alpha`.
    await writeLock({
      alpha: { ...hubEntry("alpha"), identifier: SHOWN },
      [KEY]: hubEntry(KEY),
    });
    await writeSkillDir("alpha", "Alpha");
    const res = await uninstall(SHOWN);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ambiguous_name");
    expect(res.body.candidates).toEqual(["alpha", KEY]);
    expect(cliArgs()).toEqual([]);
  });

  it("says which skill went when a display name was resolved", async () => {
    // A builtin called `weather` does not block the hub row that shows as
    // `weather`: the builtin cannot be removed under any string, so the hub row
    // is the only actionable reading — the rule the Skills page and
    // skill_uninstall have always applied. The body has to say so, because a
    // client that passed the display name never saw the lock key.
    await fs.writeFile(path.join(skillsDir(), ".bundled_manifest"), `${SHOWN}:abc123\n`);
    await writeSkillDir(SHOWN, SHOWN);
    const res = await uninstall(SHOWN);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe(KEY);
    expect(res.body.requested).toBe(SHOWN);
    expect(cliArgs()).toEqual([KEY]);
  });
});

describe("the install route cannot mint a lock key uninstall would refuse", () => {
  it("rejects a `name` override with a space in it", async () => {
    // `--name "My Weather"` lands under a lock key with a space. skill_list
    // prints it, its "first word" is `My`, and both this route and
    // skill_uninstall then refuse the real key with "Invalid skill name" — the
    // key is unremovable through either surface. The name override becomes the
    // key, so it is validated as a skill name (isValidSkillName), not as
    // free-form metadata (isValidMeta, which allows a space).
    const { POST } = await import("@/app/setup-api/hermes/skills/install/route");
    const res = await POST(
      new Request("http://localhost/setup-api/hermes/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "clawhub/qrcode", name: "My Weather" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: "Invalid name" });
    // Refused before the CLI: nothing was installed under that key.
    expect(mockCli.mock.calls.filter((c) => c[0][1] === "install")).toEqual([]);
  });
});

describe("POST …/skills/uninstall — what resolution must NOT do", () => {
  it("leaves a builtin's display name alone when nothing hub-installed shows it", async () => {
    // Only hub rows are candidates, so this falls through to the CLI unchanged
    // and is answered exactly as it was on beta. NOTE the answer is 404, not the
    // 409 `builtin_skill` the state deserves: `.bundled_manifest` holds the
    // DIRECTORY name (`pdf`) and the request carries the display name, so
    // readBundledManifestNames().has(id) misses. Pre-existing on beta and
    // out of scope here — pinned so the resolution pass cannot be blamed for it.
    await writeSkillDir("pdf", "PDFTools");
    await fs.writeFile(path.join(skillsDir(), ".bundled_manifest"), "pdf:abc123\n");
    const res = await uninstall("PDFTools");
    expect(cliArgs()).toEqual(["PDFTools"]);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_installed");
  });

  it("still answers not_installed for a name nothing on the device answers to", async () => {
    const res = await uninstall("no-such-skill");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_installed");
    expect(cliArgs()).toEqual(["no-such-skill"]);
  });

  it("still refuses a name the validator rejects, before any lookup", async () => {
    const res = await uninstall("acme/weather");
    expect(res.status).toBe(400);
    expect(cliArgs()).toEqual([]);
  });
});
