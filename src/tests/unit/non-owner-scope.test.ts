import { createRequire } from "module";
import { describe, expect, it } from "vitest";
import {
  nonOwnerVerdict,
  NON_OWNER_HOME,
  OPENCLAW_SHARED_KEY,
  OWNER_ONLY_APP_IDS,
  openclawSharedFrom,
  ownerOnlyAppIds,
  requestIntent,
  USER_CHAT_WS_PATH,
  type RequestIntent,
} from "@/lib/non-owner-scope";
import { apps } from "@/lib/desktop-apps";

// A ClawBox user who is not the owner gets the owner's desktop — every app and
// Settings — with three exceptions: the owner's chat (each user has their
// own), secrets in clear, and the owner's account itself.

function verdict(url: string, method = "GET", intent: RequestIntent = "fetch", username = "alice", openclawShared?: boolean) {
  const u = new URL(url, "http://clawbox.local");
  return nonOwnerVerdict({ pathname: u.pathname, method, searchParams: u.searchParams, intent, username, openclawShared });
}

/** The same judge, with the owner's "Share OpenClaw with all users" switch on. */
function sharedVerdict(url: string, method = "GET", intent: RequestIntent = "fetch") {
  return verdict(url, method, intent, "alice", true);
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

  it("is not dodged by spelling: a trailing slash, doubled slashes, escapes or case", () => {
    // Middleware never strips an API path's trailing slash, and the router
    // serves `/setup-api/gateway/` from the same handler.
    for (const url of [
      "/setup-api/gateway/",
      "/setup-api/gateway//",
      "/setup-api//gateway",
      "/setup-api/gatew%61y",
      "/setup-api/Gateway",
      "/setup-api/system/credentials/",
      "/setup-api/system%2Fcredentials",
      "/setup-api/setup/reset/",
      "/API/chat",
      "/api%2Fchat",
      "/app/OpenClaw",
    ]) {
      expect(verdict(url, "GET", "fetch"), url).toBe("deny");
    }
    expect(verdict("/setup-api/%zz")).toBe("deny");
    // …while an ordinary path with a slash at the end still opens.
    expect(verdict("/setup-api/gateway/ws-config")).toBe("allow");
    expect(verdict("/setup-api/users/")).toBe("allow");
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

describe("nonOwnerVerdict — the owner shares OpenClaw with every user", () => {
  it("opens OpenClaw's app page, its Control UI pages and the page that carries the token", () => {
    for (const url of ["/app/openclaw", "/App/OpenClaw", "/chat", "/sessions", "/settings", "/overview"]) {
      for (const intent of ["navigation", "unknown", "fetch"] as const) {
        expect(sharedVerdict(url, "GET", intent), `${url} ${intent}`).toBe("allow");
      }
    }
    expect(sharedVerdict("/setup-api/gateway")).toBe("allow");
    expect(sharedVerdict("/setup-api/gateway/")).toBe("allow");
  });

  it("opens the gateway's HTTP trees and the Control UI's own files — every method the owner's Control UI uses", () => {
    for (const url of ["/api/chat", "/api/sessions", "/assets/index.js", "/__openclaw__/plugin-icon/x.png", "/avatar/main", "/control-ui-config.json", "/something.js"]) {
      expect(sharedVerdict(url), url).toBe("allow");
    }
    expect(sharedVerdict("/api/sessions", "POST")).toBe("allow");
    const owners = `/api/chat/media/outgoing/${encodeURIComponent("agent:main:main")}/1b2c/full`;
    expect(sharedVerdict(owners)).toBe("allow");
  });

  it("keeps the Hermes dashboard and the owner's account the owner's", () => {
    expect(sharedVerdict("/app/hermes", "GET", "navigation")).toBe("redirect-home");
    expect(sharedVerdict("/app/hermes", "GET", "fetch")).toBe("deny");
    for (const [method, url] of [
      ["GET", "/setup-api/system/credentials"],
      ["POST", "/setup-api/system/credentials"],
      ["POST", "/setup-api/system/credentials/verify"],
      ["POST", "/setup-api/setup/reset"],
    ]) {
      expect(sharedVerdict(url, method), `${method} ${url}`).toBe("deny");
    }
  });

  it("changes nothing while the switch is off or absent — exactly today's table", () => {
    for (const shared of [undefined, false]) {
      expect(verdict("/app/openclaw", "GET", "navigation", "alice", shared)).toBe("redirect-home");
      expect(verdict("/chat", "GET", "navigation", "alice", shared)).toBe("redirect-home");
      expect(verdict("/setup-api/gateway", "GET", "fetch", "alice", shared)).toBe("deny");
      expect(verdict("/api/sessions", "GET", "fetch", "alice", shared)).toBe("deny");
      expect(verdict("/something.js", "GET", "fetch", "alice", shared)).toBe("deny");
    }
  });

  it("hides only Hermes from a non-owner's desktop while OpenClaw is shared", () => {
    expect(ownerOnlyAppIds(false)).toEqual(OWNER_ONLY_APP_IDS);
    expect(ownerOnlyAppIds(true)).toEqual(["hermes"]);
  });

  it("shares only on a literal true", () => {
    expect(openclawSharedFrom(true)).toBe(true);
    for (const value of [undefined, null, false, "true", 1, {}]) expect(openclawSharedFrom(value), String(value)).toBe(false);
  });

  it("names the switch and the user-chat socket path exactly as production-server.js reads them", () => {
    const mirror = createRequire(import.meta.url)("../../../scripts/openclaw-sharing.js") as {
      OPENCLAW_SHARED_KEY: string;
      USER_CHAT_WS_PATH: string;
      openclawSharedFrom: (value: unknown) => boolean;
    };
    expect(mirror.OPENCLAW_SHARED_KEY).toBe(OPENCLAW_SHARED_KEY);
    expect(mirror.USER_CHAT_WS_PATH).toBe(USER_CHAT_WS_PATH);
    for (const value of [true, false, "true", 1, null]) {
      expect(mirror.openclawSharedFrom(value), String(value)).toBe(openclawSharedFrom(value));
    }
  });
});
