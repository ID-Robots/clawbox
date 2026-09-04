/**
 * The notice allowlist (src/lib/notify-action.ts) and the one producer that
 * may use it (src/lib/email-notify.ts).
 *
 * A desktop notice can now carry a DESTINATION — the email-approval toast
 * opens Settings → Email when the owner clicks it. The owner-notice ring that
 * carries it is also written from outside this process by `ui_notify` and
 * `clawbox notify`, whose text the AGENT writes, so the destination is a
 * choice from a closed set rather than data: anything not in the table is
 * dropped here, before it can reach a desktop as a click target.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushed = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/lib/pending-actions", () => ({
  pushPendingAction: vi.fn(async (action: Record<string, unknown>) => {
    pushed.push(action);
    return { ...action, id: "id", ts: 0 };
  }),
}));

import { notifyOwner } from "@/lib/email-notify";
import { apps } from "@/lib/desktop-apps";
import { NOTIFY_ACTION_TARGETS, OPEN_EMAIL_SETTINGS, parseNotifyAction, toastDetailForNotice } from "@/lib/notify-action";

beforeEach(() => {
  pushed.length = 0;
});

describe("parseNotifyAction", () => {
  it("accepts the pair the email notice uses", () => {
    expect(parseNotifyAction({ open: "settings", section: "email" })).toEqual({ open: "settings", section: "email" });
    expect(parseNotifyAction(OPEN_EMAIL_SETTINGS)).toEqual(OPEN_EMAIL_SETTINGS);
  });

  it("answers with the TABLE's pair, so nothing extra travels with a valid one", () => {
    expect(
      parseNotifyAction({ open: "settings", section: "email", href: "https://example.invalid", pendingId: "d1" }),
    ).toEqual({ open: "settings", section: "email" });
  });

  it("drops everything that is not on the allowlist", () => {
    for (const value of [
      undefined,
      null,
      "settings",
      42,
      ["settings", "email"],
      {},
      { open: "settings" },
      { section: "email" },
      // A section that exists in Settings but was never offered as a destination.
      { open: "settings", section: "system" },
      // An app that is not a destination.
      { open: "browser", section: "email" },
      // A free-form target, which is what the allowlist exists to refuse.
      { open: "https://example.invalid", section: "email" },
      // Prototype keys reach here from JSON.parse and must not resolve.
      { open: "constructor", section: "email" },
      { open: "settings", section: "toString" },
    ]) {
      expect(parseNotifyAction(value)).toBeNull();
    }
  });
});

describe("notifyOwner", () => {
  it("still pushes a plain notice with no destination — every existing caller is unchanged", async () => {
    await notifyOwner("Something happened");
    expect(pushed).toEqual([{ type: "notify", message: "Something happened" }]);
  });

  it("attaches the destination when one is asked for", async () => {
    await notifyOwner("The assistant wants to send an email.", OPEN_EMAIL_SETTINGS);
    expect(pushed).toEqual([
      { type: "notify", message: "The assistant wants to send an email.", action: { open: "settings", section: "email" } },
    ]);
  });

  it("re-checks the destination here, so a caller cannot widen the allowlist", async () => {
    await notifyOwner("hi", { open: "settings", section: "system" } as unknown as typeof OPEN_EMAIL_SETTINGS);
    expect(pushed).toEqual([{ type: "notify", message: "hi" }]);
  });
});

/**
 * The step that carries a notice OUT of the owner-notice ring and into the
 * toast. It lives in this module rather than inline in the desktop's poll loop
 * so that it can be tested at all: `page.tsx` has no render tests, so a wrong
 * field name there would leave the feature dead on the box with a green suite.
 */
describe("toastDetailForNotice", () => {
  it("carries an allowlisted destination through", () => {
    expect(toastDetailForNotice({ type: "notify", message: "An email is waiting", action: { open: "settings", section: "email" } }))
      .toEqual({ message: "An email is waiting", action: { open: "settings", section: "email" } });
  });

  it("hands a plain notice on with no destination at all", () => {
    expect(toastDetailForNotice({ type: "notify", message: "Coding agent finished" })).toEqual({ message: "Coding agent finished" });
  });

  it("drops a destination the ring should not be carrying", () => {
    expect(toastDetailForNotice({ type: "notify", message: "hi", action: { open: "browser", section: "email" } }))
      .toEqual({ message: "hi" });
  });

  it("shows nothing for a notice with no words", () => {
    expect(toastDetailForNotice({ type: "notify" })).toBeNull();
    expect(toastDetailForNotice({ type: "notify", message: "" })).toBeNull();
    expect(toastDetailForNotice({ type: "notify", message: 42 })).toBeNull();
  });
});

/**
 * The table names an app and a section by string, and BOTH consumers are
 * lenient: `dispatchOpenApp` on an unknown id opens nothing, and SettingsApp's
 * `toSection()` returns null for an unknown section, which its `apply()` then
 * ignores. So a rename on either side would leave the toast dismissing itself
 * and landing the owner on Appearance — a silent false success that every
 * test comparing a fixture against the same constant would sail through.
 * These pin the strings to the lists they have to exist in.
 */
describe("the allowlist points at things that exist", () => {
  it("names built-in desktop apps", () => {
    const ids = new Set(apps.map((a) => a.id));
    for (const open of Object.keys(NOTIFY_ACTION_TARGETS)) expect(ids).toContain(open);
  });

  it("names real Settings sections", () => {
    // SettingsApp is a client component far too heavy to import here, so its
    // own SECTIONS list is read from the source — the pattern
    // desktop-app-names-i18n.test.ts already uses for this kind of cross-file
    // pin.
    const src = readFileSync(join(process.cwd(), "src/components/SettingsApp.tsx"), "utf8");
    const declared = /const SECTIONS = \[([^\]]*)\] as const;/.exec(src);
    expect(declared, "SettingsApp's SECTIONS list moved — this pin needs updating").not.toBeNull();
    const sections = new Set([...declared![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    expect(sections.size).toBeGreaterThan(1);
    for (const section of Object.keys(NOTIFY_ACTION_TARGETS.settings)) expect(sections).toContain(section);
  });
});
