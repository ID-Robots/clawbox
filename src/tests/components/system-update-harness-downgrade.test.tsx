import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";

/**
 * "This would install an older assistant", on the screen.
 *
 * A box that ran OpenClaw 2026.10.6 (agent databases on schema 25) is refused a
 * switch to a branch pinning 2026.10.3, by the update-branch route (409) and by
 * Update now (a failed run with `errorCode`). The owner reads it in their own
 * language — rendered here against the SHIPPED German catalogue, so a key a
 * locale lacks shows up as English and fails — and the override beside it is
 * the only gesture that sends `allowHarnessDowngrade: true`.
 */
vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    locale: "de",
    localeResolved: true,
    setLocale: vi.fn(),
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.de[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

import SystemUpdateApp from "@/components/SystemUpdateApp";

const de = translations.de;
const DETAIL = {
  branch: "main",
  downgrades: [{
    harness: "openclaw",
    installed: "2026.10.6",
    target: "2026.10.3",
    schema: { database: "agent", label: "/home/clawbox/.openclaw/agents/main/agent/openclaw-agent.sqlite", onDisk: 25, supported: 24 },
  }],
};
const ENGLISH_REFUSAL = "This device's OpenClaw data is newer than the version this update installs.";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

let status: unknown;
let branchSave: { body: unknown; status: number };
let posts: { url: string; body: unknown }[];

beforeEach(() => {
  status = { phase: "idle", steps: [] };
  branchSave = { body: { success: true, branch: "main", effective: { branch: "main", source: "pin-file" } }, status: 200 };
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST") posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/setup-api/update/versions")) {
        return jsonResponse({
          clawbox: { current: "v4.3.0", target: null, updateAvailable: false },
          openclaw: { current: "2026.10.6", target: "2026.10.6", updateAvailable: false },
          edition: "openclaw",
          remote: { reachable: true },
        });
      }
      if (url.includes("/setup-api/system/update-branch")) {
        if (init?.method === "POST") return jsonResponse(branchSave.body, branchSave.status);
        return jsonResponse({ branch: "beta", effective: { branch: "beta", source: "pin-file" } });
      }
      if (url.includes("/setup-api/update/status")) return jsonResponse(status);
      if (url.includes("/setup-api/update/run")) return jsonResponse({ started: true });
      return jsonResponse({});
    }),
  );
});

describe("Update now refused for installing an older harness", () => {
  it("says it in the owner's language from the detail, never as the server's English", async () => {
    status = {
      phase: "failed",
      currentStepIndex: -1,
      steps: [{ id: "bootstrap_updater", label: "Updating ClawBox", status: "pending" }],
      error: `${ENGLISH_REFUSAL} …`,
      errorCode: "harness_downgrade",
      downgrade: DETAIL,
    };
    render(<SystemUpdateApp />);

    const notice = await screen.findByTestId("update-harness-downgrade");
    expect(notice.textContent).toContain(de["update.harnessDowngrade.titleUpdate"]);
    expect(notice.textContent).toContain(
      de["update.harnessDowngrade.schemaLine"]
        .replaceAll("{harness}", "OpenClaw").replace("{onDisk}", "25").replace("{target}", "2026.10.3").replace("{supported}", "24"),
    );
    expect(notice.textContent).toContain(de["update.harnessDowngrade.body"]);
    expect(document.body.textContent).not.toContain(ENGLISH_REFUSAL);
  });

  it("starts the run again with the override only from its own button", async () => {
    status = { phase: "failed", currentStepIndex: -1, steps: [], error: ENGLISH_REFUSAL, errorCode: "harness_downgrade", downgrade: DETAIL };
    render(<SystemUpdateApp />);

    fireEvent.click(await screen.findByRole("button", { name: de["update.harnessDowngrade.updateAnyway"] }));

    await waitFor(() => expect(posts.some((p) => p.url.includes("/setup-api/update/run"))).toBe(true));
    expect(posts.find((p) => p.url.includes("/setup-api/update/run"))?.body).toEqual({ force: true, allowHarnessDowngrade: true });
  });

  it("says a failed backup, with the reason, and offers the override again", async () => {
    status = {
      phase: "failed", currentStepIndex: -1, steps: [],
      error: "The assistant's data could not be backed up, so the older version was not installed and nothing was changed: disk full",
      errorCode: "harness_downgrade_backup_failed",
      downgrade: DETAIL,
    };
    render(<SystemUpdateApp />);

    const notice = await screen.findByTestId("update-harness-downgrade");
    expect(notice.textContent).toContain(de["update.harnessDowngrade.backupFailed"]);
    expect(notice.textContent).toContain("disk full");
    expect(screen.getByRole("button", { name: de["update.harnessDowngrade.updateAnyway"] })).toBeTruthy();
  });
});

describe("Settings update branch refused for installing an older harness", () => {
  it("keeps the branch on record, says why, and records it only on the override", async () => {
    branchSave = {
      body: { error: "Branch \"main\" would install an older assistant. …", code: "harness_downgrade", downgrade: DETAIL },
      status: 409,
    };
    render(<SystemUpdateApp />);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(de["update.advancedOptions"]) }));
    const input = await screen.findByLabelText(de["update.branchOverride"]);
    fireEvent.change(input, { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: de["update.save"] }));

    const notice = await screen.findByTestId("update-harness-downgrade");
    expect(notice.textContent).toContain(de["update.harnessDowngrade.titleBranch"].replace("{branch}", "main"));
    expect(posts.filter((p) => p.url.includes("update-branch"))).toEqual([
      { url: "/setup-api/system/update-branch", body: { branch: "main" } },
    ]);

    branchSave = { body: { success: true, branch: "main", effective: { branch: "main", source: "pin-file" } }, status: 200 };
    fireEvent.click(screen.getByRole("button", { name: de["update.harnessDowngrade.switchAnyway"] }));

    await waitFor(() => expect(screen.queryByTestId("update-harness-downgrade")).toBeNull());
    expect(posts.filter((p) => p.url.includes("update-branch")).at(-1)?.body).toEqual({ branch: "main", allowHarnessDowngrade: true });
  });
});
