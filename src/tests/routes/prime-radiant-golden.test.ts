/**
 * The golden-question and daily-question routes over a real vault in a tmp
 * dir: the reads never create anything; a golden question is the owner's or
 * the assistant's to add, edit and delete (one commit each, the assistant's
 * named as such), never another site's; the daily list is read-only; status
 * carries the accuracy; and whether the assistant may SEND the daily
 * questions is the owner's switch alone. Fixtures are synthetic.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn(async () => true) }));
vi.mock("@/lib/owner-session", () => owner);
const bearer = vi.hoisted(() => ({ verifyMcpBearer: vi.fn((h: string | null) => h === "Bearer test-assistant-bearer") }));
vi.mock("@/lib/mcp-token", () => bearer);

import { GET as goldenGET, POST as goldenPOST } from "@/app/setup-api/prime-radiant/golden/route";
import { DELETE as goldenDELETE, PATCH as goldenPATCH } from "@/app/setup-api/prime-radiant/golden/[id]/route";
import { GET as dailyGET } from "@/app/setup-api/prime-radiant/daily/route";
import { GET as statusGET } from "@/app/setup-api/prime-radiant/status/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/setup-api/prime-radiant/settings/route";
import { git } from "@/lib/prime-radiant/git";
import { stop as stopScheduler } from "@/lib/prime-radiant/nightly-scheduler";
import { stateDbPath, vaultDir } from "@/lib/prime-radiant/paths";
import { ensureVault, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-golden-routes-"));
const prev = process.env.PRIME_RADIANT_DIR;
let n = 0;

const ORIGIN = "http://clawbox.local";
const API = `${ORIGIN}/setup-api/prime-radiant`;
const EVIL = { origin: "https://evil.example.com" };
const ASSISTANT = { authorization: "Bearer test-assistant-bearer", origin: "" };

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { origin: ORIGIN, "content-type": "application/json", ...headers };
  if (h.origin === "") delete h.origin;
  return new Request(`${API}${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: h });
}
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

const QUESTION = { question: "What does the blue widget cost?", expected: "10 EUR", domain: "acme-sales" };

beforeEach(() => {
  auth.requireSession.mockReset().mockResolvedValue(null);
  owner.hasPersonSession.mockReset().mockResolvedValue(true);
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`, "prime-radiant");
});

afterAll(() => {
  stopScheduler();
  if (prev === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prev;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("golden routes", () => {
  it("answer whatever requireSession answers", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "x", code: "unauthorized" }, { status: 401 }));
    for (const res of [await goldenGET(req("GET", "/golden")), await goldenPOST(req("POST", "/golden", QUESTION)), await dailyGET(req("GET", "/daily"))]) {
      expect(res.status).toBe(401);
    }
  });

  it("read nothing into being: no vault, an empty list and no score", async () => {
    const res = await goldenGET(req("GET", "/golden"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ questions: [], skipped: 0, verdicts: {}, score: { questions: 0, last: null, trend: [], change: null } });
    const daily = await dailyGET(req("GET", "/daily?owner=Sales%20team"));
    expect(await daily.json()).toMatchObject({ initialised: false, outbound: false, owners: [], questions: [] });
    expect(fs.existsSync(vaultDir())).toBe(false);
    expect(fs.existsSync(stateDbPath())).toBe(false);
    expect((await goldenPOST(req("POST", "/golden", QUESTION))).status).toBe(412);
  });

  it("add, edit and delete a question as one commit each; the assistant's commit names it; another site is refused", async () => {
    await ensureVault();
    const added = await goldenPOST(req("POST", "/golden", { ...QUESTION, owner: "Sales team" }));
    expect(added.status).toBe(201);
    const { question, commit } = await added.json();
    expect(question).toMatchObject({ ...QUESTION, owner: "Sales team" });
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    const list = await (await goldenGET(req("GET", "/golden"))).json();
    expect(list.questions.map((q: { id: string }) => q.id)).toEqual([question.id]);
    expect(list.score.questions).toBe(1);

    owner.hasPersonSession.mockResolvedValue(false);
    const edited = await goldenPATCH(req("PATCH", `/golden/${question.id}`, { expected: "12 EUR" }, ASSISTANT), idCtx(question.id));
    expect(edited.status).toBe(200);
    expect((await edited.json()).question.expected).toBe("12 EUR");
    expect((await git(vaultDir(), ["log", "-1", "--format=%an %s"])).stdout.trim()).toBe(`ClawBox assistant golden: edit ${question.id}`);
    expect((await goldenPATCH(req("PATCH", `/golden/${question.id}`, { expected: "x" }, EVIL), idCtx(question.id))).status).toBe(403);
    expect((await goldenPOST(req("POST", "/golden", QUESTION))).status).toBe(403);
    owner.hasPersonSession.mockResolvedValue(true);

    expect((await goldenPATCH(req("PATCH", `/golden/${question.id}`, { colour: "red" }), idCtx(question.id))).status).toBe(400);
    expect((await goldenPATCH(req("PATCH", "/golden/gq-000000000000", { expected: "x" }), idCtx("gq-000000000000"))).status).toBe(404);
    expect((await goldenPATCH(req("PATCH", "/golden/../x", { expected: "x" }), idCtx("../x"))).status).toBe(404);
    expect((await goldenPOST(req("POST", "/golden", { ...QUESTION, domain: "Not A Slug" }))).status).toBe(400);

    const gone = await goldenDELETE(req("DELETE", `/golden/${question.id}`), idCtx(question.id));
    expect(gone.status).toBe(200);
    expect((await (await goldenGET(req("GET", "/golden"))).json()).questions).toEqual([]);
    expect((await goldenDELETE(req("DELETE", `/golden/${question.id}`), idCtx(question.id))).status).toBe(404);
  });

  it("status carries the golden score beside the vault's counts", async () => {
    await ensureVault();
    await goldenPOST(req("POST", "/golden", QUESTION));
    const status = await (await statusGET(req("GET", "/status"))).json();
    expect(status.golden).toEqual({ questions: 1, last: null, trend: [], change: null });
  });
});

describe("daily questions route", () => {
  it("lists the owners and one owner's questions in their language, sending off by default", async () => {
    await ensureVault();
    await vaultOperation("seed", async (tx) => {
      await tx.write("concepts/sales.md", pageText({ type: "metric", title: "Widget sales", as_of: "2026-05-01", claims: [claim("acme-sales/widget/q1", "Q1 sales were 40.")] }));
    });
    expect((await settingsPUT(req("PUT", "/settings", { domains: [{ name: "acme-sales", owner: "Иван Иванов" }], verification: { languages: [{ owner: "Иван Иванов", language: "bg" }] } }))).status).toBe(200);
    const all = await (await dailyGET(req("GET", "/daily"))).json();
    expect(all).toMatchObject({ initialised: true, outbound: false, perOwner: 5, owner: null, questions: [] });
    expect(all.owners).toEqual([{ owner: "Иван Иванов", domains: ["acme-sales"], pages: 1, language: "bg", waiting: 1 }]);
    const mine = await (await dailyGET(req("GET", `/daily?owner=${encodeURIComponent("Иван Иванов")}`))).json();
    expect(mine.language).toBe("bg");
    expect(mine.questions).toHaveLength(1);
    expect(mine.questions[0]).toMatchObject({ kind: "claim", claimId: "acme-sales/widget/q1", answer: { tool: "prime_radiant_claim_verify" } });
    expect(mine.questions[0].question).toContain("Още ли е вярно?");
    expect((await dailyGET(req("GET", `/daily?owner=${"x".repeat(81)}`))).status).toBe(400);
  });

  it("lets only the owner turn sending on; the assistant may change the rest", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    const refused = await settingsPUT(req("PUT", "/settings", { verification: { outbound: true } }, ASSISTANT));
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("owner_only");
    expect((await settingsPUT(req("PUT", "/settings", { verification: null }, ASSISTANT))).status).toBe(403);
    const perOwner = await settingsPUT(req("PUT", "/settings", { verification: { perOwner: 3 }, golden: { maxQuestions: 20 } }, ASSISTANT));
    expect(perOwner.status).toBe(200);
    expect((await perOwner.json()).settings).toMatchObject({ verification: { perOwner: 3, outbound: false }, golden: { enabled: true, maxQuestions: 20 } });
    owner.hasPersonSession.mockResolvedValue(true);
    const on = await settingsPUT(req("PUT", "/settings", { verification: { outbound: true } }));
    expect((await on.json()).settings.verification.outbound).toBe(true);
    const got = await (await settingsGET(req("GET", "/settings"))).json();
    expect(got.defaults.verification.outbound).toBe(false);
    expect(got.limits).toMatchObject({ dailyPerOwner: { min: 1, max: 20 }, goldenMaxQuestions: { min: 1, max: 500 } });
  });
});
