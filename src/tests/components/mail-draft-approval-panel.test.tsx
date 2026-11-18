// Settings → Email → Send approved drafts, as the owner's browser draws it.
//
// What is pinned here is the difference between "not your panel" and "the read
// failed": a staff browser or a box without the route gets nothing, and any
// other failure says so and offers a Retry that reads again — the setting is
// not silently missing on a box whose web server answered 503 once.

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import MailDraftApprovalPanel from "@/components/MailDraftApprovalPanel";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => key }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const SNAPSHOT = {
  enabled: true,
  endpoint: "http://127.0.0.1:8790",
  authHeader: "Authorization",
  hasAuth: true,
  active: true,
};

function stubReads(answers: (Response | Error)[]) {
  const fetchMock = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (next instanceof Error) throw next;
    return next.clone();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ok = (body: unknown) => Response.json(body);
const code = (status: number) => new Response("{}", { status });

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("MailDraftApprovalPanel", () => {
  it("shows the setting the box holds", async () => {
    stubReads([ok(SNAPSHOT)]);
    render(<MailDraftApprovalPanel />);
    const endpoint = await screen.findByTestId("settings-email-draft-approval-endpoint");
    expect((endpoint as HTMLInputElement).value).toBe("http://127.0.0.1:8790");
    expect(screen.queryByTestId("settings-email-draft-approval-retry")).toBeNull();
  });

  it("draws nothing at all when the route refuses the person asking", async () => {
    for (const status of [401, 403, 404]) {
      stubReads([code(status)]);
      const { container, unmount } = render(<MailDraftApprovalPanel />);
      await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
      expect(container.querySelector("[data-testid='settings-email-draft-approval']"), String(status)).toBeNull();
      unmount();
    }
  });

  it("says a failed read failed, and the Retry reads again and shows the setting", async () => {
    const fetchMock = stubReads([code(503), ok(SNAPSHOT)]);
    render(<MailDraftApprovalPanel />);
    expect((await screen.findByTestId("settings-email-draft-approval-note")).textContent)
      .toBe("settings.email.draftApproval.readFailed");
    fireEvent.click(screen.getByTestId("settings-email-draft-approval-retry"));
    const endpoint = await screen.findByTestId("settings-email-draft-approval-endpoint");
    expect((endpoint as HTMLInputElement).value).toBe("http://127.0.0.1:8790");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("settings-email-draft-approval-retry")).toBeNull();
  });

  it("offers the same Retry when the connection drops or the answer is not the setting", async () => {
    for (const answer of [new TypeError("Failed to fetch"), ok({ not: "a snapshot" })]) {
      stubReads([answer]);
      const { unmount } = render(<MailDraftApprovalPanel />);
      await screen.findByTestId("settings-email-draft-approval-retry");
      unmount();
    }
  });
});
