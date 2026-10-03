/**
 * When the Projects view shows "Keep a safe copy of your projects on GitHub"
 * (TASK-1358): the owner only, a pinned folder to back up, a box that can
 * back up, GitHub not connected or a folder without a copy — and "Not now"
 * keeps it away for 30 days.
 */
import { describe, expect, it } from "vitest";
import {
  BACKUP_SUGGESTION_SNOOZE_MS,
  shouldShowBackupSuggestion,
  type FolderBackupSummary,
  type GitHubConnection,
} from "@/lib/project-backup-shared";

const NOW = Date.UTC(2026, 9, 1, 20, 40);
const DAY = 24 * 60 * 60 * 1000;
const NOT_CONNECTED: GitHubConnection = { installed: true, connected: false, login: null };
const CONNECTED: GitHubConnection = { installed: true, connected: true, login: "demo-owner" };
const none: FolderBackupSummary = { path: "projects/site", state: "none", lastBackupAt: null, auto: false };
const backedUp: FolderBackupSummary = { path: "projects/app", state: "backed_up", lastBackupAt: NOW - DAY, auto: true };
const ownRemote: FolderBackupSummary = { path: "work/lib", state: "existing_git", lastBackupAt: null, auto: false };

const show = (over: Partial<Parameters<typeof shouldShowBackupSuggestion>[0]> = {}) =>
  shouldShowBackupSuggestion({ isOwner: true, github: NOT_CONNECTED, folders: [none], dismissedAt: null, now: NOW, ...over });

describe("the GitHub backup suggestion card", () => {
  it("shows to the owner when GitHub is not connected and a project is pinned", () => {
    expect(show()).toBe(true);
  });

  it("shows when GitHub is connected but a pinned project has no copy yet", () => {
    expect(show({ github: CONNECTED, folders: [backedUp, none] })).toBe(true);
  });

  it("stays away once every pinned project has a copy (ClawBox's or its own remote)", () => {
    expect(show({ github: CONNECTED, folders: [backedUp, ownRemote] })).toBe(false);
  });

  it("never shows to anyone but the owner — a non-owner, or a session not known yet", () => {
    expect(show({ isOwner: false })).toBe(false);
    expect(show({ isOwner: null })).toBe(false);
    expect(show({ isOwner: undefined })).toBe(false);
  });

  it("needs a pinned folder to offer anything for", () => {
    expect(show({ folders: [] })).toBe(false);
  });

  it("does not offer what the box cannot do: no GitHub helper, a probe that did not answer, no answer yet", () => {
    expect(show({ github: { installed: false, connected: false, login: null } })).toBe(false);
    expect(show({ github: { ...NOT_CONNECTED, reason: "unreachable" } })).toBe(false);
    expect(show({ github: null })).toBe(false);
  });

  it("'Not now' hides it for 30 days, then it may come back", () => {
    expect(BACKUP_SUGGESTION_SNOOZE_MS).toBe(30 * DAY);
    expect(show({ dismissedAt: NOW - DAY })).toBe(false);
    expect(show({ dismissedAt: NOW - 29 * DAY })).toBe(false);
    expect(show({ dismissedAt: NOW - 30 * DAY })).toBe(true);
    expect(show({ dismissedAt: NOW - 45 * DAY })).toBe(true);
  });
});
