/**
 * Settings → Discord, connect and go: the owner pastes a token and nothing
 * else. No Application ID field; the invite link comes from the box; and while
 * the bot is in no server the panel keeps asking `{sync:true}` until it has
 * joined, then says so — the step that used to be a conversation with the
 * agent in the chat.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

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

const INVITE =
  "https://discord.com/oauth2/authorize?client_id=111111111111111111&scope=bot+applications.commands&permissions=274878286912";

function json(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

let configured: boolean;
let joined: boolean;
let syncCalls: number;

beforeEach(() => {
  configured = false;
  joined = false;
  syncCalls = 0;
  (window as Window & { __clawboxPendingSettingsSection?: string }).__clawboxPendingSettingsSection = "discord";
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/discord/status")) {
        return json(configured ? { configured: true, state: "connected", inviteUrl: INVITE } : { configured: false });
      }
      if (url.startsWith("/setup-api/discord/configure")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.sync) {
          syncCalls += 1;
          return json({ success: true, needsInvite: !joined, changed: joined });
        }
        configured = true;
        return json({ success: true, restarted: true, inviteUrl: INVITE, needsInvite: true, members: [] });
      }
      return json({});
    }),
  );
});

describe("Discord connect and go", () => {
  it("asks for the token alone — no Application ID field", async () => {
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(document.getElementById("settings-dc-token")).not.toBeNull());
    expect(document.getElementById("settings-dc-appid")).toBeNull();
  });

  it("offers the box's invite link after the save and finishes once the bot joined", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<SettingsApp ui={ui} />);
      await waitFor(() => expect(document.getElementById("settings-dc-token")).not.toBeNull());
      const input = document.getElementById("settings-dc-token") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "clawbox-test-not-a-real-discord-bot-token-000000" } });
      fireEvent.click(screen.getByText("settings.connect"));

      const card = await screen.findByTestId("discord-invite");
      expect(screen.getByTestId("discord-invite-open").getAttribute("href")).toBe(INVITE);
      expect(card.textContent).toContain("settings.discordInviteWaiting");

      await vi.advanceTimersByTimeAsync(4_100);
      await waitFor(() => expect(syncCalls).toBeGreaterThan(0));
      expect(screen.queryByTestId("discord-invite")).not.toBeNull();

      joined = true;
      await vi.advanceTimersByTimeAsync(4_100);
      await waitFor(() => expect(screen.queryByTestId("discord-invite")).toBeNull());
      expect(await screen.findByText("settings.discordInviteDone")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never puts a link that is not Discord's own OAuth2 address in an href", async () => {
    configured = true;
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/discord/status")) {
        return json({ configured: true, state: "connected", inviteUrl: "javascript:alert(1)" });
      }
      return json({});
    });
    render(<SettingsApp ui={ui} />);
    await screen.findByTestId("discord-status-card");
    expect(screen.queryByTestId("discord-invite-link")).toBeNull();
  });
});
