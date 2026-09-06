/**
 * The owner's "verify your work on my screen" switch.
 *
 * It is the third setting here that is ON when its key is absent, and the
 * default is the first thing worth pinning: the device already reaches for the
 * desktop Chromium, so a box that has never seen this switch must go on doing
 * exactly that — only an explicit `false` moves a run's browsing into a window
 * nobody can see.
 *
 * The switch is deliberately NOT frozen on the run record the way the media
 * switches are: it decides which browser answers, not which tools exist, so
 * /setup-api/browser reads it per session (that half is pinned in
 * src/tests/routes/browser.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const configGet = vi.hoisted(() => vi.fn());
const configGetAll = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  // The status reads the whole file once rather than one key at a time.
  getAll: configGetAll,
  set: configSet,
}));

import {
  CODING_AGENT_REAL_BROWSER_CONFIG_KEY,
  CODING_AGENT_RESET_KEYS,
  CodingAgentError,
  getCodingAgentStatus,
  getRealBrowser,
  setRealBrowser,
} from "@/lib/coding-agent";

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
});

describe("the real-browser switch", () => {
  it("is on when the box has never seen it, and off only on an explicit false", async () => {
    expect(await getRealBrowser()).toBe(true);
    // Anything that is not `false` — a hand-edited string, a key set to null —
    // still means on, like the media switches it sits beside.
    configGet.mockResolvedValue("no");
    expect(await getRealBrowser()).toBe(true);
    configGet.mockResolvedValue(false);
    expect(await getRealBrowser()).toBe(false);
  });

  it("refuses anything that is not a boolean, and writes the key when it is", async () => {
    await expect(setRealBrowser("yes")).rejects.toBeInstanceOf(CodingAgentError);
    await expect(setRealBrowser(1)).rejects.toBeInstanceOf(CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();
    await setRealBrowser(false);
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_REAL_BROWSER_CONFIG_KEY, false);
    await setRealBrowser(true);
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_REAL_BROWSER_CONFIG_KEY, true);
  });

  it("is in the status, so the settings card and the wizard read one answer", async () => {
    // Absent means on here too: the panel renders `?? true`, and a status that
    // omitted the field would leave it rendering a switch nothing writes.
    expect((await getCodingAgentStatus()).realBrowser).toBe(true);
    configGetAll.mockResolvedValue({ [CODING_AGENT_REAL_BROWSER_CONFIG_KEY]: false });
    expect((await getCodingAgentStatus()).realBrowser).toBe(false);
  });

  it("is cleared by the reset, ahead of the switch that is the consent", () => {
    const keys = [...CODING_AGENT_RESET_KEYS] as string[];
    expect(keys).toContain(CODING_AGENT_REAL_BROWSER_CONFIG_KEY);
    // Clearing it is what puts a reset box back to "yes, use my screen" — and
    // sends the owner back through the wizard step that asks.
    expect(keys.indexOf(CODING_AGENT_REAL_BROWSER_CONFIG_KEY)).toBeLessThan(keys.length - 1);
  });
});
