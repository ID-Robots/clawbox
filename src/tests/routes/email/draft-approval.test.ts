// /setup-api/email/draft-approval/{card,decide,status} and the settings route —
// the only way an e-mail draft the assistant prepared is ever sent.
//
// Run against the REAL session verifier and the REAL config store on a temp
// CLAWBOX_ROOT, with the mail send backend replaced by an in-memory mailbox
// behind a stubbed `fetch`. What has to hold:
//
//   - without a person's approval nothing reaches the backend's send endpoint:
//     no cookie, the MCP bearer the agent holds, a cross-site page, a forged or
//     tampered token, a token used once already, an expired one, a draft
//     changed after the card was shown, another user's card;
//   - with one, exactly one send, for exactly the draft and content approved,
//     from the mailbox of the person who approved it.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "../../helpers/env";

const SESSION_SECRET = "s".repeat(64);
const MCP_TOKEN = "m".repeat(64);
const OWNER = "clawbox";
const STAFF = "alice";
const STAFF_SV = "a1b2c3d4e5f60718";
const ENDPOINT = "http://127.0.0.1:8790";
const BACKEND_AUTH = "Bearer backend-placeholder-credential";
const DRAFT_ID = "AAMkADraft-0001=";

interface Draft {
  id: string;
  to: string[];
  cc: string[];
  replyTo?: string[];
  subject: string;
  body: string;
  bodyType?: string;
}

let root: string;
let restoreEnv: () => void;
let auth: typeof import("@/lib/auth");
let card: typeof import("@/app/setup-api/email/draft-approval/card/route");
let decide: typeof import("@/app/setup-api/email/draft-approval/decide/route");
let status: typeof import("@/app/setup-api/email/draft-approval/status/route");
let settings: typeof import("@/app/setup-api/email/draft-approval/route");

/** The fake mailbox: user → draft id → draft. */
let mailbox: Record<string, Record<string, Draft>>;
let sends: { user: string; draftId: string; contentHash: string; auth: string | null }[];
let backendCalls: { method: string; url: string; auth: string | null }[];
let sendAnswer: number;
/** Holds ONE read of a draft after its answer was taken, until released. */
let gate: { id: string; hit: boolean; wait: Promise<void> } | null;

function writeConfig(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({
      clawbox_users: [{ username: STAFF, sv: STAFF_SV, createdAt: "" }],
      mail_draft_approval_enabled: true,
      mail_draft_approval_endpoint: ENDPOINT,
      mail_draft_approval_auth_value: BACKEND_AUTH,
      ...extra,
    }),
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf8"));
}

function ownerCookie(): string {
  return `clawbox_session=${auth.createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

function staffCookie(): string {
  return `clawbox_session=${auth.createSessionCookie(3600, SESSION_SECRET, 0, { u: STAFF, sv: STAFF_SV })}`;
}

function req(
  route: string,
  init: { cookie?: string; bearer?: string; body?: unknown; method?: string; origin?: string; site?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "clawbox.local" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.origin) headers.origin = init.origin;
  if (init.site) headers["sec-fetch-site"] = init.site;
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  return new Request(`http://clawbox.local${route}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const CARD = "/setup-api/email/draft-approval/card";
const DECIDE = "/setup-api/email/draft-approval/decide";

async function mint(cookie: string, draftId = DRAFT_ID, extra: Record<string, unknown> = {}) {
  const res = await card.POST(req(CARD, { cookie, origin: "http://clawbox.local", body: { draftId, ...extra } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function answer(cookie: string | undefined, token: unknown, action: string, more: { bearer?: string; origin?: string } = {}) {
  const res = await decide.POST(
    req(DECIDE, { cookie, bearer: more.bearer, origin: more.origin ?? "http://clawbox.local", body: { token, action } }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function fakeBackend(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init?.headers);
  const authHeader = headers.get("authorization");
  const method = init?.method ?? "GET";
  backendCalls.push({ method, url: url.href, auth: authHeader });
  expect(url.origin).toBe(ENDPOINT);
  expect(init?.redirect).toBe("manual");
  if (authHeader !== BACKEND_AUTH) return Promise.resolve(new Response("{}", { status: 401 }));
  const match = /^\/drafts\/([^/]+)(\/send)?$/.exec(url.pathname);
  if (!match) return Promise.resolve(new Response("{}", { status: 404 }));
  const id = decodeURIComponent(match[1]);
  if (method === "GET") {
    const user = url.searchParams.get("user") ?? "";
    const draft = mailbox[user]?.[id];
    const response = draft ? Response.json(structuredClone(draft)) : new Response("{}", { status: 404 });
    if (gate && gate.id === id && !gate.hit) {
      gate.hit = true;
      return gate.wait.then(() => response);
    }
    return Promise.resolve(response);
  }
  const body = JSON.parse(String(init?.body)) as { user: string; draftId: string; contentHash: string };
  sends.push({ ...body, auth: authHeader });
  if (sendAnswer === 200 && mailbox[body.user]) delete mailbox[body.user][id];
  return Promise.resolve(new Response("{}", { status: sendAnswer }));
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "CLAWBOX_USER", "CLAWBOX_MCP_TOKEN", "CLAWBOX_MAIL_DRAFT_TOKEN_TTL_S");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-draft-approval-"));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.CLAWBOX_USER = OWNER;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  delete process.env.CLAWBOX_MAIL_DRAFT_TOKEN_TTL_S;
  writeConfig();
  mailbox = {
    [OWNER]: {
      [DRAFT_ID]: { id: DRAFT_ID, to: ["Ivan Ivanov <ivan@example.com>"], cc: ["ops@example.com"], subject: "Offer for Acme", body: "Hello Ivan,\nthe offer is attached.\n" },
    },
    [STAFF]: {
      "staff-draft-1": { id: "staff-draft-1", to: ["buyer@example.org"], cc: [], subject: "Globex order", body: "Dear buyer," },
    },
  };
  sends = [];
  backendCalls = [];
  sendAnswer = 200;
  gate = null;
  vi.stubGlobal("fetch", vi.fn(fakeBackend));
  vi.resetModules();
  auth = await import("@/lib/auth");
  card = await import("@/app/setup-api/email/draft-approval/card/route");
  decide = await import("@/app/setup-api/email/draft-approval/decide/route");
  status = await import("@/app/setup-api/email/draft-approval/status/route");
  settings = await import("@/app/setup-api/email/draft-approval/route");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the card", () => {
  it("shows the draft as the mailbox holds it, with a one-time approval", async () => {
    const { status: code, json } = await mint(ownerCookie());
    expect(code).toBe(200);
    expect(json.state).toBe("open");
    expect(typeof json.token).toBe("string");
    expect(json.draft).toMatchObject({
      id: DRAFT_ID,
      to: ["Ivan Ivanov <ivan@example.com>"],
      cc: ["ops@example.com"],
      bcc: [],
      subject: "Offer for Acme",
      body: "Hello Ivan,\nthe offer is attached.",
    });
    // Read from the backend, for the person asking, with the configured header.
    expect(backendCalls).toEqual([
      { method: "GET", url: `${ENDPOINT}/drafts/${encodeURIComponent(DRAFT_ID)}?user=${OWNER}`, auth: BACKEND_AUTH },
    ]);
    expect(sends).toEqual([]);
  });

  it("refuses everyone but a signed-in person on this box's own pages", async () => {
    for (const [name, request] of [
      ["no credential", req(CARD, { body: { draftId: DRAFT_ID } })],
      ["the MCP bearer", req(CARD, { bearer: MCP_TOKEN, body: { draftId: DRAFT_ID } })],
      ["a forged cookie", req(CARD, { cookie: "clawbox_session=eyJleHAiOjk5OTk5OTk5OTk5fQ.deadbeef", body: { draftId: DRAFT_ID } })],
    ] as const) {
      const res = await card.POST(request);
      expect(res.status, name).toBe(403);
      expect((await res.json()).kind, name).toBe("owner_only");
    }
    const crossSite = await card.POST(req(CARD, { cookie: ownerCookie(), origin: "https://evil.example", body: { draftId: DRAFT_ID } }));
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json()).kind).toBe("cross_origin");
    expect(backendCalls).toEqual([]);
  });

  it("is off by default: no backend, no card", async () => {
    fs.writeFileSync(path.join(root, "data", "config.json"), "{}");
    const { status: code, json } = await mint(ownerCookie());
    expect(code).toBe(409);
    expect(json.kind).toBe("disabled");
    expect(backendCalls).toEqual([]);
  });

  it("says so when the draft is no longer in the mailbox", async () => {
    const { status: code, json } = await mint(ownerCookie(), "no-such-draft");
    expect(code).toBe(404);
    expect(json.kind).toBe("gone");
  });

  it("refuses an id that is not one before asking the backend", async () => {
    const { status: code, json } = await mint(ownerCookie(), "../../etc/passwd?x=1");
    expect(code).toBe(400);
    expect(json.kind).toBe("invalid_draft");
    expect(backendCalls).toEqual([]);
  });

  it("hands the same approval back to a second look, not a new one each time", async () => {
    const first = await mint(ownerCookie());
    const second = await mint(ownerCookie());
    // Both looks must have SUCCEEDED with a token: two refusals would make the
    // reuse check below compare undefined with undefined and pass on nothing.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(typeof first.json.token).toBe("string");
    expect(String(first.json.token).length).toBeGreaterThan(0);
    expect(second.json.token).toBe(first.json.token);
  });
});

describe("Send", () => {
  it("sends exactly the approved draft, once, from the approver's mailbox", async () => {
    // The answer the card was built from, hashed the way the docs describe: the
    // Send must forward THAT hash, not merely something hash-shaped.
    const approved = structuredClone(mailbox[OWNER][DRAFT_ID]);
    const { draftContentHash } = await import("@/lib/mail-draft-backend");
    const { json } = await mint(ownerCookie());
    const sent = await answer(ownerCookie(), json.token, "send");
    expect(sent.status).toBe(200);
    expect(sent.json.state).toBe("sent");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ user: OWNER, draftId: DRAFT_ID, auth: BACKEND_AUTH });
    expect(sends[0].contentHash).toBe(draftContentHash(approved));
    // Re-read right before the send, not trusted from the card.
    expect(backendCalls.map((c) => c.method)).toEqual(["GET", "GET", "POST"]);
    // A later look at the same draft says it went, and offers nothing to press.
    const again = await mint(ownerCookie());
    expect(again.json).toMatchObject({ state: "sent" });
    expect(again.json.token).toBeUndefined();
  });

  it("refuses with no approval at all", async () => {
    const res = await answer(ownerCookie(), undefined, "send");
    expect(res.status).toBe(403);
    expect(res.json.kind).toBe("no_approval");
    expect(sends).toEqual([]);
  });

  it("refuses the agent's credentials even with a real approval in hand", async () => {
    const { json } = await mint(ownerCookie());
    // The MCP bearer, which middleware admits on every other /setup-api route.
    const bearer = await answer(undefined, json.token, "send", { bearer: MCP_TOKEN });
    expect(bearer.status).toBe(403);
    expect(bearer.json.kind).toBe("owner_only");
    // The person's cookie riding a request from another site.
    const crossSite = await answer(ownerCookie(), json.token, "send", { origin: "http://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(crossSite.json.kind).toBe("cross_origin");
    const sameSiteNoOrigin = await decide.POST(
      new Request(`http://clawbox.local${DECIDE}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "clawbox.local", cookie: ownerCookie(), "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ token: json.token, action: "send" }),
      }),
    );
    expect(sameSiteNoOrigin.status).toBe(403);
    expect(sends).toEqual([]);
    // And the approval is still good for the person.
    expect((await answer(ownerCookie(), json.token, "send")).status).toBe(200);
  });

  it("refuses a forged token", async () => {
    const { json } = await mint(ownerCookie());
    const token = String(json.token);
    const [prefix, payload, sig] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const otherDraft = Buffer.from(JSON.stringify({ ...claims, d: "another-draft" })).toString("base64url");
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    for (const [name, forged] of [
      ["made up", "cbd1.eyJ2IjoxfQ.c2lnbmF0dXJl"],
      ["not a token", "hello"],
      ["payload swapped, signature kept", `${prefix}.${otherDraft}.${sig}`],
      ["signature altered", `${prefix}.${payload}.${flipped}`],
      ["wrong prefix", `cbd0.${payload}.${sig}`],
      ["a session cookie", auth.createSessionCookie(3600, SESSION_SECRET, 0)],
    ] as const) {
      const res = await answer(ownerCookie(), forged, "send");
      expect(res.status, name).toBe(403);
      expect(res.json.kind, name).toBe("forged");
    }
    expect(sends).toEqual([]);
  });

  it("refuses a token signed with any other key", async () => {
    const { json } = await mint(ownerCookie());
    // Same claims, signed as if the box had another secret.
    process.env.SESSION_SECRET = "z".repeat(64);
    const forged = await answer(`clawbox_session=${auth.createSessionCookie(3600, "z".repeat(64), 0)}`, json.token, "send");
    expect(forged.status).toBe(403);
    expect(forged.json.kind).toBe("forged");
    expect(sends).toEqual([]);
  });

  it("refuses a token used once already — twice in a row, or racing itself", async () => {
    const { json } = await mint(ownerCookie());
    const [a, b] = await Promise.all([answer(ownerCookie(), json.token, "send"), answer(ownerCookie(), json.token, "send")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.json.kind, b.json.kind]).toContain("reused");
    const third = await answer(ownerCookie(), json.token, "send");
    expect(third.status).toBe(409);
    expect(third.json).toMatchObject({ kind: "reused", state: "sent" });
    expect(sends).toHaveLength(1);
  });

  it("refuses to send after the person chose Keep, or asked for changes", async () => {
    const kept = await mint(ownerCookie());
    expect((await answer(ownerCookie(), kept.json.token, "keep")).json.state).toBe("kept");
    const afterKeep = await answer(ownerCookie(), kept.json.token, "send");
    expect(afterKeep.status).toBe(409);
    expect(afterKeep.json).toMatchObject({ kind: "reused", state: "kept" });

    const reopened = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect(reopened.json.state).toBe("open");
    expect((await answer(ownerCookie(), reopened.json.token, "revise")).json.state).toBe("revised");
    expect((await answer(ownerCookie(), reopened.json.token, "send")).json.kind).toBe("reused");
    expect(sends).toEqual([]);
  });

  it("refuses an expired token", async () => {
    process.env.CLAWBOX_MAIL_DRAFT_TOKEN_TTL_S = "60";
    const { json } = await mint(ownerCookie());
    expect(Number(json.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    const res = await answer(ownerCookie(), json.token, "send");
    expect(res.status).toBe(410);
    expect(res.json.kind).toBe("expired");
    expect(sends).toEqual([]);
    // A fresh look gives a fresh approval for the same draft, and that one works.
    const fresh = await mint(ownerCookie());
    expect(fresh.json.token).not.toBe(json.token);
    expect((await answer(ownerCookie(), fresh.json.token, "send")).status).toBe(200);
    vi.useRealTimers();
  });

  it("refuses a draft changed after the card was shown — any field that decides what is sent", async () => {
    for (const change of [
      (d: Draft) => { d.body += "\nP.S. wire the money to account 123."; },
      (d: Draft) => { d.to.push("attacker@example.net"); },
      (d: Draft) => { d.cc = []; },
      (d: Draft) => { d.subject = "Offer for Globex"; },
      // Nothing the card lists, everything the mail carries: where replies go.
      (d: Draft) => { d.replyTo = ["attacker@example.net"]; },
    ]) {
      const { json } = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
      change(mailbox[OWNER][DRAFT_ID]);
      const res = await answer(ownerCookie(), json.token, "send");
      expect(res.status).toBe(409);
      expect(res.json.kind).toBe("changed");
      // The current version gets a card of its own, and THAT one may be sent.
      const current = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
      expect(current.json.token).not.toBe(json.token);
      expect((await answer(ownerCookie(), json.token, "send")).json.kind).toBe("reused");
    }
    expect(sends).toEqual([]);
  });

  it("refuses another user's card, both ways", async () => {
    const owners = await mint(ownerCookie());
    const byStaff = await answer(staffCookie(), owners.json.token, "send");
    expect(byStaff.status).toBe(403);
    expect(byStaff.json.kind).toBe("other_user");
    expect((await answer(staffCookie(), owners.json.token, "keep")).json.kind).toBe("other_user");

    const staffs = await mint(staffCookie(), "staff-draft-1");
    expect(staffs.status).toBe(200);
    const byOwner = await answer(ownerCookie(), staffs.json.token, "send");
    expect(byOwner.status).toBe(403);
    expect(byOwner.json.kind).toBe("other_user");
    expect(sends).toEqual([]);
    // Neither refusal used the approval up.
    expect((await answer(ownerCookie(), owners.json.token, "send")).status).toBe(200);
  });

  it("works for a member of staff, from their own mailbox", async () => {
    const { status: code, json } = await mint(staffCookie(), "staff-draft-1");
    expect(code).toBe(200);
    expect(backendCalls[0].url).toContain(`user=${STAFF}`);
    // The owner's draft is not in the member's mailbox.
    expect((await mint(staffCookie(), DRAFT_ID)).json.kind).toBe("gone");
    const sent = await answer(staffCookie(), json.token, "send");
    expect(sent.status).toBe(200);
    expect(sends).toEqual([expect.objectContaining({ user: STAFF, draftId: "staff-draft-1" })]);
  });

  it("refuses a removed user's cookie", async () => {
    const { json } = await mint(staffCookie(), "staff-draft-1");
    writeConfig({ clawbox_users: [] });
    const res = await answer(staffCookie(), json.token, "send");
    expect(res.status).toBe(403);
    expect(res.json.kind).toBe("owner_only");
    expect(sends).toEqual([]);
  });

  it("stops when the owner switches the cards off", async () => {
    const { json } = await mint(ownerCookie());
    writeConfig({ mail_draft_approval_enabled: false });
    const res = await answer(ownerCookie(), json.token, "send");
    expect(res.status).toBe(409);
    expect(res.json.kind).toBe("disabled");
    expect(sends).toEqual([]);
  });

  it("passes the backend's own refusal of a changed draft on, and never reports an unknown outcome as unsent", async () => {
    sendAnswer = 409;
    const changed = await mint(ownerCookie());
    expect((await answer(ownerCookie(), changed.json.token, "send")).json.kind).toBe("changed");

    sendAnswer = 503;
    const lost = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    const res = await answer(ownerCookie(), lost.json.token, "send");
    expect(res.status).toBe(502);
    expect(res.json.kind).toBe("send_uncertain");
    // Settled: the same approval is not offered for a second try.
    expect((await answer(ownerCookie(), lost.json.token, "send")).json.kind).toBe("reused");
  });

  it("does not offer a Send whose answer was lost again on a plain look", async () => {
    sendAnswer = 503;
    const { json } = await mint(ownerCookie());
    expect((await answer(ownerCookie(), json.token, "send")).json.kind).toBe("send_uncertain");
    const look = await mint(ownerCookie());
    expect(look.json).toMatchObject({ state: "uncertain", uncertainty: expect.any(Number) });
    expect(look.json.token).toBeUndefined();
    // Only the person's explicit "Review again" asks again — naming the warning it was shown.
    sendAnswer = 200;
    const reopened = await mint(ownerCookie(), DRAFT_ID, { reopen: true, acknowledged: look.json.uncertainty });
    expect(reopened.json.state).toBe("open");
    expect((await answer(ownerCookie(), reopened.json.token, "send")).status).toBe(200);
    expect(sends).toHaveLength(2);
  });

  it("two cards made at once both stay usable", async () => {
    mailbox[OWNER]["second-draft"] = { id: "second-draft", to: ["b@example.com"], cc: [], subject: "Two", body: "2" };
    const [a, b] = await Promise.all([mint(ownerCookie()), mint(ownerCookie(), "second-draft")]);
    expect((await answer(ownerCookie(), a.json.token, "send")).status).toBe(200);
    expect((await answer(ownerCookie(), b.json.token, "send")).status).toBe(200);
    expect(sends.map((x) => x.draftId).sort()).toEqual([DRAFT_ID, "second-draft"].sort());
  });

  it("a card made while a Send is running cannot undo the Send", async () => {
    const { json } = await mint(ownerCookie());
    let release!: () => void;
    gate = { id: DRAFT_ID, hit: false, wait: new Promise<void>((resolve) => { release = resolve; }) };
    // A second look reads the draft (still in the mailbox) and is held there...
    const look = mint(ownerCookie());
    await vi.waitFor(() => expect(gate?.hit).toBe(true));
    // ...while the person's Send runs to the end.
    expect((await answer(ownerCookie(), json.token, "send")).status).toBe(200);
    release();
    const late = await look;
    expect(late.json.state).toBe("sent");
    expect((await answer(ownerCookie(), json.token, "send")).json).toMatchObject({ kind: "reused", state: "sent" });
    expect(sends).toHaveLength(1);
  });

  it("leaves the approval usable when the backend could not be reached before sending", async () => {
    const { json } = await mint(ownerCookie());
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
    const down = await answer(ownerCookie(), json.token, "send");
    expect(down.status).toBe(502);
    expect(down.json.kind).toBe("backend_unreachable");
    expect(sends).toEqual([]);
    expect((await answer(ownerCookie(), json.token, "send")).status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  it("refuses a Send for a draft whose preview was cut, even with a valid approval, and leaves Keep and Revise open", async () => {
    // The card offers no Send for these; the server must not either, for a caller that skips the card.
    const cut: [string, Partial<Draft>, string][] = [
      ["a subject over the cap", { subject: "s".repeat(1001) }, "headerTruncated"],
      ["an HTML run past the sanitiser's ceiling", { bodyType: "html", body: `<p>${"x".repeat(100_000)}</p>` }, "bodyTruncated"],
    ];
    for (const [name, patch, flag] of cut) {
      mailbox[OWNER][DRAFT_ID] = { id: DRAFT_ID, to: ["a@example.com"], cc: [], subject: "Cut", body: "Body", ...patch };
      const minted = await mint(ownerCookie());
      expect(minted.json.draft, name).toMatchObject({ [flag]: true });
      const refused = await answer(ownerCookie(), minted.json.token, "send");
      expect(refused.status, name).toBe(409);
      expect(refused.json, name).toMatchObject({ kind: "too_long" });
      expect(sends, name).toEqual([]);
      // Nothing was sent and the card was given back: it can still be answered, again and otherwise.
      expect((await answer(ownerCookie(), minted.json.token, "send")).json.kind, name).toBe("too_long");
      expect((await answer(ownerCookie(), minted.json.token, "keep")).json, name).toEqual({ state: "kept" });
      const again = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
      expect((await answer(ownerCookie(), again.json.token, "revise")).json, name).toEqual({ state: "revised" });
      expect(sends, name).toEqual([]);
    }
    // A draft shown whole is sent as before.
    mailbox[OWNER][DRAFT_ID] = { id: DRAFT_ID, to: ["a@example.com"], cc: [], subject: "Whole", body: "x".repeat(900_000) };
    const whole = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect((await answer(ownerCookie(), whole.json.token, "send")).status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  /**
   * Two open cards for ONE draft: card A close to its expiry is no longer
   * handed out, so a later look makes card B, and both stay valid.
   */
  async function twoCards() {
    process.env.CLAWBOX_MAIL_DRAFT_TOKEN_TTL_S = "600";
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const a = await mint(ownerCookie());
    vi.setSystemTime(t0 + 481_000);
    const b = await mint(ownerCookie());
    expect(a.json.state).toBe("open");
    expect(b.json.state).toBe("open");
    expect(b.json.token).not.toBe(a.json.token);
    return { a: String(a.json.token), b: String(b.json.token), t0 };
  }

  function cardIdOf(token: string): string {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).c;
  }

  it("sends a draft once, not once per card: another card's Send is refused while one runs and after it went", async () => {
    const { a, b } = await twoCards();
    let release!: () => void;
    gate = { id: DRAFT_ID, hit: false, wait: new Promise<void>((resolve) => { release = resolve; }) };
    // Card A's Send has claimed the draft and is reading it...
    const first = answer(ownerCookie(), a, "send");
    await vi.waitFor(() => expect(gate?.hit).toBe(true));
    // ...when card B, in another tab, is pressed.
    const second = await answer(ownerCookie(), b, "send");
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ kind: "reused", state: "sending" });
    release();
    expect((await first).status).toBe(200);
    const third = await answer(ownerCookie(), b, "send");
    expect(third.status).toBe(409);
    expect(third.json).toMatchObject({ kind: "reused", state: "sent" });
    expect(sends).toHaveLength(1);
  });

  it("frees the draft for the other card when a Send stopped before sending", async () => {
    const { a, b } = await twoCards();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await answer(ownerCookie(), a, "send")).json.kind).toBe("backend_unreachable");
    expect((await answer(ownerCookie(), b, "send")).status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  it("a Send whose answer was lost blocks every card made before it, and Review again makes one that may send", async () => {
    const { a, b } = await twoCards();
    sendAnswer = 503;
    const lost = await answer(ownerCookie(), a, "send");
    expect(lost.json.kind).toBe("send_uncertain");
    // Every answer that says uncertain names the same lost Send.
    const loss = lost.json.uncertainty;
    expect(loss).toEqual(expect.any(Number));
    sendAnswer = 200;
    const older = await answer(ownerCookie(), b, "send");
    expect(older.status).toBe(409);
    expect(older.json).toMatchObject({ kind: "reused", state: "uncertain", uncertainty: loss });
    expect((await answer(ownerCookie(), a, "send")).json).toMatchObject({ kind: "reused", state: "uncertain", uncertainty: loss });
    expect(sends).toHaveLength(1);
    // A plain look does not offer it; "Review again" hands out a NEW card, not B.
    expect((await mint(ownerCookie())).json).toMatchObject({ state: "uncertain", uncertainty: loss });
    const reopened = await mint(ownerCookie(), DRAFT_ID, { reopen: true, acknowledged: loss });
    expect(reopened.json.state).toBe("open");
    expect(reopened.json.token).not.toBe(b);
    expect((await answer(ownerCookie(), String(reopened.json.token), "send")).status).toBe(200);
    expect(sends).toHaveLength(2);
  });

  it("a Send whose server died mid-call blocks the older cards, never the draft for good", async () => {
    const { a, b, t0 } = await twoCards();
    // Card A's Send was claimed, and no answer ever came back.
    const ledgerPath = path.join(root, "data", "mail-draft-approvals.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { cards: { c: string; state: string; at: number }[] };
    const claimedAt = t0 + 482_000;
    Object.assign(ledger.cards.find((entry) => entry.c === cardIdOf(a))!, { state: "sending", at: claimedAt });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    // While it may still be running, nothing else sends the draft.
    vi.setSystemTime(claimedAt + 60_000);
    expect((await answer(ownerCookie(), b, "send")).json).toMatchObject({ kind: "reused", state: "sending" });
    // Past the time a Send can take, it is a lost Send: B, made before it, still cannot send...
    vi.setSystemTime(claimedAt + 121_000);
    expect((await answer(ownerCookie(), b, "send")).json).toMatchObject({ kind: "reused", state: "uncertain" });
    // ...and A pressed again is told the same, not "sending".
    expect((await answer(ownerCookie(), a, "send")).json).toMatchObject({ kind: "reused", state: "uncertain", uncertainty: claimedAt + 120_000 });
    expect((await mint(ownerCookie())).json).toMatchObject({ state: "uncertain", uncertainty: claimedAt + 120_000 });
    // ...and "Review again" makes a card that can, which a reload then shows.
    const reopened = await mint(ownerCookie(), DRAFT_ID, { reopen: true, acknowledged: claimedAt + 120_000 });
    expect(reopened.json.state).toBe("open");
    expect((await mint(ownerCookie())).json).toMatchObject({ state: "open", token: reopened.json.token });
    expect((await answer(ownerCookie(), String(reopened.json.token), "send")).status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  it("never forgets a lost Send to make room: the card count cap spares sent, sending and uncertain cards", async () => {
    sendAnswer = 503;
    const { json } = await mint(ownerCookie());
    expect((await answer(ownerCookie(), json.token, "send")).json.kind).toBe("send_uncertain");
    // A busy box: 2000 newer cards for other drafts.
    const ledgerPath = path.join(root, "data", "mail-draft-approvals.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { v: 1; cards: Record<string, unknown>[] };
    const now = Date.now();
    for (let i = 0; i < 2000; i += 1) {
      ledger.cards.push({ c: `filler${String(i).padStart(16, "0")}`, u: OWNER, d: `filler-${i}`, h: "0".repeat(64), iat: now + i, exp: now + 600_000, state: "kept", at: now + i });
    }
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    // Any write trims the ledger to its cap...
    mailbox[OWNER]["second-draft"] = { id: "second-draft", to: ["b@example.com"], cc: [], subject: "Two", body: "2" };
    expect((await mint(ownerCookie(), "second-draft")).json.state).toBe("open");
    const trimmed = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { cards: { d: string; state: string }[] };
    // The cap is 2000 records, the pinned one among them: 1999 of the 2001
    // newer ones stay beside it, not all of them plus the pin.
    expect(trimmed.cards).toHaveLength(2000);
    expect(trimmed.cards.some((c) => c.d === DRAFT_ID && c.state === "uncertain")).toBe(true);
    // ...and the lost Send is still not offered again on a plain look.
    sendAnswer = 200;
    expect((await mint(ownerCookie())).json).toMatchObject({ state: "uncertain" });
    expect(sends).toHaveLength(1);
  });

  it("refuses, rather than guesses, when the ledger cannot be read", async () => {
    const { json } = await mint(ownerCookie());
    fs.writeFileSync(path.join(root, "data", "mail-draft-approvals.json"), "{not json");
    const res = await answer(ownerCookie(), json.token, "send");
    expect(res.status).toBe(503);
    expect(sends).toEqual([]);
  });

  it("refuses the whole ledger when one entry cannot be read, rather than sending past it", async () => {
    const { json } = await mint(ownerCookie());
    const ledgerPath = path.join(root, "data", "mail-draft-approvals.json");
    const open = (JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { cards: Record<string, unknown>[] }).cards[0];
    const at = Date.now();
    // The record that would block this Send, written in a way this build cannot
    // read. Dropping it and judging the Send on what is left would SEND.
    const blocking = { c: "x".repeat(22), u: OWNER, d: DRAFT_ID, h: "0".repeat(64), iat: at, exp: at + 1000, state: "sent" };
    fs.writeFileSync(ledgerPath, JSON.stringify({ v: 1, cards: [{ ...blocking, at: "recently" }, open] }));
    expect((await answer(ownerCookie(), json.token, "send")).status).toBe(503);
    // A timestamp that is a number but not a finite one is no timestamp either:
    // Infinity compares false against every deadline the checks apply.
    fs.writeFileSync(ledgerPath, `{"v":1,"cards":[${JSON.stringify(open).replace(/"at":-?\d+(\.\d+)?/, '"at":1e999')}]}`);
    expect((await answer(ownerCookie(), json.token, "send")).status).toBe(503);
    expect(sends).toEqual([]);
  });

  it("refuses a new card, rather than issuing a token the ledger has no room for", async () => {
    // A ledger full of records the count cap may never drop: every one of them
    // says a draft went, is going, or may have gone.
    const ledgerPath = path.join(root, "data", "mail-draft-approvals.json");
    const now = Date.now();
    const cards = Array.from({ length: 2000 }, (_, i) => ({
      c: `pinned${String(i).padStart(16, "0")}`, u: OWNER, d: `pinned-${i}`, h: "0".repeat(64),
      iat: now + i, exp: now + 600_000, state: "sent", at: now + i,
    }));
    fs.writeFileSync(ledgerPath, JSON.stringify({ v: 1, cards }));
    // An answered card of this person's, which a refused request must not cost them.
    cards.push({
      c: "kept".padEnd(22, "0"), u: OWNER, d: "earlier-draft", h: "1".repeat(64),
      iat: now, exp: now + 600_000, state: "kept", at: now,
    });
    fs.writeFileSync(ledgerPath, JSON.stringify({ v: 1, cards }));
    const full = await mint(ownerCookie());
    expect(full.status).toBe(503);
    expect(full.json.kind).toBe("no_room");
    expect(full.json.token).toBeUndefined();
    // Nothing was written: the pinned records and the answered one are all there.
    const after = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { cards: { state: string }[] };
    expect(after.cards.filter((c) => c.state === "sent")).toHaveLength(2000);
    expect(after.cards.filter((c) => c.state === "kept")).toHaveLength(1);
    expect(sends).toEqual([]);
  });

  it("does not call a Send recorded when the ledger no longer holds the card", async () => {
    const ledgerPath = path.join(root, "data", "mail-draft-approvals.json");
    const { json } = await mint(ownerCookie());
    let release!: () => void;
    gate = { id: DRAFT_ID, hit: false, wait: new Promise<void>((resolve) => { release = resolve; }) };
    // The Send has claimed the card and is re-reading the draft...
    const sending = answer(ownerCookie(), json.token, "send");
    await vi.waitFor(() => expect(gate?.hit).toBe(true));
    // ...when the ledger is replaced under it, claim and all. The mail still
    // goes, and the result reaches no record: the answer must say both.
    fs.writeFileSync(ledgerPath, JSON.stringify({ v: 1, cards: [] }));
    release();
    const sent = await sending;
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ state: "sent", recorded: false });
    expect(sends).toHaveLength(1);
  });

  it("records a confirmed Send even when the first ledger write fails, and says so when none works", async () => {
    const ledgerPath = path.join(root, "data", "mail-draft-approvals.json");
    const { json } = await mint(ownerCookie());
    const realWrite = fs.writeFileSync;
    let failures = 2;
    let recording = cardIdOf(String(json.token));
    // Only the write that RECORDS THIS CARD as sent fails; the claim before the
    // Send goes through, so the backend really is asked to send.
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: unknown, data: unknown, ...rest: unknown[]) => {
      const records = new RegExp(`"c":"${recording}"[^}]*"state":"sent"`).test(String(data));
      if (String(file).startsWith(ledgerPath) && failures > 0 && records) {
        failures -= 1;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      return (realWrite as (...args: unknown[]) => void)(file, data, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      const sent = await answer(ownerCookie(), json.token, "send");
      expect(sent.status).toBe(200);
      expect(sent.json.state).toBe("sent");
      // The retry wrote it; the backend was asked to send exactly once.
      expect(sent.json.recorded).toBeUndefined();
      expect(sends).toHaveLength(1);
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { cards: { state: string }[] };
      expect(ledger.cards.some((c) => c.state === "sent")).toBe(true);

      // And when no write works: still sent, and the answer says the record is not.
      mailbox[OWNER]["second-draft"] = { id: "second-draft", to: ["b@example.com"], cc: [], subject: "Two", body: "2" };
      const second = await mint(ownerCookie(), "second-draft");
      recording = cardIdOf(String(second.json.token));
      failures = 99;
      const lost = await answer(ownerCookie(), second.json.token, "send");
      expect(lost.status).toBe(200);
      expect(lost.json).toMatchObject({ state: "sent", recorded: false });
      expect(String(lost.json.warning)).toContain("sent");
      expect(sends).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  // Keep or Revise, checked here because what it must stop is a SEND: the
  // twoCards helper above is what makes two approvals for one version.
  it("Keep closes every approval for the version it declines, not only the card pressed", async () => {
    const { a, b } = await twoCards();
    expect((await answer(ownerCookie(), a, "keep")).json.state).toBe("kept");
    // Card B held an approval for the very version the person just declined.
    const other = await answer(ownerCookie(), b, "send");
    expect(other.status).toBe(409);
    expect(other.json).toMatchObject({ kind: "reused", state: "kept" });
    expect(sends).toEqual([]);
    // An explicit Review again still opens a card that may send.
    const reopened = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect(reopened.json.state).toBe("open");
    expect((await answer(ownerCookie(), String(reopened.json.token), "send")).status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  it("neither Keep nor Revise is confirmed while another card is sending that version", async () => {
    const { a, b } = await twoCards();
    let release!: () => void;
    gate = { id: DRAFT_ID, hit: false, wait: new Promise<void>((resolve) => { release = resolve; }) };
    // Card A's Send has claimed the draft and is reading it...
    const sending = answer(ownerCookie(), a, "send");
    await vi.waitFor(() => expect(gate?.hit).toBe(true));
    // ...when the person answers the same version on card B: not confirmed, and nothing changed.
    for (const action of ["keep", "revise"]) {
      const declined = await answer(ownerCookie(), b, action);
      expect(declined.status, action).toBe(409);
      expect(declined.json, action).toMatchObject({ kind: "reused", state: "sending" });
    }
    release();
    expect((await sending).json).toEqual({ state: "sent" });
    expect(sends).toHaveLength(1);
  });

  it("a Send that stopped before sending cannot reopen a version whose decline was confirmed", async () => {
    const { a, b } = await twoCards();
    let fail!: () => void;
    // Card A's read of the draft fails after the claim.
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((_, reject) => { fail = () => reject(new TypeError("fetch failed")); }));
    const sending = answer(ownerCookie(), a, "send");
    await vi.waitFor(() => expect(typeof fail).toBe("function"));
    expect((await answer(ownerCookie(), b, "keep")).json).toMatchObject({ kind: "reused", state: "sending" });
    fail();
    expect((await sending).json.kind).toBe("backend_unreachable");
    // The Send is over and nothing went: the decline is confirmed now, for BOTH cards.
    expect((await answer(ownerCookie(), b, "keep")).json).toEqual({ state: "kept" });
    expect((await answer(ownerCookie(), a, "send")).json).toMatchObject({ kind: "reused", state: "kept" });
    expect(sends).toEqual([]);
  });

  it("a Send claim that is past the time a Send can take no longer holds up Keep", async () => {
    const { a, b, t0 } = await twoCards();
    const ledgerPath = path.join(root, "data", "mail-draft-approvals.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as { cards: { c: string; state: string; at: number }[] };
    const claimedAt = t0 + 482_000;
    Object.assign(ledger.cards.find((entry) => entry.c === cardIdOf(a))!, { state: "sending", at: claimedAt });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    vi.setSystemTime(claimedAt + 60_000);
    expect((await answer(ownerCookie(), b, "keep")).json).toMatchObject({ kind: "reused", state: "sending" });
    vi.setSystemTime(claimedAt + 121_000);
    expect((await answer(ownerCookie(), b, "keep")).json).toEqual({ state: "kept" });
  });

  it("Keep leaves the approvals for another version of the draft alone", async () => {
    const { a } = await twoCards();
    // A revised draft: a new hash, so the card made for it is another version's.
    mailbox[OWNER][DRAFT_ID].body = "Hello Ivan, a shorter offer.";
    const newer = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect(newer.json.state).toBe("open");
    expect((await answer(ownerCookie(), a, "keep")).json.state).toBe("kept");
    expect((await answer(ownerCookie(), String(newer.json.token), "send")).status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  it("a Send lost while Review again was loading needs another Review again", async () => {
    const { a, b } = await twoCards();
    let release!: () => void;
    gate = { id: DRAFT_ID, hit: false, wait: new Promise<void>((resolve) => { release = resolve; }) };
    // The person's "Review again" is reading the draft...
    const reviewing = mint(ownerCookie(), DRAFT_ID, { reopen: true });
    await vi.waitFor(() => expect(gate?.hit).toBe(true));
    // ...while card A's Send loses the mail service's answer.
    sendAnswer = 503;
    expect((await answer(ownerCookie(), a, "send")).json.kind).toBe("send_uncertain");
    release();
    // The card that was loading cannot send: that loss came after the person
    // asked, so they have not been warned about it.
    const late = await reviewing;
    expect(late.json).toMatchObject({ state: "uncertain", uncertainty: expect.any(Number) });
    expect(late.json.token).toBeUndefined();
    expect((await answer(ownerCookie(), b, "send")).json).toMatchObject({ kind: "reused", state: "uncertain", uncertainty: late.json.uncertainty });
    // Asked again, now that the card has said so, a card that may send.
    sendAnswer = 200;
    const reopened = await mint(ownerCookie(), DRAFT_ID, { reopen: true, acknowledged: late.json.uncertainty });
    expect(reopened.json.state).toBe("open");
    expect((await answer(ownerCookie(), String(reopened.json.token), "send")).status).toBe(200);
    expect(sends).toHaveLength(2);
  });

  it("Review again from a card still saying Kept is answered with a Send lost meanwhile, never with a card that can send", async () => {
    // Tab 1: the person keeps the draft; the card says "Kept" with a Review again.
    const first = await mint(ownerCookie());
    expect((await answer(ownerCookie(), first.json.token, "keep")).json.state).toBe("kept");
    // Tab 2: Review again, then a Send whose answer is lost.
    const tab2 = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect(tab2.json.state).toBe("open");
    sendAnswer = 503;
    const lost = await answer(ownerCookie(), tab2.json.token, "send");
    expect(lost.json).toMatchObject({ kind: "send_uncertain", uncertainty: expect.any(Number) });
    sendAnswer = 200;
    // Tab 1 never showed that warning: its Review again names no loss, so it
    // is shown the warning — no token — and nothing more is sent.
    const fromKept = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect(fromKept.json).toMatchObject({ state: "uncertain", uncertainty: lost.json.uncertainty });
    expect(fromKept.json.token).toBeUndefined();
    // A warning older than the current one, or anything that is not one, is no answer to it either.
    for (const acknowledged of [Number(lost.json.uncertainty) - 1, String(lost.json.uncertainty), null, "x"]) {
      const stale = await mint(ownerCookie(), DRAFT_ID, { reopen: true, acknowledged });
      expect(stale.json, String(acknowledged)).toMatchObject({ state: "uncertain", uncertainty: lost.json.uncertainty });
      expect(stale.json.token, String(acknowledged)).toBeUndefined();
    }
    // A plain look naming it is not a Review again.
    expect((await mint(ownerCookie(), DRAFT_ID, { acknowledged: lost.json.uncertainty })).json).toMatchObject({ state: "uncertain" });
    expect(sends).toHaveLength(1);
    // Once the card has shown it, its Review again names it and gets a card that can send.
    const reviewed = await mint(ownerCookie(), DRAFT_ID, { reopen: true, acknowledged: fromKept.json.uncertainty });
    expect(reviewed.json.state).toBe("open");
    expect((await answer(ownerCookie(), String(reviewed.json.token), "send")).status).toBe(200);
    expect(sends).toHaveLength(2);
  });

  it("Review again from Kept or Revised opens a card as before once every lost Send has been answered", async () => {
    sendAnswer = 503;
    const first = await mint(ownerCookie());
    const lost = await answer(ownerCookie(), first.json.token, "send");
    expect(lost.json.kind).toBe("send_uncertain");
    sendAnswer = 200;
    // The person was warned, reviewed it again, and kept it this time.
    const reviewed = await mint(ownerCookie(), DRAFT_ID, { reopen: true, acknowledged: lost.json.uncertainty });
    expect(reviewed.json.state).toBe("open");
    expect((await answer(ownerCookie(), reviewed.json.token, "keep")).json.state).toBe("kept");
    expect((await mint(ownerCookie())).json.state).toBe("kept");
    // That loss has had its card: Review again from Kept needs no warning now.
    const again = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect(again.json.state).toBe("open");
    expect((await answer(ownerCookie(), again.json.token, "revise")).json.state).toBe("revised");
    const fromRevised = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect(fromRevised.json.state).toBe("open");
    expect((await answer(ownerCookie(), String(fromRevised.json.token), "send")).status).toBe(200);
    expect(sends).toHaveLength(2);
  });

  it("neither Keep nor Revise is confirmed once another card's Send of the draft went", async () => {
    const { a, b } = await twoCards();
    // Card A sends; card B, open in another tab for the same version, is not closed by it.
    expect((await answer(ownerCookie(), a, "send")).json).toEqual({ state: "sent" });
    for (const action of ["keep", "revise"]) {
      const declined = await answer(ownerCookie(), b, action);
      expect(declined.status, action).toBe(409);
      expect(declined.json, action).toMatchObject({ kind: "reused", state: "sent" });
    }
    // Nothing was changed: B is still open in the ledger, and every look says sent.
    const ledger = JSON.parse(fs.readFileSync(path.join(root, "data", "mail-draft-approvals.json"), "utf8")) as { cards: { c: string; state: string }[] };
    expect(ledger.cards.find((entry) => entry.c === cardIdOf(b))?.state).toBe("open");
    expect((await mint(ownerCookie())).json.state).toBe("sent");
    expect((await answer(ownerCookie(), b, "send")).json).toMatchObject({ kind: "reused", state: "sent" });
    expect(sends).toHaveLength(1);
  });

  it("a Send of another version that went also stops Keep and Revise", async () => {
    const { a } = await twoCards();
    // A revised draft: a new hash, and its own card, which sends.
    mailbox[OWNER][DRAFT_ID].body = "Hello Ivan, a shorter offer.";
    const newer = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect((await answer(ownerCookie(), String(newer.json.token), "send")).status).toBe(200);
    // Card A was for the older version, but the mail has left all the same.
    expect((await answer(ownerCookie(), a, "keep")).json).toMatchObject({ kind: "reused", state: "sent" });
    expect(sends).toHaveLength(1);
  });
});

describe("Keep as draft and Tell me what to change", () => {
  it("keep sends nothing and is remembered for that version", async () => {
    const { json } = await mint(ownerCookie());
    const kept = await answer(ownerCookie(), json.token, "keep");
    expect(kept).toEqual({ status: 200, json: { state: "kept" } });
    expect(sends).toEqual([]);
    expect((await mint(ownerCookie())).json).toMatchObject({ state: "kept", draft: { id: DRAFT_ID } });
    // A revised draft is a new question.
    mailbox[OWNER][DRAFT_ID].body = "Hello Ivan, a shorter offer.";
    expect((await mint(ownerCookie())).json.state).toBe("open");
  });

  it("a reload after Review again shows the open card, not the earlier answer", async () => {
    const { json } = await mint(ownerCookie());
    expect((await answer(ownerCookie(), json.token, "keep")).json.state).toBe("kept");
    const reopened = await mint(ownerCookie(), DRAFT_ID, { reopen: true });
    expect(reopened.json.state).toBe("open");
    expect((await mint(ownerCookie())).json).toMatchObject({ state: "open", token: reopened.json.token });
    // Answered again, the answer is what a reload shows.
    expect((await answer(ownerCookie(), reopened.json.token, "revise")).json.state).toBe("revised");
    expect((await mint(ownerCookie())).json.state).toBe("revised");
  });

  it("revise closes the card and sends nothing", async () => {
    const { json } = await mint(ownerCookie());
    expect((await answer(ownerCookie(), json.token, "revise")).json).toEqual({ state: "revised" });
    expect(sends).toEqual([]);
    expect((await mint(ownerCookie())).json.state).toBe("revised");
  });

  it("refuses an unknown action", async () => {
    const { json } = await mint(ownerCookie());
    const res = await answer(ownerCookie(), json.token, "send_now");
    expect(res.status).toBe(400);
    expect(sends).toEqual([]);
  });
});

describe("the status the assistant's tool reads", () => {
  it("tells the bearer whether cards are on and whether the draft exists, and nothing else", async () => {
    const on = await status.GET(req(`/setup-api/email/draft-approval/status?draft=${encodeURIComponent(DRAFT_ID)}`, { bearer: MCP_TOKEN }));
    expect(await on.json()).toEqual({ enabled: true, draft: "found" });
    const missing = await status.GET(req("/setup-api/email/draft-approval/status?draft=nope", { bearer: MCP_TOKEN }));
    expect(await missing.json()).toEqual({ enabled: true, draft: "missing" });
    fs.writeFileSync(path.join(root, "data", "config.json"), "{}");
    const off = await status.GET(req("/setup-api/email/draft-approval/status?draft=x", { bearer: MCP_TOKEN }));
    expect(await off.json()).toEqual({ enabled: false });
  });
});

describe("the settings route", () => {
  it("answers the owner without the secret, and nobody else at all", async () => {
    const owner = await settings.GET(req("/setup-api/email/draft-approval", { cookie: ownerCookie() }));
    expect(owner.status).toBe(200);
    const body = await owner.json();
    expect(body).toMatchObject({ enabled: true, endpoint: ENDPOINT, authHeader: "Authorization", hasAuth: true, active: true });
    expect(JSON.stringify(body)).not.toContain("backend-placeholder-credential");
    for (const [name, request] of [
      ["no credential", req("/setup-api/email/draft-approval")],
      ["the MCP bearer", req("/setup-api/email/draft-approval", { bearer: MCP_TOKEN })],
      ["a member of staff", req("/setup-api/email/draft-approval", { cookie: staffCookie() })],
    ] as const) {
      expect((await settings.GET(request)).status, name).toBe(403);
      const write = await settings.POST(req("/setup-api/email/draft-approval", {
        cookie: request.headers.get("cookie") ?? undefined,
        bearer: name === "the MCP bearer" ? MCP_TOKEN : undefined,
        body: { endpoint: "http://127.0.0.1:9999" },
      }));
      expect(write.status, name).toBe(403);
    }
    expect(readConfig().mail_draft_approval_endpoint).toBe(ENDPOINT);
  });

  it("keeps the backend on this box", async () => {
    for (const endpoint of [
      "http://192.0.2.10:8790",
      "https://mail.example.com",
      "http://127.0.0.1.example.com",
      "http://user:pw@127.0.0.1:8790",
      "http://127.0.0.1:8790/?redirect=x",
      "file:///etc/passwd",
    ]) {
      const res = await settings.POST(req("/setup-api/email/draft-approval", { cookie: ownerCookie(), origin: "http://clawbox.local", body: { endpoint } }));
      expect(res.status, endpoint).toBe(400);
    }
    const ok = await settings.POST(req("/setup-api/email/draft-approval", {
      cookie: ownerCookie(),
      origin: "http://clawbox.local",
      body: { endpoint: "http://localhost:8791/", authHeader: "X-Api-Key", authValue: "k-placeholder" },
    }));
    expect(ok.status).toBe(200);
    const saved = await ok.json();
    expect(saved).toMatchObject({ endpoint: "http://localhost:8791", authHeader: "X-Api-Key", hasAuth: true });
    expect(JSON.stringify(saved)).not.toContain("k-placeholder");
  });

  it("refuses a cross-site write and switching on with no backend", async () => {
    const cross = await settings.POST(req("/setup-api/email/draft-approval", { cookie: ownerCookie(), origin: "http://evil.example", body: { enabled: false } }));
    expect(cross.status).toBe(403);
    fs.writeFileSync(path.join(root, "data", "config.json"), "{}");
    const on = await settings.POST(req("/setup-api/email/draft-approval", { cookie: ownerCookie(), origin: "http://clawbox.local", body: { enabled: true } }));
    expect(on.status).toBe(409);
    expect((await on.json()).kind).toBe("no_endpoint");
  });

  it("tests the connection without sending, and forgets everything on DELETE", async () => {
    const probe = await settings.POST(req("/setup-api/email/draft-approval", { cookie: ownerCookie(), origin: "http://clawbox.local", body: { action: "test" } }));
    expect(await probe.json()).toEqual({ result: "ok" });
    expect(sends).toEqual([]);
    const gone = await settings.DELETE(req("/setup-api/email/draft-approval", { cookie: ownerCookie(), origin: "http://clawbox.local", method: "DELETE" }));
    expect(gone.status).toBe(200);
    const config = readConfig();
    expect(config.mail_draft_approval_enabled).toBe(false);
    expect(config.mail_draft_approval_endpoint).toBeUndefined();
    expect(config.mail_draft_approval_auth_value).toBeUndefined();
  });
});
