/**
 * The assistant's round trip through the routes its MCP tools call, over a
 * real vault: edit a page → delete a claim → undo the delete. History must
 * show all three commits, each authored by the assistant, and the page must
 * be back — the claim restored beside the edited text.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/route-auth", () => auth);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn(async () => false) }));
vi.mock("@/lib/owner-session", () => owner);
const bearer = vi.hoisted(() => ({ verifyMcpBearer: vi.fn((h: string | null) => h === "Bearer test-assistant-bearer") }));
vi.mock("@/lib/mcp-token", () => bearer);
const shard = vi.hoisted(() => ({ scheduleReindexAfterCommit: vi.fn(), reindexPrimeRadiantPaths: vi.fn(async () => null) }));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);

import { GET as pageGET, PATCH as pagePATCH } from "@/app/setup-api/prime-radiant/pages/[...path]/route";
import { DELETE as claimDELETE } from "@/app/setup-api/prime-radiant/claims/[...id]/route";
import { POST as revertPOST } from "@/app/setup-api/prime-radiant/revert/route";
import { GET as historyGET } from "@/app/setup-api/prime-radiant/history/[...path]/route";
import { ensureVault, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-agent-flow-"));
const prevDir = process.env.PRIME_RADIANT_DIR;

const API = "http://clawbox.local/setup-api/prime-radiant";
const PAGE = "concepts/pricing.md";
const BLUE = claim("acme-sales/pricing/blue-widget", "The blue widget costs 10 EUR.", { status: "proposed" });
const RED = claim("acme-sales/pricing/red-widget", "The red widget costs 14 EUR.", { status: "proposed" });

/** The MCP server's own request: the bearer, JSON, no Origin and no cookie. */
const asAssistant = (method: string, url: string, body?: unknown) =>
  new Request(`${API}${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: "Bearer test-assistant-bearer", "content-type": "application/json" },
  });
const pathCtx = (p: string) => ({ params: Promise.resolve({ path: p.split("/") }) });

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, "case");
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("edit → delete a claim → undo, as the assistant", () => {
  it("leaves three assistant commits in History and the page back with its claim", async () => {
    await ensureVault();
    await vaultOperation("seed: pricing", async (tx) => {
      await tx.write(PAGE, pageText({ claims: [BLUE, RED] }));
    });

    const edit = await pagePATCH(asAssistant("PATCH", `/pages/${PAGE}`, { summary: "Widget prices for the 2026 catalogue." }), pathCtx(PAGE));
    expect(edit.status).toBe(200);
    const edited = await edit.json();
    expect(edited.commit).toMatch(/^[0-9a-f]{40}$/);

    const del = await claimDELETE(asAssistant("DELETE", `/claims/${RED.id}?page=${PAGE}`), { params: Promise.resolve({ id: RED.id.split("/") }) });
    expect(del.status).toBe(200);
    const deleted = await del.json();
    expect(deleted).toMatchObject({ id: RED.id, page: PAGE, wasVerified: false });
    const afterDelete = await (await pageGET(asAssistant("GET", `/pages/${PAGE}`), pathCtx(PAGE))).json();
    expect(afterDelete.frontmatter.claims.map((c: { id: string }) => c.id)).toEqual([BLUE.id]);

    const undo = await revertPOST(asAssistant("POST", "/revert", { commit: deleted.commit, path: PAGE }));
    expect(undo.status).toBe(200);
    const undone = await undo.json();
    expect(undone).toMatchObject({ reverted: deleted.commit, changed: [PAGE] });

    const history = await (await historyGET(asAssistant("GET", `/history/${PAGE}?limit=10`), pathCtx(PAGE))).json();
    const [revert, deleteCommit, editCommit, seed] = history.commits;
    expect(revert).toMatchObject({ sha: undone.commit, author: "ClawBox assistant" });
    expect(revert.subject).toBe(`revert: ${deleted.commit.slice(0, 12)} claim: delete ${RED.id}`);
    expect(deleteCommit).toMatchObject({ sha: deleted.commit, subject: `claim: delete ${RED.id}`, author: "ClawBox assistant" });
    expect(editCommit).toMatchObject({ sha: edited.commit, subject: `edit: ${PAGE}`, author: "ClawBox assistant" });
    expect(seed).toMatchObject({ subject: "seed: pricing", author: "Prime Radiant" });

    const page = await (await pageGET(asAssistant("GET", `/pages/${PAGE}`), pathCtx(PAGE))).json();
    expect(page.frontmatter.claims.map((c: { id: string; text: string }) => [c.id, c.text])).toEqual([
      [BLUE.id, BLUE.text],
      [RED.id, RED.text],
    ]);
    expect(page.summary).toBe("Widget prices for the 2026 catalogue.");
    expect(page.lint.findings.filter((f: { blocksCommit: boolean }) => f.blocksCommit)).toEqual([]);
  });
});
