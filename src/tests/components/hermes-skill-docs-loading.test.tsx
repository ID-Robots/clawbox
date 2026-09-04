import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@/tests/helpers/test-utils";
import { SkillDetail } from "@/components/hermes-skills/SkillDetail";

/**
 * TASK-635, second half — the Documentation skeleton said nothing.
 *
 * The phase-2 documentation fetch shells out to `hermes skills inspect`. On a
 * Hermes box it takes 9.5-14.6 s (measured read-only, 2026-09-04), and for that
 * whole time the panel showed five grey bars and no words: the only label was
 * `sr-only`, so a sighted owner could not tell a slow fetch from a dead panel.
 *
 * Two contracts, and the second is the one the first endangers:
 *
 *   The section must SAY it is fetching and count the seconds, on screen.
 *
 *   Nothing may put that ticking number inside a live region. `role="status"`
 *   is implicitly atomic, so a per-second change there is a per-second
 *   re-announcement of the whole line — the trap ChatPopup's voice clock and
 *   CodingAgentActivityPill each had to close. What is announced is one
 *   persistently-mounted region whose text changes at most twice per skill.
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

const SKILL = { id: "accelerated-computing-cudf", name: "cuDF", source: "github", trust: "trusted" };

function renderDetail(phase: "meta" | "docs" | "done", body?: string) {
  return render(
    <SkillDetail
      skill={SKILL}
      detail={{ id: SKILL.id, name: SKILL.name, source: SKILL.source, ...(body ? { body } : {}) } as never}
      phase={phase}
      error={null}
      ambiguous={null}
      action={null}
      breadcrumb="Installed"
      installedNames={new Set([SKILL.id])}
      onBack={() => {}}
      onOpenSkill={() => {}}
    />,
  );
}

/** The one region that speaks: persistently mounted, `sr-only`. */
function liveRegion(): HTMLElement {
  return document.querySelector('p.sr-only[role="status"]') as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Documentation section while the phase-2 fetch runs", () => {
  it("shows the label to a sighted owner, not only to a screen reader", () => {
    renderDetail("docs");
    const label = screen.getAllByText(/Loading documentation/).find((el) => !el.className.includes("sr-only"));
    expect(label).toBeTruthy();
  });

  it("counts the seconds while the fetch runs", async () => {
    renderDetail("docs");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByText(/\b4s\b/)).toBeTruthy();
  });

  it("keeps the ticking number out of the accessibility tree", async () => {
    renderDetail("docs");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const spoken = liveRegion();
    const before = spoken.textContent;
    expect(before).toBe("Loading documentation…");
    // The number is on screen...
    expect(screen.getByText(/\b3s\b/).closest('[aria-hidden="true"]')).toBeTruthy();
    // ...and six more seconds change nothing that would be read out again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(liveRegion().textContent).toBe(before);
  });

  it("keeps the region mounted once the documentation lands, and empties it", () => {
    const { rerender } = renderDetail("docs");
    expect(liveRegion().textContent).toBe("Loading documentation…");

    rerender(
      <SkillDetail
        skill={SKILL}
        detail={{ id: SKILL.id, name: SKILL.name, source: SKILL.source, body: "# cuDF\n\nDocs." } as never}
        phase="done"
        error={null}
        ambiguous={null}
        action={null}
        breadcrumb="Installed"
        installedNames={new Set([SKILL.id])}
        onBack={() => {}}
        onOpenSkill={() => {}}
      />,
    );

    // Still there — the emptying is what says the wait is over.
    expect(liveRegion()).toBeTruthy();
    expect(liveRegion().textContent).toBe("");
  });

  it("does not put a stopwatch on phase 1, or announce a fetch that has not started", async () => {
    // Phase 1 reads disk and never spawns the CLI, and `useSkillDetail` reports
    // `meta` for a frame on every selection change. The placeholder stays —
    // every card below it is gated on `detail`, so removing it would leave a
    // blank body — but nothing times it and nothing is announced.
    renderDetail("meta");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.queryByText(/\b\ds\b/)).toBeNull();
    expect(liveRegion().textContent).toBe("");
    // Still on screen, just silent: one occurrence, the visible one.
    expect(screen.getAllByText("Loading documentation…").length).toBe(1);
  });
});
