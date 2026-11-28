import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The org-mode switch's tri-state read (TASK-2435): `/login-api/users` must
 * not list an organisation's staff because the switch could not be READ, and
 * `get` reads an unreadable store as an empty one. `readOrgModeStrict` asks
 * `getKnown`, which says so.
 */
const h = vi.hoisted(() => ({ known: vi.fn(async () => ({ value: undefined as unknown, known: true })) }));
vi.mock("@/lib/config-store", () => ({ get: vi.fn(async () => undefined), set: vi.fn(), getKnown: h.known }));

import { readOrgMode, readOrgModeStrict } from "@/lib/org-mode-server";

beforeEach(() => {
  h.known.mockReset();
});

describe("readOrgModeStrict", () => {
  it("is null when the store cannot be read, never a home box's false", async () => {
    h.known.mockResolvedValue({ value: undefined, known: false });
    expect(await readOrgModeStrict()).toBeNull();
    h.known.mockRejectedValue(new Error("boom"));
    expect(await readOrgModeStrict()).toBeNull();
  });

  it("reads a stored switch as on only for a literal true", async () => {
    h.known.mockResolvedValue({ value: true, known: true });
    expect(await readOrgModeStrict()).toBe(true);
    h.known.mockResolvedValue({ value: "true", known: true });
    expect(await readOrgModeStrict()).toBe(false);
    h.known.mockResolvedValue({ value: undefined, known: true });
    expect(await readOrgModeStrict()).toBe(false);
  });

  it("leaves the forgiving read a home box for everything else", async () => {
    expect(await readOrgMode()).toBe(false);
  });
});
