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
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushed = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/lib/pending-actions", () => ({
  pushPendingAction: vi.fn(async (action: Record<string, unknown>) => {
    pushed.push(action);
    return { ...action, id: "id", ts: 0 };
  }),
}));

import { notifyOwner } from "@/lib/email-notify";
import { OPEN_EMAIL_SETTINGS, parseNotifyAction } from "@/lib/notify-action";

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
