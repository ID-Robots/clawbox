import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import HermesSkillsStore from "@/components/HermesSkillsStore";
import { SKILL_CHANGE_EVENT, buildSkillChangeMessage, type SkillChangeEvent } from "@/lib/skill-change-message";

/**
 * TASK-544, the inverted half.
 *
 * The desktop's confirmation flow — dispatch `clawbox-skill-installed`, the
 * chat opens and asks the agent to confirm the change — was wired to the
 * OpenClaw App Store and to the desktop's uninstall. The Hermes skills store,
 * the ONE surface on that edition where a real skill is installed or removed,
 * dispatched nothing: the owner removed a skill and the agent was never told,
 * while removing a WEBAPP announced that a skill had gone.
 */

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const { skillsEn } = await import("@/lib/edition-translations/en-skills");
  return {
    ...actual,
    useT: () => ({
      locale: "en" as const,
      localeResolved: true,
      setLocale: () => {},
      t: (key: string, params?: Record<string, string | number>) =>
        Object.entries(params ?? {}).reduce(
          (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
          skillsEn[key] ?? key,
        ),
    }),
  };
});

const SKILL = { id: "official/pdf-tools", name: "PDF Tools", source: "official", trust: "official" };

const BROWSE = {
  skills: [SKILL],
  page: 1,
  pageSize: 24,
  total: 1,
  totalPages: 1,
  hasMore: false,
  facets: { sources: [{ id: "official", label: "Official", count: 1 }], providers: [] },
  catalog: { origin: "index", skillCount: 90_600, fetchedAt: new Date().toISOString(), stale: false },
  degraded: false,
};

const HUB_ROW = {
  id: "pdf-tools",
  name: "PDF Tools",
  category: "other",
  origin: "hub",
  source: "official",
  identifier: "official/pdf-tools",
  enabled: true,
};

const INSTALLED = { skills: [HUB_ROW], counts: { total: 1 }, categories: [] };
const EMPTY = { skills: [], counts: { total: 0 }, categories: [] };

/** Every skill-change event the store fires, in order. Removed after each test. */
const listeners: EventListener[] = [];
function captureChanges(): SkillChangeEvent[] {
  const seen: SkillChangeEvent[] = [];
  const listener = ((e: Event) => {
    seen.push((e as CustomEvent<SkillChangeEvent>).detail);
  }) as EventListener;
  window.addEventListener(SKILL_CHANGE_EVENT, listener);
  listeners.push(listener);
  return seen;
}

/** @param action what the install/uninstall route answers. */
function mockStore(installedPages: unknown[], action: () => unknown = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/skills/browse")) return { ok: true, status: 200, json: async () => BROWSE };
      // `/skills/installed` is a prefix match for `/skills/install`.
      if (url.includes("/skills/installed")) {
        const body = installedPages[Math.min(calls, installedPages.length - 1)];
        calls += 1;
        return { ok: true, status: 200, json: async () => body };
      }
      if (url.includes("/skills/install") || url.includes("/skills/uninstall")) return action();
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

async function removeFromInstalledTab() {
  render(<HermesSkillsStore />);
  const remove = await screen.findByRole("button", { name: /remove/i });
  await act(async () => {
    fireEvent.click(remove);
  });
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: /remove/i }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const listener of listeners.splice(0)) window.removeEventListener(SKILL_CHANGE_EVENT, listener);
});

describe("removing a real Hermes skill tells the agent about it", () => {
  it("announces the removal, as a skill, with the name the owner saw", async () => {
    mockStore([INSTALLED, EMPTY]);
    const changes = captureChanges();

    await removeFromInstalledTab();

    await waitFor(() => expect(changes).toHaveLength(1));
    // The DISPLAY name the card showed, with the lock key beside it — the
    // install path announces the display name, and the same skill under two
    // names in one transcript is the defect this card is about, one surface up.
    expect(changes[0]).toMatchObject({ action: "uninstall", kind: "skill", name: "PDF Tools", id: "pdf-tools" });
    const line = buildSkillChangeMessage(changes[0]);
    expect(line).toMatch(/skill/);
    expect(line).toContain('"PDF Tools"');
    // `skill_list` and `skill_uninstall` resolve the lock key, so that is what
    // the agent needs to check against.
    expect(line).toContain("pdf-tools");
  });
});

describe("an outcome the store does not call a success announces nothing", () => {
  const REFUSALS: [string, () => unknown][] = [
    [
      "a leftover the device could not undo (409)",
      () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "x", code: "removal_incomplete", name: "pdf-tools", leftover: { lockEntry: false, directory: "present" } }),
      }),
    ],
    [
      "an unproven removal (502)",
      () => ({ ok: false, status: 502, json: async () => ({ error: "x", code: "uninstall_unproven", name: "pdf-tools" }) }),
    ],
    [
      "a device that timed out (502)",
      () => ({ ok: false, status: 502, json: async () => ({ error: "x", code: "cli_timeout" }) }),
    ],
  ];

  it.each(REFUSALS)("stays silent on %s", async (_label, action) => {
    // This store's whole design is that an unknown outcome is not a success.
    // The guard that matters is against a later edit moving the announcement
    // into the catch, or above the `!res.ok` throw.
    mockStore([INSTALLED, INSTALLED], action);
    const changes = captureChanges();

    await removeFromInstalledTab();
    // Let the failure path finish before asserting nothing happened.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(changes).toEqual([]);
  });
});

describe("installing a Hermes skill tells the agent about it", () => {
  it("announces the install, as a skill", async () => {
    mockStore([EMPTY, INSTALLED]);
    const changes = captureChanges();

    render(<HermesSkillsStore />);
    await act(async () => {
      fireEvent.click(await screen.findByTestId("skill-tab-browse"));
    });
    await screen.findByText("PDF Tools");
    const card = await screen.findByTestId("skill-install-btn");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button"));
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    });

    await waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toMatchObject({ action: "install", kind: "skill", name: "PDF Tools" });
  });
});
