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
  const { skillsEn } = await import("@/lib/hermes-translations/en-skills");
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

/** Every skill-change event the store fires, in order. */
function captureChanges(): SkillChangeEvent[] {
  const seen: SkillChangeEvent[] = [];
  window.addEventListener(SKILL_CHANGE_EVENT, ((e: Event) => {
    seen.push((e as CustomEvent<SkillChangeEvent>).detail);
  }) as EventListener);
  return seen;
}

function mockStore(installedPages: unknown[]) {
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
      if (url.includes("/skills/install") || url.includes("/skills/uninstall")) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("removing a real Hermes skill tells the agent about it", () => {
  it("announces the removal, as a skill, with the name the owner saw", async () => {
    mockStore([INSTALLED, EMPTY]);
    const changes = captureChanges();

    render(<HermesSkillsStore />);
    const remove = await screen.findByRole("button", { name: /remove/i });
    await act(async () => {
      fireEvent.click(remove);
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /remove/i }));
    });

    await waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toMatchObject({ action: "uninstall", kind: "skill", name: "pdf-tools" });
    // And the line the owner's bubble carries says skill, not app.
    expect(buildSkillChangeMessage(changes[0])).toMatch(/skill/);
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
