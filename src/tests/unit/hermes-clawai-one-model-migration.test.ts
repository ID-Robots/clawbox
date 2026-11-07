import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS,
  RETIRED_CLAWBOX_AI_VISION_MODEL_IDS,
} from "@/lib/clawbox-ai-retired-models";

/**
 * The Hermes half of ClawBox AI's one-model migration (TASK-2261), over a real
 * config.yaml in a temp HERMES_HOME. Only the CLI is mocked: it is what the
 * `providers.clawai.models` repair reads and writes through.
 */

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));
vi.mock("@/lib/hermes-model-options", () => ({ invalidateModelOptions: vi.fn() }));
vi.mock("@/lib/coding-agent", () => ({ getCodingAgentStatus: vi.fn(async () => ({ ready: false })) }));

const RETIRED_CHAT = RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS[0];
const [VISION_EXP, LEGACY_VISION] = RETIRED_CLAWBOX_AI_VISION_MODEL_IDS;

let home: string;
let savedHome: string | undefined;
let mod: typeof import("@/lib/hermes-clawai");

function writeConfig(text: string) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.yaml"), text);
}

function readConfig(): string {
  return fs.readFileSync(path.join(home, "config.yaml"), "utf8");
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-one-model-"));
  savedHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
  cliMock.mockReset();
  // No `providers.clawai` block: the catalogue repair has nothing to do.
  cliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "Config key not set" });
  vi.resetModules();
  mod = await import("@/lib/hermes-clawai");
  mod._resetClawaiModelsReconcileForTests();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("migrateRetiredClawaiModelsInHermes", () => {
  it("moves model.default and the auxiliary slots ClawBox wrote, keeping the file's comments", async () => {
    writeConfig([
      "# ── Model ──",
      "model:",
      "  provider: clawai",
      `  default: ${RETIRED_CHAT}`,
      "auxiliary:",
      "  vision:",
      "    provider: clawai",
      `    model: ${VISION_EXP}`,
      "  title_generation:",
      "    provider: clawai",
      `    model: ${RETIRED_CHAT}`,
      "  compression:",
      "    provider: clawai",
      `    model: ${RETIRED_CHAT}`,
      "",
    ].join("\n"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await mod.migrateRetiredClawaiModelsInHermes()).toBe(true);

    log.mockRestore();
    const text = readConfig();
    expect(text).toContain("# ── Model ──");
    expect(text).not.toContain(RETIRED_CHAT);
    expect(text).not.toContain(VISION_EXP);
    expect(text.match(/deepseek-v4-flash/g)).toHaveLength(4);
  });

  it("moves the older vision id too", async () => {
    writeConfig(["auxiliary:", "  vision:", "    provider: clawai", `    model: ${LEGACY_VISION}`, ""].join("\n"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await mod.migrateRetiredClawaiModelsInHermes()).toBe(true);
    expect(readConfig()).toContain("model: deepseek-v4-flash");
  });

  it("leaves the owner's own values alone", async () => {
    const owner = [
      "model:",
      "  provider: openrouter",
      `  default: deepseek/${RETIRED_CHAT}`,
      "auxiliary:",
      "  vision:",
      "    provider: openai",
      `    model: ${LEGACY_VISION}`,
      "  title_generation:",
      "    provider: clawai",
      "    model: deepseek-v4-flash",
      "",
    ].join("\n");
    writeConfig(owner);
    expect(await mod.migrateRetiredClawaiModelsInHermes()).toBe(false);
    expect(readConfig()).toBe(owner);
  });

  it("has nothing to do on a box with no Hermes", async () => {
    expect(await mod.migrateRetiredClawaiModelsInHermes()).toBe(false);
    expect(cliMock).not.toHaveBeenCalled();
  });

  it("repairs the picker list through the catalogue repair", async () => {
    writeConfig("model:\n  provider: clawai\n  default: deepseek-v4-flash\n");
    const block = { base_url: "https://clawbox.com/api/ai", api_mode: "openai", models: ["deepseek-v4-flash", RETIRED_CHAT] };
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === "providers.clawai") return { code: 0, stdout: JSON.stringify(block), stderr: "" };
      if (args[1] === "set" && args[2] === "providers.clawai.models") {
        block.models = JSON.parse(args[3]);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[1] === "get" && args[2] === "providers.clawai.models") {
        return { code: 0, stdout: JSON.stringify(block.models), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await mod.migrateRetiredClawaiModelsInHermes();

    expect(block.models).toEqual(["deepseek-v4-flash"]);
  });
});
