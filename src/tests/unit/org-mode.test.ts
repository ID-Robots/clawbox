import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  desktopNoticePolicy,
  isOrgMember,
  ORG_MODE_KEY,
  ORG_USER_APP_IDS,
  ORG_USER_SETTINGS_SECTIONS,
  orgHiddenAppIds,
  orgMemberVerdict,
  orgModeFrom,
} from "@/lib/org-mode";
import { nonOwnerVerdict, OWNER_ONLY_APP_IDS, type NonOwnerRequest } from "@/lib/non-owner-scope";
import { apps } from "@/lib/desktop-apps";

/**
 * Organisation mode (src/lib/org-mode.ts): the owner's switch that narrows
 * every other ClawBox user to Chat, Files and their own Settings, and the
 * update rule that holds on every box. The table the middleware applies, per
 * route group.
 */

function verdict(pathname: string, init: Partial<NonOwnerRequest> = {}) {
  const [p, q = ""] = pathname.split("?");
  return nonOwnerVerdict({
    pathname: p,
    method: "GET",
    searchParams: new URLSearchParams(q),
    intent: "fetch",
    username: "alice",
    ...init,
  });
}

const org = { orgMode: true } as const;

describe("the switch", () => {
  it("is on only for a literal true", () => {
    expect(ORG_MODE_KEY).toBe("org_mode");
    expect(orgModeFrom(true)).toBe(true);
    for (const value of [undefined, null, false, "true", 1, {}, []]) expect(orgModeFrom(value), String(value)).toBe(false);
  });

  it("is pinned to the CommonJS copy production-server.js reads", () => {
    const require = createRequire(import.meta.url);
    const mirror = require(path.join(process.cwd(), "scripts", "org-mode.js")) as {
      ORG_MODE_KEY: string;
      orgModeFrom: (v: unknown) => boolean;
      orgModeRefusesUpgrade: (gate: { userChat?: boolean }, identity: { isOwner: boolean } | null, orgMode: boolean) => boolean;
    };
    expect(mirror.ORG_MODE_KEY).toBe(ORG_MODE_KEY);
    for (const value of [true, false, "true", 1, null, undefined]) expect(mirror.orgModeFrom(value)).toBe(orgModeFrom(value));
    const user = { isOwner: false };
    const owner = { isOwner: true };
    // A member of staff keeps their own chat socket and nothing else.
    expect(mirror.orgModeRefusesUpgrade({ userChat: true }, user, true)).toBe(false);
    expect(mirror.orgModeRefusesUpgrade({}, user, true)).toBe(true);
    // The owner, and every user on a home box, are never refused by it.
    expect(mirror.orgModeRefusesUpgrade({}, owner, true)).toBe(false);
    expect(mirror.orgModeRefusesUpgrade({}, user, false)).toBe(false);
    expect(mirror.orgModeRefusesUpgrade({}, null, true)).toBe(false);
  });
});

describe("the desktop's apps and sections", () => {
  it("leaves a member of staff Chat, Files and Settings — every other built-in app is hidden", () => {
    const ids = apps.map((a) => a.id);
    for (const id of ORG_USER_APP_IDS) expect(ids, id).toContain(id);
    const hidden = orgHiddenAppIds(ids);
    expect(ids.filter((id) => !hidden.includes(id)).sort()).toEqual(["clawbox", "files", "settings"]);
    for (const id of ["terminal", "coding", "store", "clawkeep", "memory-shard", "prime-radiant", "browser", "system_update", "openclaw", "hermes", "vnc"]) {
      expect(hidden, id).toContain(id);
    }
  });

  it("leaves them Appearance and Account in Settings", () => {
    expect([...ORG_USER_SETTINGS_SECTIONS].sort()).toEqual(["account", "appearance"]);
  });

  it("names a member of staff only on an organisation box, never the owner", () => {
    expect(isOrgMember({ isOwner: false, orgMode: true })).toBe(true);
    expect(isOrgMember({ isOwner: true, orgMode: true })).toBe(false);
    expect(isOrgMember({ isOwner: false, orgMode: false })).toBe(false);
    expect(isOrgMember(null)).toBe(false);
    expect(isOrgMember(undefined)).toBe(false);
  });
});

describe("the notice cards", () => {
  it("shows the update and What's new to the owner alone, on every box", () => {
    for (const orgMode of [false, true]) {
      expect(desktopNoticePolicy({ isOwner: true, orgMode }).update).toBe(true);
      expect(desktopNoticePolicy({ isOwner: true, orgMode }).whatsNew).toBe(true);
      expect(desktopNoticePolicy({ isOwner: false, orgMode }).update).toBe(false);
      expect(desktopNoticePolicy({ isOwner: false, orgMode }).whatsNew).toBe(false);
    }
  });

  it("hides the ClawBox AI offer from everybody on an organisation box, and from nobody on a home box", () => {
    expect(desktopNoticePolicy({ isOwner: true, orgMode: true }).clawAiOffer).toBe(false);
    expect(desktopNoticePolicy({ isOwner: false, orgMode: true }).clawAiOffer).toBe(false);
    expect(desktopNoticePolicy({ isOwner: true, orgMode: false }).clawAiOffer).toBe(true);
    expect(desktopNoticePolicy({ isOwner: false, orgMode: false }).clawAiOffer).toBe(true);
  });

  it("draws as the owner's until /users/me answers, as a single-user box always has", () => {
    expect(desktopNoticePolicy(null)).toEqual({ update: true, whatsNew: true, clawAiOffer: true });
    expect(desktopNoticePolicy(undefined)).toEqual({ update: true, whatsNew: true, clawAiOffer: true });
  });
});

describe("updates are the owner's on every box", () => {
  const UPDATE_ROUTES: [string, string][] = [
    ["POST", "/setup-api/update/run"],
    ["POST", "/setup-api/update/request"],
    ["POST", "/setup-api/update/openclaw"],
    ["POST", "/setup-api/update/dismiss"],
    ["GET", "/setup-api/update/dismissal"],
    ["POST", "/setup-api/update/dismissal"],
    ["GET", "/setup-api/update/versions"],
    ["GET", "/setup-api/update/weekly-check"],
    ["POST", "/setup-api/update/weekly-check"],
    ["GET", "/setup-api/update/whats-new"],
    ["POST", "/setup-api/update/chat-command"],
    ["GET", "/setup-api/system/update-branch"],
    ["POST", "/setup-api/system/update-branch"],
  ];

  it.each([false, true])("refuses a user every update route (org_mode %s)", (orgMode) => {
    for (const [method, p] of UPDATE_ROUTES) expect(verdict(p, { method, orgMode }), `${method} ${p}`).toBe("deny");
  });

  it("is not dodged by spelling", () => {
    for (const p of ["/setup-api/Update/run", "/setup-api/update/run/", "/setup-api//update/run", "/setup-api/%75pdate/run"]) {
      expect(verdict(p, { method: "POST" }), p).toBe("deny");
    }
  });

  it.each([false, true])("leaves them the progress the lock screen polls (org_mode %s)", (orgMode) => {
    expect(verdict("/setup-api/update/status", { orgMode })).toBe("allow");
    expect(verdict("/setup-api/update/status", { method: "POST", orgMode })).toBe("deny");
    expect(verdict("/updating", { intent: "navigation", orgMode })).toBe("allow");
  });

  it("sends a user's System Update page home", () => {
    expect(OWNER_ONLY_APP_IDS).toContain("system_update");
    expect(verdict("/app/system_update", { intent: "navigation" })).toBe("redirect-home");
  });

  it("leaves a home box's user everything else they had", () => {
    for (const [method, p] of [
      ["GET", "/setup-api/terminal/shells"],
      ["POST", "/setup-api/coding-agent/enable"],
      ["GET", "/setup-api/clawkeep/snapshots"],
      ["GET", "/setup-api/prime-radiant/pages"],
      ["GET", "/setup-api/browser/status"],
      ["GET", "/setup-api/kv"],
      ["GET", "/setup-api/wifi/status"],
    ] as const) {
      expect(verdict(p, { method }), `${method} ${p}`).toBe("allow");
    }
    expect(verdict("/app/terminal", { intent: "navigation" })).toBe("allow");
  });
});

describe("an organisation box narrows a user to Chat, Files and their own Settings", () => {
  const ALLOWED: [string, string][] = [
    // The desktop itself.
    ["GET", "/setup-api/users/me"],
    ["GET", "/setup-api/setup/status"],
    ["GET", "/setup-api/preferences?all=1"],
    ["POST", "/setup-api/preferences"],
    ["GET", "/setup-api/desktop/state"],
    ["PUT", "/setup-api/desktop/state"],
    ["GET", "/setup-api/system/timezone"],
    ["GET", "/setup-api/network/internet"],
    ["GET", "/setup-api/pets"],
    ["GET", "/setup-api/mascot-lines"],
    ["GET", "/setup-api/harness/active"],
    // Chat, on both runtimes.
    ["GET", "/setup-api/gateway/ws-config"],
    ["GET", "/setup-api/chat/tabs"],
    ["POST", "/setup-api/chat/tabs"],
    ["GET", "/setup-api/chat/history"],
    ["POST", "/setup-api/chat/attachments"],
    ["POST", "/setup-api/chat/transcribe"],
    ["GET", "/setup-api/chat/media"],
    ["GET", "/setup-api/chat/model"],
    ["POST", "/setup-api/hermes/chat"],
    ["POST", "/setup-api/hermes/chat/clarify"],
    ["GET", "/setup-api/hermes/models"],
    ["POST", "/setup-api/tts/speak"],
    ["GET", "/setup-api/ai-models/status"],
    // Files.
    ["GET", "/setup-api/files"],
    ["PUT", "/setup-api/files"],
    ["DELETE", "/setup-api/files/Documents/a.txt"],
    // Settings → Account.
    ["POST", "/setup-api/users/me/password"],
  ];

  const REFUSED: [string, string, string][] = [
    // The route groups behind the hidden apps and sections.
    ["terminal", "GET", "/setup-api/terminal/shells"],
    ["coding agent", "POST", "/setup-api/coding-agent/enable"],
    ["coding agent", "GET", "/setup-api/coding-agent/runs"],
    ["code projects", "GET", "/setup-api/code"],
    ["store", "GET", "/setup-api/apps/store"],
    ["store", "POST", "/setup-api/apps/install"],
    ["store", "GET", "/setup-api/webapps"],
    ["store", "GET", "/setup-api/plugins"],
    ["store", "GET", "/setup-api/hermes/skills/browse"],
    ["ClawKeep", "GET", "/setup-api/clawkeep/snapshots"],
    ["ClawKeep", "POST", "/setup-api/clawkeep/backup"],
    ["Prime Radiant", "GET", "/setup-api/prime-radiant/pages"],
    ["Memory Shard", "GET", "/setup-api/clawkeep/memory/status"],
    ["Memory Shard", "GET", "/setup-api/embed/status"],
    ["agent browser", "GET", "/setup-api/browser/status"],
    ["agent browser", "GET", "/setup-api/vnc/status"],
    ["provider/model changes", "POST", "/setup-api/providers/default"],
    ["provider/model changes", "GET", "/setup-api/providers/default"],
    ["provider/model changes", "POST", "/setup-api/ai-models/configure"],
    ["provider/model changes", "POST", "/setup-api/chat/model"],
    ["provider/model changes", "POST", "/setup-api/hermes/models"],
    ["provider/model changes", "POST", "/setup-api/anthropic/accounts"],
    ["provider/model changes", "POST", "/setup-api/local-ai"],
    ["provider/model changes", "GET", "/setup-api/ai-cloud-defaults"],
    // The owner's Settings sections.
    ["system", "POST", "/setup-api/system/power"],
    ["system", "GET", "/setup-api/system/info"],
    ["system", "POST", "/setup-api/system/credentials"],
    ["network", "GET", "/setup-api/wifi/status"],
    ["network", "GET", "/setup-api/tunnel/status"],
    ["users", "GET", "/setup-api/users"],
    ["users", "POST", "/setup-api/users"],
    ["channels", "GET", "/setup-api/telegram/status"],
    ["channels", "GET", "/setup-api/email/pending"],
    ["the owner's switches", "POST", "/setup-api/settings/org-mode"],
    ["the owner's switches", "POST", "/setup-api/settings/openclaw-sharing"],
    // The box's own stores and jobs.
    ["box state", "GET", "/setup-api/kv"],
    ["box state", "GET", "/setup-api/background-jobs"],
    ["box state", "GET", "/setup-api/whats-new"],
    ["box state", "GET", "/setup-api/screenshots"],
    // Nothing is shared with them: the Control UI's token page and trees.
    ["gateway", "GET", "/setup-api/gateway"],
    ["gateway", "GET", "/api/sessions"],
  ];

  it("allows the routes Chat, Files and their own Settings use", () => {
    for (const [method, p] of ALLOWED) expect(verdict(p, { method, ...org }), `${method} ${p}`).toBe("allow");
  });

  it("refuses every route group behind the hidden apps and sections", () => {
    for (const [group, method, p] of REFUSED) expect(verdict(p, { method, ...org }), `${group}: ${method} ${p}`).toBe("deny");
  });

  it("refuses them even where a home box's owner shared OpenClaw", () => {
    for (const p of ["/setup-api/gateway", "/api/sessions", "/assets/index.js"]) {
      expect(verdict(p, { ...org, openclawShared: true }), p).toBe("deny");
    }
    expect(verdict("/app/openclaw", { ...org, openclawShared: true, intent: "navigation" })).toBe("redirect-home");
  });

  it("still serves them their own chat's pictures, and nobody else's", () => {
    expect(verdict("/api/chat/media/outgoing/agent%3Amain%3Aclawbox-user-alice/pic.png", org)).toBe("allow");
    expect(verdict("/api/chat/media/outgoing/agent%3Amain%3Amain/pic.png", org)).toBe("deny");
  });

  it("opens the desktop and the three apps' windows, and sends every other page home", () => {
    for (const p of ["/", "/app/clawbox", "/app/files", "/app/settings"]) {
      expect(verdict(p, { ...org, intent: "navigation" }), p).toBe("allow");
    }
    for (const p of ["/app/terminal", "/app/coding", "/app/store", "/app/clawkeep", "/app/prime-radiant", "/app/memory-shard", "/app/browser", "/app/vnc", "/setup", "/portal", "/settings-page-of-the-gateway"]) {
      expect(verdict(p, { ...org, intent: "navigation" }), p).toBe("redirect-home");
      expect(verdict(p, { ...org, intent: "fetch" }), p).toBe("deny");
    }
  });

  it("serves the desktop's media files", () => {
    expect(verdict("/clawbox-crab.png", org)).toBe("allow");
    expect(verdict("/manifest.json", org)).toBe("allow");
    expect(verdict("/clawbox-crab.png", { ...org, method: "POST" })).toBe("deny");
  });

  it("is not reached by spelling a hidden route under an allowed one", () => {
    for (const p of [
      "/setup-api/files%2f..%2fterminal/shells",
      "/setup-api/chat/%2e%2e/terminal/shells",
      "/setup-api/files/./x",
      "/setup-api/chat%2f..%2f..%2fsetup-api%2fusers",
    ]) {
      expect(verdict(p, { ...org, method: "POST" }), p).toBe("deny");
    }
    expect(verdict("/setup-api/%zz", org)).toBe("deny");
  });

  it("holds the owner's account and the box's AI writes as on every box", () => {
    expect(verdict("/setup-api/system/credentials/verify", { ...org, method: "POST" })).toBe("deny");
    expect(verdict("/setup-api/chat/model", { ...org, method: "POST" })).toBe("deny");
    expect(verdict("/setup-api/hermes/models", { ...org, method: "POST" })).toBe("deny");
  });
});

describe("orgMemberVerdict", () => {
  it("answers `/setup-api` with allow or deny only, never a redirect", () => {
    expect(orgMemberVerdict("/setup-api/terminal/shells", "GET")).toBe("deny");
    expect(orgMemberVerdict("/setup-api/files", "GET")).toBe("allow");
    expect(orgMemberVerdict("/setup-api/users/me", "POST")).toBe("deny");
  });
});
