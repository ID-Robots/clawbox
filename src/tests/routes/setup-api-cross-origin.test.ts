import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * TASK-2813 (4.4.1): every state-changing setup-api route the box's own pages
 * call refuses a request from another origin. The owner's session cookie is
 * SameSite=Lax, so a page on another origin of the same site (another box's
 * `*.clawbox.tech` name) gets it attached to its POST; `isSameOriginRequest`
 * (src/lib/same-origin.ts) is what turns that request away.
 *
 * The coding-agent lifecycle routes check the origin inside the run factory's
 * `act` (as coding-agent/message does), so the session gate and the run lookup
 * are stubbed to reach it; every other route checks it first in the handler,
 * before anything is read or written.
 */
vi.mock("@/lib/route-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-auth")>()),
  requireSession: vi.fn(async () => null),
}));
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  getRun: vi.fn(() => ({ id: "run-1", source: "agent", status: "running" })),
}));

type Handler = (request: Request, context: { params: Promise<Record<string, string[]>> }) => Promise<Response> | Response;

/** Next.js hands a catch-all route its params; the routes without one ignore it. */
const CONTEXT = { params: Promise.resolve({ path: ["placeholder.txt"] }) };

const ROUTES: Array<[string, string[], () => Promise<Record<string, unknown>>]> = [
  ["ai-models/clawai/poll", ["POST"], () => import("@/app/setup-api/ai-models/clawai/poll/route")],
  ["ai-models/clawai/sign-out", ["POST"], () => import("@/app/setup-api/ai-models/clawai/sign-out/route")],
  ["ai-models/clawai/start", ["POST"], () => import("@/app/setup-api/ai-models/clawai/start/route")],
  ["ai-models/configure", ["POST"], () => import("@/app/setup-api/ai-models/configure/route")],
  ["ai-models/oauth/device-poll", ["POST"], () => import("@/app/setup-api/ai-models/oauth/device-poll/route")],
  ["ai-models/oauth/device-start", ["POST"], () => import("@/app/setup-api/ai-models/oauth/device-start/route")],
  ["ai-models/oauth/exchange", ["POST"], () => import("@/app/setup-api/ai-models/oauth/exchange/route")],
  ["ai-models/oauth/start", ["POST"], () => import("@/app/setup-api/ai-models/oauth/start/route")],
  ["ai-models/subscription-link", ["DELETE"], () => import("@/app/setup-api/ai-models/subscription-link/route")],
  ["apps/public-link", ["POST", "PATCH", "DELETE"], () => import("@/app/setup-api/apps/public-link/route")],
  ["apps/settings", ["POST"], () => import("@/app/setup-api/apps/settings/route")],
  ["background-jobs", ["POST"], () => import("@/app/setup-api/background-jobs/route")],
  ["browser/manage", ["POST"], () => import("@/app/setup-api/browser/manage/route")],
  ["chat/attachments", ["POST"], () => import("@/app/setup-api/chat/attachments/route")],
  ["chat/history", ["DELETE"], () => import("@/app/setup-api/chat/history/route")],
  ["chat/images", ["POST"], () => import("@/app/setup-api/chat/images/route")],
  ["chat/model", ["POST"], () => import("@/app/setup-api/chat/model/route")],
  ["clawkeep/memory/enable", ["POST"], () => import("@/app/setup-api/clawkeep/memory/enable/route")],
  ["clawkeep/memory/index", ["POST", "DELETE"], () => import("@/app/setup-api/clawkeep/memory/index/route")],
  ["clawkeep/memory/reset", ["POST"], () => import("@/app/setup-api/clawkeep/memory/reset/route")],
  ["clawkeep/memory/schedule", ["PUT"], () => import("@/app/setup-api/clawkeep/memory/schedule/route")],
  ["clawkeep/memory/sources", ["POST", "DELETE"], () => import("@/app/setup-api/clawkeep/memory/sources/route")],
  ["clawkeep/pair/poll", ["POST"], () => import("@/app/setup-api/clawkeep/pair/poll/route")],
  ["clawkeep/pair/start", ["POST"], () => import("@/app/setup-api/clawkeep/pair/start/route")],
  ["clawkeep/schedule", ["PUT"], () => import("@/app/setup-api/clawkeep/schedule/route")],
  ["coding-agent/browse", ["POST"], () => import("@/app/setup-api/coding-agent/browse/route")],
  ["coding-agent/draft", ["POST", "DELETE"], () => import("@/app/setup-api/coding-agent/draft/route")],
  ["coding-agent/enable", ["POST"], () => import("@/app/setup-api/coding-agent/enable/route")],
  ["coding-agent/git", ["DELETE", "POST"], () => import("@/app/setup-api/coding-agent/git/route")],
  ["coding-agent/pause", ["POST"], () => import("@/app/setup-api/coding-agent/pause/route")],
  ["coding-agent/reset", ["POST"], () => import("@/app/setup-api/coding-agent/reset/route")],
  ["coding-agent/run-notes", ["PUT", "DELETE"], () => import("@/app/setup-api/coding-agent/run-notes/route")],
  ["coding-agent/runs", ["DELETE"], () => import("@/app/setup-api/coding-agent/runs/route")],
  ["coding-agent/start", ["POST"], () => import("@/app/setup-api/coding-agent/start/route")],
  ["coding-agent/tree", ["PUT"], () => import("@/app/setup-api/coding-agent/tree/route")],
  ["coding-agent/worktree", ["POST"], () => import("@/app/setup-api/coding-agent/worktree/route")],
  ["discord/configure", ["POST"], () => import("@/app/setup-api/discord/configure/route")],
  ["email/chat-approval", ["POST", "DELETE"], () => import("@/app/setup-api/email/chat-approval/route")],
  ["email/pending", ["POST"], () => import("@/app/setup-api/email/pending/route")],
  ["email/test", ["POST"], () => import("@/app/setup-api/email/test/route")],
  ["files", ["POST", "PUT"], () => import("@/app/setup-api/files/route")],
  ["files/[...path]", ["PUT", "DELETE"], () => import("@/app/setup-api/files/[...path]/route")],
  ["harness/select", ["POST"], () => import("@/app/setup-api/harness/select/route")],
  ["hermes/chat", ["DELETE", "POST"], () => import("@/app/setup-api/hermes/chat/route")],
  ["hermes/chat/clarify", ["POST"], () => import("@/app/setup-api/hermes/chat/clarify/route")],
  ["hermes/clawai", ["POST"], () => import("@/app/setup-api/hermes/clawai/route")],
  ["hermes/compress", ["POST"], () => import("@/app/setup-api/hermes/compress/route")],
  ["hermes/oauth/cancel", ["DELETE"], () => import("@/app/setup-api/hermes/oauth/cancel/route")],
  ["hermes/oauth/start", ["POST"], () => import("@/app/setup-api/hermes/oauth/start/route")],
  ["hermes/oauth/submit", ["POST"], () => import("@/app/setup-api/hermes/oauth/submit/route")],
  ["hermes/provider-key", ["POST"], () => import("@/app/setup-api/hermes/provider-key/route")],
  ["hermes/skills/secrets", ["POST"], () => import("@/app/setup-api/hermes/skills/secrets/route")],
  ["install/run-step", ["POST"], () => import("@/app/setup-api/install/run-step/route")],
  ["job-alerts", ["POST"], () => import("@/app/setup-api/job-alerts/route")],
  ["llamacpp/install", ["POST"], () => import("@/app/setup-api/llamacpp/install/route")],
  ["local-ai", ["POST"], () => import("@/app/setup-api/local-ai/route")],
  ["local-ai/exclusive", ["POST"], () => import("@/app/setup-api/local-ai/exclusive/route")],
  ["local-ai/external/select", ["POST"], () => import("@/app/setup-api/local-ai/external/select/route")],
  ["local-models", ["POST"], () => import("@/app/setup-api/local-models/route")],
  ["pets/select", ["POST"], () => import("@/app/setup-api/pets/select/route")],
  ["portal/start", ["POST"], () => import("@/app/setup-api/portal/start/route")],
  ["portal/stop", ["POST"], () => import("@/app/setup-api/portal/stop/route")],
  ["providers/default", ["POST"], () => import("@/app/setup-api/providers/default/route")],
  ["providers/enabled", ["POST"], () => import("@/app/setup-api/providers/enabled/route")],
  ["providers/sign-out", ["POST"], () => import("@/app/setup-api/providers/sign-out/route")],
  ["setup/complete", ["POST"], () => import("@/app/setup-api/setup/complete/route")],
  ["setup/progress", ["POST"], () => import("@/app/setup-api/setup/progress/route")],
  ["setup/reset", ["POST"], () => import("@/app/setup-api/setup/reset/route")],
  ["system/credentials", ["POST"], () => import("@/app/setup-api/system/credentials/route")],
  ["system/credentials/verify", ["POST"], () => import("@/app/setup-api/system/credentials/verify/route")],
  ["system/desktop", ["POST"], () => import("@/app/setup-api/system/desktop/route")],
  ["system/hostname", ["POST"], () => import("@/app/setup-api/system/hostname/route")],
  ["system/power/approval", ["POST"], () => import("@/app/setup-api/system/power/approval/route")],
  ["system/power-profile", ["POST"], () => import("@/app/setup-api/system/power-profile/route")],
  ["telegram/configure", ["POST"], () => import("@/app/setup-api/telegram/configure/route")],
  ["telegram/pairing", ["POST"], () => import("@/app/setup-api/telegram/pairing/route")],
  ["telegram/streaming", ["POST"], () => import("@/app/setup-api/telegram/streaming/route")],
  ["tunnel/disable", ["POST"], () => import("@/app/setup-api/tunnel/disable/route")],
  ["tunnel/enable", ["POST"], () => import("@/app/setup-api/tunnel/enable/route")],
  ["update/dismiss", ["POST"], () => import("@/app/setup-api/update/dismiss/route")],
  ["update/dismissal", ["POST"], () => import("@/app/setup-api/update/dismissal/route")],
  ["update/openclaw", ["POST"], () => import("@/app/setup-api/update/openclaw/route")],
  ["update/run", ["POST"], () => import("@/app/setup-api/update/run/route")],
  ["vnc/clipboard", ["POST"], () => import("@/app/setup-api/vnc/clipboard/route")],
  ["vnc/resolution", ["POST"], () => import("@/app/setup-api/vnc/resolution/route")],
  ["whatsapp/configure", ["POST"], () => import("@/app/setup-api/whatsapp/configure/route")],
  ["whatsapp/pair", ["POST", "DELETE"], () => import("@/app/setup-api/whatsapp/pair/route")],
  ["whatsapp/unpair", ["POST"], () => import("@/app/setup-api/whatsapp/unpair/route")],
  ["wifi/connect", ["POST"], () => import("@/app/setup-api/wifi/connect/route")],
  ["wifi/scan", ["POST"], () => import("@/app/setup-api/wifi/scan/route")],
  ["wifi/update", ["POST"], () => import("@/app/setup-api/wifi/update/route")],
];

const CASES = ROUTES.flatMap(([route, methods, load]) => methods.map((method) => ({ route, method, load })));

function foreignRequest(route: string, method: string, headers: Record<string, string>): Request {
  const body = method === "GET" || method === "HEAD" ? undefined : JSON.stringify({ runId: "run-1" });
  return new Request(`http://clawbox.local/setup-api/${route}?runId=run-1`, {
    method,
    headers: { host: "clawbox.local", "content-type": "text/plain", cookie: "clawbox_session=placeholder", ...headers },
    body,
  });
}

describe("state-changing setup-api routes refuse another origin", () => {
  beforeAll(() => {
    // Nothing below may reach the network: a refused request never gets that far.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected fetch"); }));
  });

  it.each(CASES)("$method /setup-api/$route: a foreign Origin gets 403 cross_origin", async ({ route, method, load }) => {
    const handler = (await load())[method] as Handler;
    expect(typeof handler).toBe("function");
    const res = await handler(foreignRequest(route, method, { origin: "https://other-box.clawbox.tech" }), CONTEXT);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
  }, 30_000);

  it.each(CASES)("$method /setup-api/$route: Sec-Fetch-Site same-site without an Origin gets 403", async ({ route, method, load }) => {
    const handler = (await load())[method] as Handler;
    const res = await handler(foreignRequest(route, method, { "sec-fetch-site": "same-site" }), CONTEXT);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
  }, 30_000);
});
