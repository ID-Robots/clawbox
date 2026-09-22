/**
 * The owner's "let the team lead change the plan" switch (`coding_team_dynamic`).
 *
 * OFF unless it is exactly `true`, unlike the media and browser switches: each
 * lead turn is one more paid run after every worker, and a plan that moves
 * under a running team is not the one the owner saw posted. The team reads it
 * once when it starts (pinned in coding-team.test.ts); the route that writes
 * it is the owner's alone (enable.test.ts).
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
  CODING_AGENT_RESET_KEYS,
  CODING_TEAM_DYNAMIC_CONFIG_KEY,
  CodingAgentError,
  getCodingAgentStatus,
  getTeamDynamic,
  setTeamDynamic,
} from "@/lib/coding-agent";

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
});

describe("the team lead's switch", () => {
  it("is stored under coding_team_dynamic, and is off unless it is exactly true", async () => {
    expect(CODING_TEAM_DYNAMIC_CONFIG_KEY).toBe("coding_team_dynamic");
    expect(await getTeamDynamic()).toBe(false);
    for (const value of ["yes", 1, null, "true"]) {
      configGet.mockResolvedValue(value);
      expect(await getTeamDynamic(), String(value)).toBe(false);
    }
    configGet.mockResolvedValue(true);
    expect(await getTeamDynamic()).toBe(true);
  });

  it("refuses anything that is not a boolean, and writes the key when it is", async () => {
    await expect(setTeamDynamic("on")).rejects.toBeInstanceOf(CodingAgentError);
    await expect(setTeamDynamic(1)).rejects.toBeInstanceOf(CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();
    expect(await setTeamDynamic(true)).toBe(true);
    expect(configSet).toHaveBeenCalledWith(CODING_TEAM_DYNAMIC_CONFIG_KEY, true);
    expect(await setTeamDynamic(false)).toBe(false);
    expect(configSet).toHaveBeenLastCalledWith(CODING_TEAM_DYNAMIC_CONFIG_KEY, false);
  });

  it("is in the status the settings panel reads, off by default", async () => {
    expect((await getCodingAgentStatus()).teamDynamic).toBe(false);
    configGetAll.mockResolvedValue({ [CODING_TEAM_DYNAMIC_CONFIG_KEY]: true });
    expect((await getCodingAgentStatus()).teamDynamic).toBe(true);
  });

  it("is cleared by the reset, ahead of the switch that is the consent", () => {
    const keys = [...CODING_AGENT_RESET_KEYS] as string[];
    expect(keys).toContain(CODING_TEAM_DYNAMIC_CONFIG_KEY);
    expect(keys.indexOf(CODING_TEAM_DYNAMIC_CONFIG_KEY)).toBeLessThan(keys.length - 1);
  });
});
