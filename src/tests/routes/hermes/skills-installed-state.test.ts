import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-452 / §3 store-UX — what the Installed tab and the agent are told about
 * a skill that is already on the device.
 *
 * Two findings, both reproduced on the QA box:
 *
 *   ux-junk-categories        every non-`official` install lands FLAT, and
 *                             `install_path.split('/')[0]` turned the skill's
 *                             own slug into a category. Installing two skills
 *                             gave the filter two one-item categories named
 *                             `agent-monitor` and `algorithmic-art`; on a stock
 *                             box with three real single-item categories, a
 *                             handful of installs makes the dropdown mostly
 *                             noise.
 *   ux-disabled-shown-as-enabled
 *                             `enabled: true` was a LITERAL on both branches of
 *                             the enumeration, so the MCP tool's "disabled"
 *                             mark could never fire and the agent was told a
 *                             switched-off skill was available.
 */

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: vi.fn(async () => ""),
  hermesConfigGetMany: vi.fn(async () => ({})),
  invalidateHermesConfigCache: vi.fn(),
}));

import { hermesConfigGet } from "@/lib/hermes-config-cache";

const mockConfigGet = vi.mocked(hermesConfigGet);

let hermesHome: string;

function skillsDir(): string {
  return path.join(hermesHome, "skills");
}

async function writeSkill(rel: string, name: string): Promise<void> {
  const dir = path.join(skillsDir(), rel);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`);
}

async function writeLock(installed: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(skillsDir(), ".hub"), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir(), ".hub", "lock.json"),
    JSON.stringify({ version: 1, installed }),
  );
}

beforeEach(async () => {
  vi.resetModules();
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-inst-"));
  process.env.HERMES_HOME = hermesHome;
  await fs.mkdir(skillsDir(), { recursive: true });
  mockConfigGet.mockResolvedValue("Config key not set: skills.disabled");
});

afterEach(async () => {
  delete process.env.HERMES_HOME;
  await fs.rm(hermesHome, { recursive: true, force: true });
});

async function installed() {
  const { GET } = await import("@/app/setup-api/hermes/skills/installed/route");
  const res = await GET();
  return (await res.json()) as {
    skills: { id: string; category: string; enabled?: boolean; origin: string }[];
    counts: Record<string, number>;
    categories: { id: string; count: number }[];
  };
}

describe("hub categories (TASK-452 ux-junk-categories)", () => {
  beforeEach(async () => {
    await writeSkill("productivity/notes", "notes");
    await fs.writeFile(path.join(skillsDir(), ".bundled_manifest"), "notes:abc\n");
    // Two FLAT installs, exactly as clawhub and github land on a real device.
    await writeSkill("agent-monitor", "agent-monitor");
    await writeSkill("algorithmic-art", "algorithmic-art");
    await writeLock({
      "agent-monitor": { install_path: "agent-monitor", source: "clawhub", identifier: "clawhub/agent-monitor" },
      "algorithmic-art": {
        install_path: "algorithmic-art",
        source: "github",
        identifier: "anthropics/skills/skills/algorithmic-art",
      },
    });
  });

  it("does not mint a one-item category from a skill's own slug", async () => {
    const { skills, categories } = await installed();
    const byId = Object.fromEntries(skills.map((s) => [s.id, s]));
    expect(byId["agent-monitor"].category).toBe("hub");
    expect(byId["algorithmic-art"].category).toBe("hub");
    expect(categories.map((c) => c.id).sort()).toEqual(["hub", "productivity"]);
    expect(categories.find((c) => c.id === "hub")?.count).toBe(2);
  });

  it("still uses a real category directory when the install has one", async () => {
    await writeSkill("creative/simple-english", "simple-english");
    await writeLock({
      "simple-english": { install_path: "creative/simple-english", source: "official" },
    });
    const { skills } = await installed();
    expect(skills.find((s) => s.id === "simple-english")?.category).toBe("creative");
  });

  it("prefers a category the registry declared over the `hub` bucket", async () => {
    await writeLock({
      "agent-monitor": {
        install_path: "agent-monitor",
        source: "clawhub",
        metadata: { hermes: { category: "devops" } },
      },
    });
    const { skills } = await installed();
    expect(skills.find((s) => s.id === "agent-monitor")?.category).toBe("devops");
  });
});

describe("enabled/disabled is read, not asserted (TASK-452 ux-disabled-shown-as-enabled)", () => {
  beforeEach(async () => {
    await writeSkill("productivity/notes", "notes");
    await writeSkill("weather/forecast", "forecast");
    await fs.writeFile(path.join(skillsDir(), ".bundled_manifest"), "notes:abc\nforecast:def\n");
  });

  it("reports a skill Hermes has switched off as disabled, and counts it", async () => {
    mockConfigGet.mockImplementation(async (key: string) =>
      key === "skills.disabled" ? '["forecast"]' : "Config key not set",
    );
    const { skills, counts } = await installed();
    expect(skills.find((s) => s.id === "forecast")?.enabled).toBe(false);
    expect(skills.find((s) => s.id === "notes")?.enabled).toBe(true);
    expect(counts.disabled).toBe(1);
  });

  it("reports everything enabled when nothing is disabled", async () => {
    const { skills, counts } = await installed();
    expect(skills.every((s) => s.enabled === true)).toBe(true);
    expect(counts.disabled).toBe(0);
  });

  it("reads only the GLOBAL disabled list, not the per-platform map", async () => {
    // `skills.platform_disabled` is `{platform: [names]}`. A skill switched off
    // for Telegram is still live for the chat this store belongs to, so calling
    // it disabled here would be a different untruth from the one being fixed.
    mockConfigGet.mockImplementation(async (key: string) =>
      key === "skills.platform_disabled" ? "{'telegram': ['forecast']}" : "Config key not set",
    );
    const { skills } = await installed();
    expect(skills.find((s) => s.id === "forecast")?.enabled).toBe(true);
    expect(mockConfigGet).not.toHaveBeenCalledWith("skills.platform_disabled");
  });
});

describe("parseDisabledSkillList tolerates whatever the CLI prints", () => {
  it.each([
    ["Config key not set: skills.disabled", []],
    ["", []],
    ['["a", "b"]', ["a", "b"]],
    ["['a', 'b']", ["a", "b"]],
    ["a, b", ["a", "b"]],
    ["a\nb", ["a", "b"]],
    // Junk can only ever produce an EMPTY set — never a phantom skill name.
    ["{unexpected: <object>}", []],
    ["../../etc/passwd", []],
  ])("%j -> %j", async (raw, expected) => {
    const { parseDisabledSkillList } = await import("@/lib/hermes-skills-server");
    expect(Array.from(parseDisabledSkillList(raw)).sort()).toEqual(expected);
  });
});
