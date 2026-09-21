/**
 * The owner's two media switches, and what a run is actually given because of
 * them.
 *
 * These are the only settings here that are ON when the key is absent, so the
 * default is the first thing worth pinning: a box that has never seen the
 * switches must offer both, and only an explicit `false` takes one away.
 *
 * The rest is the wiring the switches decide — the MCP allow-list, the
 * environment the run's own server reads, and the two brief paragraphs — each
 * of which is invisible from the settings card and would fail silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const configGet = vi.hoisted(() => vi.fn());
const configGetAll = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  getAll: configGetAll,
  set: configSet,
}));

import {
  buildRunArgs,
  buildRunMcpConfig,
  CODING_AGENT_GEN_AUDIO_CONFIG_KEY,
  CODING_AGENT_GEN_IMAGES_CONFIG_KEY,
  CODING_AGENT_RESET_KEYS,
  CodingAgentError,
  getGenerateAudio,
  getGenerateImages,
  HEADLESS_BRIEF,
  MAX_AUDIO_PER_RUN,
  MAX_IMAGES_PER_RUN,
  MCP_BROWSER_TOOLS,
  MCP_MEDIA_TOOLS,
  MEDIA_BRIEF_AUDIO,
  MEDIA_BRIEF_IMAGES,
  runMcpTools,
  runMediaEnv,
  setGenerateAudio,
  setGenerateImages,
} from "@/lib/coding-agent";

const RUN = { id: "run-abcd1234", directory: "/home/clawbox/Projects/site" };

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
});

describe("the media switches", () => {
  it("are on when the box has never seen them, and off only on an explicit false", async () => {
    expect(await getGenerateImages()).toBe(true);
    expect(await getGenerateAudio()).toBe(true);
    // Anything that is not `false` — a box whose config was hand-edited to a
    // string, a key someone set to null — still means on.
    configGet.mockResolvedValue("no");
    expect(await getGenerateImages()).toBe(true);
    configGet.mockResolvedValue(false);
    expect(await getGenerateImages()).toBe(false);
    expect(await getGenerateAudio()).toBe(false);
  });

  it("refuse anything that is not a boolean, and write the key when it is", async () => {
    await expect(setGenerateImages("yes")).rejects.toBeInstanceOf(CodingAgentError);
    await expect(setGenerateAudio(1)).rejects.toBeInstanceOf(CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();
    await setGenerateImages(false);
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_GEN_IMAGES_CONFIG_KEY, false);
    await setGenerateAudio(true);
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_GEN_AUDIO_CONFIG_KEY, true);
  });

  it("are cleared by the reset, ahead of the switch that is the consent", () => {
    const keys = [...CODING_AGENT_RESET_KEYS] as string[];
    expect(keys).toContain(CODING_AGENT_GEN_IMAGES_CONFIG_KEY);
    expect(keys).toContain(CODING_AGENT_GEN_AUDIO_CONFIG_KEY);
    expect(keys.indexOf(CODING_AGENT_GEN_IMAGES_CONFIG_KEY)).toBeLessThan(keys.length - 1);
  });
});

describe("what a run is given", () => {
  it("adds one MCP tool per switch and nothing when both are off", () => {
    expect(runMcpTools({ images: false, audio: false })).toEqual([...MCP_BROWSER_TOOLS]);
    expect(runMcpTools(undefined)).toEqual([...MCP_BROWSER_TOOLS]);
    expect(runMcpTools({ images: true, audio: false })).toContain(MCP_MEDIA_TOOLS.images);
    expect(runMcpTools({ images: true, audio: false })).not.toContain(MCP_MEDIA_TOOLS.audio);
    expect(runMcpTools({ images: true, audio: true })).toHaveLength(MCP_BROWSER_TOOLS.length + 2);
  });

  it("names only the allowed media in the run server's environment, and omits the variable entirely for none", () => {
    expect(runMediaEnv({ images: true, audio: true })).toBe("images,audio");
    expect(runMediaEnv({ images: false, audio: true })).toBe("audio");
    expect(runMediaEnv({ images: false, audio: false })).toBe("");
    // Absent, not empty: the server reads an absent variable as "register
    // nothing", and an empty one would have to mean the same thing twice.
    const none = JSON.parse(buildRunMcpConfig({ ...RUN, media: { images: false, audio: false } }));
    expect(none.mcpServers.clawbox.env.CLAWBOX_RUN_MEDIA).toBeUndefined();
    const both = JSON.parse(buildRunMcpConfig({ ...RUN, media: { images: true, audio: true } }));
    expect(both.mcpServers.clawbox.env.CLAWBOX_RUN_MEDIA).toBe("images,audio");
  });

  it("appends a brief paragraph only for the tool the run actually has", () => {
    const prompt = (media?: { images: boolean; audio: boolean }) => {
      const args = buildRunArgs({ resumeSessionId: null, effort: "max", run: { ...RUN, media } });
      return args[args.indexOf("--append-system-prompt") + 1];
    };
    expect(prompt()).toBe(HEADLESS_BRIEF);
    expect(prompt({ images: false, audio: false })).toBe(HEADLESS_BRIEF);
    const images = prompt({ images: true, audio: false });
    expect(images).toContain(MEDIA_BRIEF_IMAGES);
    expect(images).not.toContain(MEDIA_BRIEF_AUDIO);
    expect(prompt({ images: false, audio: true })).toContain(MEDIA_BRIEF_AUDIO);
  });

  it("tells the run the project's icon is drawn for it, so it does not spend a picture on one", () => {
    // Learned the hard way everywhere else in this brief: a capable model
    // that is not told will draw its own, lose the never-overwrite race, and
    // have spent the owner's allowance on a file it cannot place.
    expect(MEDIA_BRIEF_IMAGES).toMatch(/favicon\.png/);
    expect(MEDIA_BRIEF_IMAGES).toMatch(/do not draw the project's own icon/i);
    // Linked only when it is there: a spent allowance leaves no favicon behind.
    expect(MEDIA_BRIEF_IMAGES).toMatch(/check with Glob that favicon\.png is there/);
    // And the substitute it reaches for when it cannot draw.
    expect(MEDIA_BRIEF_IMAGES).toMatch(/SVG-to-PNG|imaging library/i);
    expect(MEDIA_BRIEF_AUDIO).toMatch(/one voice/i);
  });

  it("keeps the caps on the record's side, where a retry cannot spend them twice", () => {
    expect(MAX_IMAGES_PER_RUN).toBeGreaterThan(0);
    expect(MAX_AUDIO_PER_RUN).toBeGreaterThan(MAX_IMAGES_PER_RUN);
  });
});
