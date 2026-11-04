/**
 * Settings → Channels while the BOX is setting a channel up (TASK-2148).
 *
 * A channel's save, connect or disconnect runs as a job of the box
 * (src/lib/settings-jobs.ts): Settings asks for it with `background: true`
 * (`?background=1` for a body-less DELETE) and follows it. Closed half-way and
 * opened again — here, in another tab, on another device — Settings reads the
 * channel jobs the box runs and draws the truth: the channel being set up,
 * with the turning ring, its pane drawing the job's progress and holding its
 * controls, and the channel's own status read again the moment the job ends.
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

vi.setConfig({ testTimeout: 30_000 });

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));
vi.mock("next/image", () => ({ default: () => null }));

const ui: UISettings = {
  wallpaperId: "default",
  wpFit: "fill",
  wpBgColor: "#000000",
  wpOpacity: 100,
  mascotHidden: false,
  wallpapers: [{ id: "default", name: "Default" }],
  customWallpapers: [],
  onWallpaperChange: vi.fn(),
  onWpFitChange: vi.fn(),
  onWpBgColorChange: vi.fn(),
  onWpOpacityChange: vi.fn(),
  onMascotToggle: vi.fn(),
  onWallpaperUpload: vi.fn(),
  onCustomWallpaperDelete: vi.fn(),
};

/** A channel job as GET /setup-api/background-jobs/tasks answers it. */
function channelJob(id: string, fields: { subject: string; label: string; action: string; title: string; state: string; status?: string; result?: Record<string, unknown> | null; error?: string | null }) {
  return {
    id,
    kind: "channel-setup",
    group: "channel-setup",
    title: fields.title,
    meta: { subject: fields.subject, action: fields.action, label: fields.label },
    state: fields.state,
    steps: [{ id: "apply", label: fields.title, weight: 1, state: fields.state === "running" ? "running" : "done" }],
    status: fields.status ?? null,
    completed: null,
    total: null,
    startedAt: 1,
    updatedAt: 1,
    stepStartedAt: 1,
    finishedAt: fields.state === "running" ? null : 2,
    error: fields.error ?? null,
    result: fields.result ?? null,
    log: [],
    logCount: 0,
    runner: "r",
    dismissed: false,
    cancellable: false,
    cancelRequested: false,
    unit: null,
    adoptedAt: null,
    percent: null,
    etaSeconds: null,
  };
}

type Job = ReturnType<typeof channelJob>;

interface Box {
  job: Job | null;
  telegram: Record<string, unknown>;
  email: Record<string, unknown>;
  statusReads: Record<string, number>;
  requests: Array<{ url: string; method: string; body: unknown }>;
}

function stubBox(initial: Partial<Box> = {}): Box {
  const box: Box = {
    job: null,
    telegram: { configured: false },
    email: { configured: false },
    statusReads: {},
    requests: [],
    ...initial,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method !== "GET") {
      box.requests.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    }
    const status = url.match(/^\/setup-api\/(telegram|email|whatsapp|discord)\/status/);
    if (status) {
      box.statusReads[status[1]] = (box.statusReads[status[1]] ?? 0) + 1;
      if (status[1] === "telegram") return json(box.telegram);
      if (status[1] === "email") return json(box.email);
      return json({ configured: false });
    }
    if (url === "/setup-api/email/configure?background=1" && method === "DELETE") {
      box.job = channelJob("j-email", { subject: "email", label: "Email", action: "disconnect", title: "Disconnecting Email", state: "running", status: "Removing the mailbox from the box…" });
      return json({ taskId: "j-email", started: true, task: box.job }, 202);
    }
    if (url.startsWith("/setup-api/background-jobs/tasks")) {
      const id = new URL(url, "http://box").searchParams.get("id");
      if (id) return box.job?.id === id ? json({ task: box.job }) : json({ error: "No such task." }, 404);
      return json({ tasks: box.job ? [box.job] : [] });
    }
    return json({});
  }));
  return box;
}

function openSection(section: string) {
  (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = section;
  return render(<SettingsApp ui={ui} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection;
});

describe("Settings → Channels while the box sets a channel up", () => {
  it("opened during a Telegram setup: the row says so with the turning ring, not the state before it", async () => {
    stubBox({
      job: channelJob("j-tg", { subject: "telegram", label: "Telegram", action: "configure", title: "Setting up Telegram", state: "running", status: "Saving the Telegram bot and restarting the assistant…" }),
    });
    openSection("channels");
    const list = await screen.findByTestId("settings-channels-list");
    const telegram = within(list).getByTestId("settings-channel-telegram");
    await waitFor(() => expect(telegram).toHaveAttribute("data-state", "configuring"));
    expect(telegram).toHaveTextContent("Saving the Telegram bot and restarting the assistant…");
    expect(within(list).getByTestId("settings-channel-job-spinner-telegram")).toHaveTextContent("progress_activity");
    // Only that channel.
    expect(within(list).getByTestId("settings-channel-discord")).not.toHaveAttribute("data-state", "configuring");
  });

  it("the Telegram pane draws the job and holds Save; the box finishing re-reads Telegram without a refresh", async () => {
    const box = stubBox({
      job: channelJob("j-tg", { subject: "telegram", label: "Telegram", action: "configure", title: "Setting up Telegram", state: "running", status: "Saving the Telegram bot and restarting the assistant…" }),
    });
    openSection("telegram");
    expect(await screen.findByTestId("settings-channel-job-telegram")).toBeInTheDocument();
    const input = document.getElementById("settings-tg-token") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "123456789:placeholder_token_value" } });
    // A token is typed, and still the box's setup holds the button.
    const connect = screen.getAllByRole("button").find((b) => (b.textContent ?? "").includes("settings.connect"));
    expect(connect).toBeDefined();
    expect(connect).toBeDisabled();
    const readsBefore = box.statusReads.telegram ?? 0;

    box.telegram = { configured: true, username: "placeholder_bot", receiving: true };
    box.job = channelJob("j-tg", { subject: "telegram", label: "Telegram", action: "configure", title: "Setting up Telegram", state: "succeeded", result: { success: true, status: "Telegram is set up." } });
    await waitFor(() => expect(box.statusReads.telegram ?? 0).toBeGreaterThan(readsBefore), { timeout: 6_000 });
    await waitFor(() => expect(screen.queryByTestId("settings-channel-job-telegram")).not.toBeInTheDocument());
    expect(box.requests).toEqual([]);
  });

  it("disconnecting Email asks the box for a job and finishes on its ending", async () => {
    const box = stubBox({
      email: { configured: true, address: "b••x@example.com", hasPassword: true, mode: "send", askBeforeSend: true, allowedSenders: [], pendingCount: 0 },
    });
    openSection("email");
    const disconnect = await screen.findByRole("button", { name: "settings.emailDisconnect" });
    fireEvent.click(disconnect);
    await waitFor(() => expect(box.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["DELETE /setup-api/email/configure?background=1"]));
    // While the box works, the pane says so and the button waits.
    expect(await screen.findByTestId("settings-channel-job-email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "settings.emailDisconnect" })).toBeDisabled();

    box.email = { configured: false };
    box.job = channelJob("j-email", { subject: "email", label: "Email", action: "disconnect", title: "Disconnecting Email", state: "succeeded", result: { success: true, httpStatus: 200, status: "Email is disconnected." } });
    expect(await screen.findByText("settings.emailDisconnected", {}, { timeout: 6_000 })).toBeInTheDocument();
    expect(box.requests).toHaveLength(1);
  });
});
