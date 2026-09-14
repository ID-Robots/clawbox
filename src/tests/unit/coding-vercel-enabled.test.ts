/**
 * The box-wide Vercel switch (`coding_vercel_enabled`, src/lib/coding-agent.ts).
 *
 * Three properties, each of which fails silently if it breaks:
 *
 *  1. IT IS OFF WHEN ABSENT. It is standing consent for this box to push the
 *     owner's code to another company's account, so the safe reading of "never
 *     asked" is no — the opposite of the media and browser preferences beside
 *     it, which are on when absent.
 *  2. EXCEPT ON A BOX THAT WAS ALREADY DEPLOYING. Shipping (1) alone would take
 *     a working feature away from every existing owner overnight, with nothing
 *     on the screen to say where it went. A box with a Vercel LINK has answered
 *     this question by attaching one.
 *  3. THE MIGRATION HAPPENS ONCE, and never writes a stored `false`. A box with
 *     no link must be left with the key absent, so the owner who attaches
 *     nothing is never given a `false` they would have to find and undo.
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

const readVercelLinks = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vercel-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vercel-link")>()),
  readVercelLinks,
}));

import {
  CODING_VERCEL_ENABLED_CONFIG_KEY,
  CodingAgentError,
  readVercelEnabled,
  setVercelEnabled,
} from "@/lib/coding-agent";

/** One link, in the shape the store answers with. */
const LINK = {
  projectId: "prj_acme",
  teamId: null,
  tokenSecretName: "VERCEL_TOKEN",
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
  readVercelLinks.mockReset().mockResolvedValue({});
});

describe("the switch itself", () => {
  it("is OFF on a box that has never been asked and has no link", async () => {
    expect(await readVercelEnabled()).toBe(false);
    // And nothing was written: an absent key stays absent.
    expect(configSet).not.toHaveBeenCalled();
  });

  it("reads a stored value and nothing else — a stored false is never re-migrated", async () => {
    configGet.mockResolvedValue(false);
    readVercelLinks.mockResolvedValue({ shop: LINK });
    expect(await readVercelEnabled()).toBe(false);
    // The owner turned it off WITH a link attached. Reading the links again
    // would put the switch straight back on and make "off" unreachable.
    expect(readVercelLinks).not.toHaveBeenCalled();
    expect(configSet).not.toHaveBeenCalled();

    configGet.mockResolvedValue(true);
    expect(await readVercelEnabled()).toBe(true);
  });

  it("treats a non-boolean stored value as absent, not as truthy", async () => {
    // A hand-edited config, or a key left by something else. Falling through to
    // the migration is right: it asks the box a question it can answer.
    configGet.mockResolvedValue("yes");
    expect(await readVercelEnabled()).toBe(false);
  });

  it("refuses anything that is not a boolean, and writes the key when it is", async () => {
    await expect(setVercelEnabled("yes")).rejects.toBeInstanceOf(CodingAgentError);
    await expect(setVercelEnabled(1)).rejects.toBeInstanceOf(CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();

    expect(await setVercelEnabled(true)).toBe(true);
    expect(configSet).toHaveBeenCalledWith(CODING_VERCEL_ENABLED_CONFIG_KEY, true);
    expect(await setVercelEnabled(false)).toBe(false);
    expect(configSet).toHaveBeenLastCalledWith(CODING_VERCEL_ENABLED_CONFIG_KEY, false);
  });
});

describe("adopting a box that was already deploying", () => {
  it("switches itself on, once, for a box with a Vercel link", async () => {
    readVercelLinks.mockResolvedValue({ shop: LINK });
    expect(await readVercelEnabled()).toBe(true);
    expect(configSet).toHaveBeenCalledWith(CODING_VERCEL_ENABLED_CONFIG_KEY, true);

    // Once: the write made the key a boolean, so the next read returns before
    // it reaches the links.
    configGet.mockResolvedValue(true);
    configSet.mockClear();
    readVercelLinks.mockClear();
    expect(await readVercelEnabled()).toBe(true);
    expect(readVercelLinks).not.toHaveBeenCalled();
    expect(configSet).not.toHaveBeenCalled();
  });

  it("still answers ON when the write itself failed, and leaves the key for the next read", async () => {
    // An unwritable config must not be the reason the owner's cards disappear.
    readVercelLinks.mockResolvedValue({ shop: LINK });
    configSet.mockRejectedValue(new Error("config.json is not readable"));
    expect(await readVercelEnabled()).toBe(true);
  });

  it("answers OFF when the links cannot be read at all", async () => {
    // The safe direction for a consent, and the key is left absent so the box
    // migrates properly once the file can be read again.
    readVercelLinks.mockRejectedValue(new Error("EACCES"));
    expect(await readVercelEnabled()).toBe(false);
    expect(configSet).not.toHaveBeenCalled();
  });
});
