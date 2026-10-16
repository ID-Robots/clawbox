import { describe, expect, it } from "vitest";
import {
  nonOwnerVerdict,
  NON_OWNER_HOME,
  OWNER_ONLY_APP_IDS,
  requestIntent,
  type RequestIntent,
} from "@/lib/non-owner-scope";
import { apps } from "@/lib/desktop-apps";

// A ClawBox user who is not the owner gets the owner's desktop — every app and
// Settings — with three exceptions: the owner's chat (each user has their
// own), secrets in clear, and the owner's account itself.

function verdict(url: string, method = "GET", intent: RequestIntent = "fetch", username = "alice") {
  const u = new URL(url, "http://clawbox.local");
  return nonOwnerVerdict({ pathname: u.pathname, method, searchParams: u.searchParams, intent, username });
}

describe("nonOwnerVerdict — the owner's desktop for every signed-in user", () => {
  it.each([
    ["GET", "/setup-api/users"],
    ["POST", "/setup-api/users"],
    ["DELETE", "/setup-api/users"],
    ["GET", "/setup-api/preferences?all=1"],
    ["POST", "/setup-api/preferences"],
    ["GET", "/setup-api/files"],
    ["GET", "/setup-api/files/Documents/notes.txt"],
    ["GET", "/setup-api/kv?key=ui:pending-actions"],
    ["POST", "/setup-api/coding-agent/enable"],
    ["GET", "/setup-api/coding-agent/runs"],
    ["POST", "/setup-api/system/power"],
    ["GET", "/setup-api/wifi/status"],
    ["GET", "/setup-api/ai-models/status"],
    ["POST", "/setup-api/apps/install"],
    ["GET", "/setup-api/apps/store"],
    ["GET", "/setup-api/vnc"],
    ["GET", "/setup-api/browser"],
    ["GET", "/setup-api/clawkeep"],
    ["POST", "/setup-api/clawkeep/memory/index"],
    ["GET", "/setup-api/prime-radiant/status"],
    ["GET", "/setup-api/gateway/ws-config"],
    ["GET", "/setup-api/chat/tabs"],
    ["POST", "/setup-api/chat/tabs"],
    ["GET", "/setup-api/chat/history?sessionKey=desktop-user-alice"],
    ["POST", "/setup-api/hermes/chat"],
    ["POST", "/setup-api/tts/speak"],
    ["POST", "/setup-api/chat/transcribe"],
    ["POST", "/setup-api/install/run-step"],
    ["GET", "/setup-api/update/status"],
  ])("allows %s %s", (method, url) => {
    expect(verdict(url, method)).toBe("allow");
  });

  it("opens every ClawBox page, the standalone apps and installed web apps", () => {
    for (const url of ["/", "/updating", "/setup", "/app/terminal", "/app/settings", "/app/files", "/app/clawbox", "/app/coding", "/app/store", "/app/vnc", "/app/browser", "/app/prime-radiant", "/app/memory-shard", "/apps/notes/", "/?notice=owner-only"]) {
      expect(verdict(url, "GET", "navigation"), url).toBe("allow");
    }
  });

  it("lets the desktop's own media and public files through", () => {
    for (const url of ["/clawbox-wallpaper.jpeg", "/pets/crab/sheet.png", "/fonts/geist.woff2", "/manifest.json", "/sw.js"]) {
      expect(verdict(url), url).toBe("allow");
      expect(verdict(url, "GET", "unknown"), url).toBe("allow");
    }
  });
});

describe("nonOwnerVerdict — what stays the owner's", () => {
  it.each([
    ["GET", "/setup-api/system/credentials"],
    ["POST", "/setup-api/system/credentials"],
    ["POST", "/setup-api/system/credentials/verify"],
    ["POST", "/setup-api/setup/reset"],
  ])("the owner's account: refuses %s %s", (method, url) => {
    expect(verdict(url, method)).toBe("deny");
  });

  it("the gateway token: refuses the Control UI page that carries it", () => {
    expect(verdict("/setup-api/gateway")).toBe("deny");
    expect(verdict("/setup-api/gateway", "GET", "navigation")).toBe("deny");
  });

  it("the harnesses' consoles (every conversation on the box): sends their pages to the desktop", () => {
    for (const url of ["/app/openclaw", "/app/hermes", "/chat", "/sessions", "/settings", "/overview"]) {
      expect(verdict(url, "GET", "navigation"), url).toBe("redirect-home");
      expect(verdict(url, "GET", "unknown"), url).toBe("redirect-home");
      expect(verdict(url, "GET", "fetch"), url).toBe("deny");
      expect(verdict(url, "POST", "navigation"), url).toBe("deny");
    }
  });

  it("the gateway's HTTP trees, however the path ends", () => {
    for (const url of ["/api/chat", "/api/sessions", "/assets/index.js", "/assets/logo.png", "/__openclaw__/plugin-icon/x.png", "/avatar/main", "/control-ui-config.json", "/something.js"]) {
      expect(verdict(url), url).toBe("deny");
    }
    for (const intent of ["navigation", "unknown", "fetch"] as const) {
      expect(verdict("/api/chat", "GET", intent), intent).toBe("deny");
    }
  });

  it("the owner's chat media — while a user's own chat reaches the pictures sent to THEM", () => {
    const own = `/api/chat/media/outgoing/${encodeURIComponent("agent:main:clawbox-user-alice")}/1b2c/full`;
    const tab = `/api/chat/media/outgoing/${encodeURIComponent("agent:main:clawbox-utab-0123456789ab-alice")}/1b2c/full`;
    const owners = `/api/chat/media/outgoing/${encodeURIComponent("agent:main:main")}/1b2c/full`;
    const bobs = `/api/chat/media/outgoing/${encodeURIComponent("agent:main:clawbox-user-bob")}/1b2c/full`;
    expect(verdict(own)).toBe("allow");
    expect(verdict(tab)).toBe("allow");
    expect(verdict(owners)).toBe("deny");
    expect(verdict(bobs)).toBe("deny");
    expect(verdict(own, "POST")).toBe("deny");
    expect(verdict(own, "GET", "fetch", "bob")).toBe("deny");
  });

  it("lands a redirected user on the desktop with the owner-only notice", () => {
    expect(NON_OWNER_HOME).toBe("/?notice=owner-only");
  });
});

describe("the desktop apps that stay the owner's", () => {
  it("are the harnesses' own consoles alone — every other built-in app is every signed-in user's", () => {
    expect(OWNER_ONLY_APP_IDS).toEqual(["openclaw", "hermes"]);
    const ids = apps.map((a) => a.id);
    for (const id of OWNER_ONLY_APP_IDS) expect(ids, id).toContain(id);
    // Their standalone pages are the owner's too.
    for (const id of OWNER_ONLY_APP_IDS) expect(verdict(`/app/${id}`, "GET", "navigation"), id).toBe("redirect-home");
    for (const id of ids.filter((x) => !OWNER_ONLY_APP_IDS.includes(x))) {
      expect(verdict(`/app/${id}`, "GET", "navigation"), id).toBe("allow");
    }
  });
});

describe("requestIntent", () => {
  const intent = (h: Record<string, string>) => requestIntent(new Headers(h));

  it("trusts Fetch Metadata when the browser sends it", () => {
    for (const dest of ["document", "iframe", "frame", "embed", "object"]) {
      expect(intent({ "sec-fetch-dest": dest, accept: "*/*" }), dest).toBe("navigation");
    }
    for (const dest of ["empty", "image", "script", "style", "font"]) {
      expect(intent({ "sec-fetch-dest": dest, accept: "text/html" }), dest).toBe("fetch");
    }
  });

  it("reads a browser navigation over plain HTTP (no Sec-Fetch-*) from its Accept", () => {
    expect(intent({ accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" })).toBe("navigation");
  });

  it("reads the Next router's RSC requests and JSON callers as code", () => {
    expect(intent({ rsc: "1", accept: "*/*" })).toBe("fetch");
    expect(intent({ "next-router-prefetch": "1" })).toBe("fetch");
    expect(intent({ accept: "application/json" })).toBe("fetch");
  });

  it("calls a request that says nothing unknown", () => {
    expect(intent({})).toBe("unknown");
    expect(intent({ accept: "*/*" })).toBe("unknown");
  });
});
