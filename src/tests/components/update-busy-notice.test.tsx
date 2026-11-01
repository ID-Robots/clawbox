import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";

/**
 * "N agent runs are active: wait for them / update anyway" (issue #1269), on
 * both screens that say it — rendered against the SHIPPED German catalogue, so
 * a locale missing a key shows up as English and fails.
 *
 *  - System Update, when update/run refuses 409 `{ busy: true }`: "Update
 *    anyway" starts it with `ignoreBusy: true`; "Wait for them" asks again
 *    until the box is idle and the update starts by itself.
 *  - /updating, while a running update holds a gateway stop back: "Update
 *    anyway" sends `ignoreBusy: true`, which ends the wait.
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
import UpdatingPage from "@/app/updating/page";

const de = translations.de;
const BUSY = { busy: true, counts: { agentRuns: 1, subagentRuns: 0, codingRuns: 1, total: 2 }, waitMs: 900_000, error: "2 agent runs are active" };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

let runAnswers: Array<{ body: unknown; status: number }>;
let status: unknown;
let posts: { url: string; body: unknown }[];

beforeEach(() => {
  runAnswers = [];
  status = { phase: "idle", steps: [] };
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST") posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/setup-api/update/versions")) {
        return jsonResponse({
          clawbox: { current: "v4.3.0", target: "v4.3.1", updateAvailable: true },
          openclaw: { current: "2026.10.7", target: "2026.10.7", updateAvailable: false },
          edition: "openclaw",
          remote: { reachable: true },
        });
      }
      if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta", effective: { branch: "beta", source: "pin-file" } });
      if (url.includes("/setup-api/update/status")) return jsonResponse(status);
      if (url.includes("/setup-api/update/run")) {
        const next = runAnswers.shift() ?? { body: { started: true }, status: 200 };
        return jsonResponse(next.body, next.status);
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const runPosts = () => posts.filter((p) => p.url.includes("/setup-api/update/run"));

describe("System Update over active agent runs", () => {
  it("asks instead of failing, and \"Update anyway\" starts it with ignoreBusy", async () => {
    runAnswers = [{ body: BUSY, status: 409 }];
    render(<SystemUpdateApp />);

    fireEvent.click(await screen.findByRole("button", { name: de["update.updateEverything"] }));
    const notice = await screen.findByTestId("update-busy-notice");
    expect(notice.textContent).toContain(de["update.busy.active"].replace("{count}", "2"));
    expect(notice.textContent).toContain(de["update.busy.body"]);
    // Not an error, and not a run.
    expect(document.body.textContent).not.toContain(de["update.heroFailed"]);
    expect(runPosts()[0].body).toEqual({ force: true });

    fireEvent.click(screen.getByRole("button", { name: de["update.busy.updateAnyway"] }));
    await waitFor(() => expect(runPosts()).toHaveLength(2));
    expect(runPosts()[1].body).toEqual({ force: true, ignoreBusy: true });
    await waitFor(() => expect(screen.queryByTestId("update-busy-notice")).toBeNull());
  });

  it("\"Wait for them\" asks again until the runs are done, and the update starts by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runAnswers = [
      { body: BUSY, status: 409 },
      { body: { ...BUSY, counts: { agentRuns: 0, subagentRuns: 0, codingRuns: 1, total: 1 } }, status: 409 },
      { body: { started: true }, status: 200 },
    ];
    render(<SystemUpdateApp />);

    fireEvent.click(await screen.findByRole("button", { name: de["update.updateEverything"] }));
    fireEvent.click(await screen.findByRole("button", { name: de["update.busy.wait"] }));
    const notice = await screen.findByTestId("update-busy-notice");
    expect(notice.getAttribute("data-mode")).toBe("waiting");
    expect(notice.textContent).toContain(de["update.busy.waiting"].replace("{count}", "2"));
    expect(notice.textContent).toContain(de["update.busy.waitingHint"]);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => expect(screen.getByTestId("update-busy-notice").textContent).toContain(de["update.busy.waitingOne"]));

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => expect(screen.queryByTestId("update-busy-notice")).toBeNull());
    // Asked without the override every time: waiting is not "update anyway".
    expect(runPosts().map((p) => p.body)).toEqual([{ force: true }, { force: true }, { force: true }]);
  });
});

describe("/updating while the update holds the stop for agent runs", () => {
  it("offers both answers, and \"Update anyway\" sends ignoreBusy", async () => {
    status = {
      phase: "running",
      currentStepIndex: 0,
      steps: [{ id: "openclaw_install", label: "Updating OpenClaw", status: "running", detail: "Waiting for 3 agent runs…" }],
      busyWait: { phase: "waiting", active: 3, startedAt: Date.now(), until: Date.now() + 14.5 * 60_000 },
    };
    render(<UpdatingPage />);

    const notice = await screen.findByTestId("update-busy-notice");
    expect(notice.textContent).toContain(de["update.busy.active"].replace("{count}", "3"));

    fireEvent.click(screen.getByRole("button", { name: de["update.busy.wait"] }));
    await waitFor(() => expect(screen.getByTestId("update-busy-notice").getAttribute("data-mode")).toBe("waiting"));
    expect(screen.getByTestId("update-busy-notice").textContent).toContain(de["update.busy.runnerHint"].replace("{minutes}", "15"));
    expect(runPosts()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: de["update.busy.updateAnyway"] }));
    await waitFor(() => expect(runPosts()).toHaveLength(1));
    expect(runPosts()[0].body).toEqual({ ignoreBusy: true });
    await waitFor(() => expect(screen.queryByTestId("update-busy-notice")).toBeNull());
  });

  it("shows nothing while nothing is held back", async () => {
    status = { phase: "running", currentStepIndex: 0, steps: [{ id: "apt_update", label: "Updating system packages", status: "running" }] };
    render(<UpdatingPage />);
    await screen.findByText("Updating system packages");
    expect(screen.queryByTestId("update-busy-notice")).toBeNull();
  });
});
