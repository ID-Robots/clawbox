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
const storeMock = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => storeMock.values[key]),
  set: vi.fn(async (key: string, value: unknown) => { storeMock.values[key] = value; }),
  getKnown: vi.fn(async (key: string) => ({ value: storeMock.values[key], known: true })),
  setMany: vi.fn(async (entries: Record<string, unknown>) => { Object.assign(storeMock.values, entries); }),
}));
const probeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  probeClawboxAiVision: probeMock,
}));

const RETIRED_CHAT = RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS[0];
const [VISION_EXP] = RETIRED_CLAWBOX_AI_VISION_MODEL_IDS;
const FALLBACK = "gpt-5.6-luna";

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
  probeMock.mockReset();
  storeMock.values = {};
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
  it("moves model.default and the auxiliary chat slots ClawBox wrote, keeping the file's comments", async () => {
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
    expect(text.match(/deepseek-v4-flash(?![-\w])/g)).toHaveLength(3);
    // The picture slot is the vision check's, not this migration's.
    expect(text).toContain(`model: ${VISION_EXP}`);
  });

  it("leaves the owner's own values alone", async () => {
    const owner = [
      "model:",
      "  provider: openrouter",
      `  default: deepseek/${RETIRED_CHAT}`,
      "auxiliary:",
      "  vision:",
      "    provider: openai",
      `    model: ${FALLBACK}`,
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

describe("refreshClawaiVisionOnHermes", () => {
  const SEES = { verdict: "flash", model: "deepseek-v4-flash", flash: "sees", fallback: null };
  const FALLS_BACK = { verdict: "fallback", model: FALLBACK, flash: "blind", fallback: "sees" };
  const NOBODY = { verdict: "none", model: null, flash: "blind", fallback: "blind" };

  /** Hermes' `config get auxiliary.vision --json`, answered from the file the test wrote. */
  function visionBlockFromFile() {
    cliMock.mockImplementation(async (args: string[]) => {
      if (args[1] === "get" && args[2] === "auxiliary.vision") {
        const text = readConfig();
        const provider = /vision:\n\s+provider: (\S+)/.exec(text)?.[1];
        const model = /vision:\n\s+provider: \S+\n\s+model: (\S+)/.exec(text)?.[1];
        return provider ? { code: 0, stdout: JSON.stringify({ provider, model: model ?? "" }), stderr: "" }
          : { code: 1, stdout: "", stderr: "Config key not set" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
  }

  beforeEach(() => {
    storeMock.values.clawai_token = "claw_token_abc";
    visionBlockFromFile();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("moves the separate vision model's id to Flash while Flash sees, and records the verdict", async () => {
    writeConfig(["auxiliary:", "  vision:", "    provider: clawai", `    model: ${VISION_EXP}`, ""].join("\n"));
    probeMock.mockResolvedValue(SEES);
    await mod.refreshClawaiVisionOnHermes();
    expect(readConfig()).toContain("model: deepseek-v4-flash");
    expect(storeMock.values.clawai_vision).toMatchObject({ verdict: "flash", model: "deepseek-v4-flash" });
  });

  it("moves pictures to the fallback when upstream took vision away from Flash", async () => {
    writeConfig(["auxiliary:", "  vision:", "    provider: clawai", "    model: deepseek-v4-flash", ""].join("\n"));
    probeMock.mockResolvedValue(FALLS_BACK);
    await mod.refreshClawaiVisionOnHermes();
    expect(readConfig()).toContain(`model: ${FALLBACK}`);
  });

  it("clears OUR slot when nothing can see, so the chat refuses a picture in words", async () => {
    writeConfig(["model:", "  provider: clawai", "auxiliary:", "  vision:", "    provider: clawai", "    model: deepseek-v4-flash", ""].join("\n"));
    probeMock.mockResolvedValue(NOBODY);
    await mod.refreshClawaiVisionOnHermes();
    expect(readConfig()).not.toContain("deepseek-v4-flash");
    expect(storeMock.values.clawai_vision).toMatchObject({ verdict: "none", model: null });
  });

  it("never touches, or even asks about, an owner's own vision model", async () => {
    const owner = ["auxiliary:", "  vision:", "    provider: openai", `    model: ${FALLBACK}`, ""].join("\n");
    writeConfig(owner);
    await mod.refreshClawaiVisionOnHermes();
    expect(probeMock).not.toHaveBeenCalled();
    expect(readConfig()).toBe(owner);
  });

  it("does nothing on a box with no ClawBox AI token or no Hermes", async () => {
    delete storeMock.values.clawai_token;
    writeConfig("model:\n  provider: clawai\n");
    await mod.refreshClawaiVisionOnHermes();
    storeMock.values.clawai_token = "claw_token_abc";
    fs.rmSync(path.join(home, "config.yaml"));
    await mod.refreshClawaiVisionOnHermes();
    expect(probeMock).not.toHaveBeenCalled();
  });
});
