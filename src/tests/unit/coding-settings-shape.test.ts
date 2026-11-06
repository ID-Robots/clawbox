/**
 * coding-settings-shape.ts restates two lists the runner owns so the MCP
 * server can name them without importing it (the same arrangement
 * coding-role-models.ts has with EFFORT_LEVELS). These pins are what make the
 * copies safe: a change to either side fails here.
 */
import { describe, expect, it } from "vitest";
import { HISTORY_RETENTION_MODES, OFFERED_EFFORT_LEVELS } from "@/lib/coding-agent";
import { ROLE_AUTO } from "@/lib/coding-role-models";
import {
  AGENT_EFFORT_LEVELS,
  AGENT_HISTORY_RETENTION_MODES,
  AGENT_SETTABLE_FIELDS,
  OWNER_ONLY_FIELDS,
  ROLE_RESET_WORDS,
} from "@/lib/coding-settings-shape";
import { readCodingSettings, settingsViewFrom } from "@/lib/coding-settings-patch";

describe("the restated lists", () => {
  it("offers exactly the effort levels the panel offers", () => {
    expect([...AGENT_EFFORT_LEVELS]).toEqual([...OFFERED_EFFORT_LEVELS]);
  });

  it("offers exactly the history modes the box keeps", () => {
    expect([...AGENT_HISTORY_RETENTION_MODES]).toEqual([...HISTORY_RETENTION_MODES]);
  });

  it("maps its reset words onto the panel's auto", () => {
    expect(ROLE_RESET_WORDS).toContain(ROLE_AUTO);
  });

  it("keeps the settable set and the owner-only set apart", () => {
    const settable = new Set<string>(AGENT_SETTABLE_FIELDS);
    for (const field of OWNER_ONLY_FIELDS) expect(settable.has(field), field).toBe(false);
    // The consent surfaces, by name: a change to this list is a change to
    // what the assistant may grant itself, and wants a reviewer's eye.
    expect([...OWNER_ONLY_FIELDS]).toEqual([
      "enabled", "defaultDirectory", "provider", "providers", "realBrowser",
      "allowRules", "injectSecrets", "secrets", "setupComplete", "clearHarnessFault",
    ]);
  });

  it("the seam exports its reader and view builder", () => {
    expect(typeof readCodingSettings).toBe("function");
    expect(typeof settingsViewFrom).toBe("function");
  });
});
