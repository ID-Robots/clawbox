/**
 * Settings → Providers → Anthropic accounts (TASK-902), on an installed box.
 *
 * More than one Anthropic account for coding runs, in the owner's order: a run
 * uses the first that can answer and moves to the next when that one hits its
 * usage limit. The unit and route suites pin the logic against a mocked store;
 * this is the same pool on the REAL one — the config store, the encrypted
 * secret store, the sign-in handoff file, the session gate — and the card the
 * owner actually sees.
 *
 *   1. The route answers the pool's state to the owner and to the MCP bearer,
 *      and 401 to anyone else.
 *   2. Every write is the owner's, from the box's own pages: no cookie, the
 *      MCP bearer and a foreign Origin are all refused 403.
 *   3. Two Claude accounts connect through the same handoff file the box's
 *      Anthropic sign-in leaves behind (`oauth/exchange` writes it; here the
 *      spec stages it, because the real exchange needs Anthropic and a person).
 *      The handoff is consumed, and the stand-in token is in no file under
 *      data/ in the clear afterwards.
 *   4. The route's own test hook sets account #1 aside at its session limit;
 *      account #2 becomes the one in use.
 *   5. The card shows both, #1 "Limited until …", #2 "In use", and the
 *      owner's move and two-tap remove work from it.
 *   6. Clearing the limit hands #1 back.
 *
 * Runs at NN=22, after settings (20) and before the desktop smoke (25), and
 * removes every account it made, so 35-mcp's `anthropic_accounts` call and
 * 80-chat see the pool the way they would have without it.
 *
 * The strings staged as "tokens" below are not credentials: nothing anywhere
 * accepts them, and no request in this spec goes to Anthropic.
 */
import { test, expect, type Page } from "@playwright/test";
import { BASE_URL, dockerExec } from "./helpers/container";
import { getStatus, loginSessionCookie, SETUP_PASSWORD } from "./helpers/setup-api";

const ROUTE = "/setup-api/anthropic/accounts";
const DATA_DIR = "/home/clawbox/clawbox/data";
/** src/lib/oauth-handoff.ts HANDOFF_TOKENS_PATH on an installed box. */
const HANDOFF_PATH = `${DATA_DIR}/oauth-device-tokens.json`;
/** src/lib/mcp-token.ts TOKEN_PATH on an installed box. */
const MCP_TOKEN_PATH = `${DATA_DIR}/.mcp-token`;

const WORK = { label: "E2E Work Max", email: "e2e-work@example.com", access: "e2e-anthropic-accounts-not-a-token-work" };
const PERSONAL = { label: "E2E Personal Max", email: "e2e-personal@example.com", access: "e2e-anthropic-accounts-not-a-token-personal" };

/** How long the test hook sets account #1 aside. Long enough that nothing resets mid-spec. */
const LIMIT_MINUTES = 90;

interface AccountView {
  id: string;
  label: string;
  email: string | null;
  kind: "oauth" | "api_key" | "login";
  status: "ok" | "limited" | "expired" | "revoked";
  limitedUntil: number | null;
  limitKind: string | null;
  priority: number;
  active: boolean;
}

interface PoolView {
  accounts: AccountView[];
  health: { total: number; healthy: number; limited: number; needsAttention: number; allLimited: boolean; nextResetAt: number | null };
  activeAccountId: string | null;
  loginAvailable: boolean;
  accountId?: string;
  interrupted?: string[];
}

test.describe.configure({ mode: "serial" });

test.describe("Anthropic account pool (TASK-902)", () => {
  let cookie = "";
  /** Accounts that were there before this spec — left exactly as they were. */
  let before: AccountView[] = [];
  const ids = { work: "", personal: "" };

  const get = async (headers: Record<string, string> = { cookie }) =>
    fetch(`${BASE_URL}${ROUTE}`, { headers });

  const pool = async (): Promise<PoolView> => {
    const res = await get();
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as PoolView;
  };

  const post = (body: Record<string, unknown>, headers: Record<string, string> = { cookie }) =>
    fetch(`${BASE_URL}${ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  /** An owner write that must succeed; answers the re-read pool. */
  const act = async (body: Record<string, unknown>): Promise<PoolView> => {
    const res = await post(body);
    expect(res.status, `${String(body.action)} → ${await res.clone().text()}`).toBe(200);
    return (await res.json()) as PoolView;
  };

  const byId = (view: PoolView, id: string) => {
    const account = view.accounts.find((a) => a.id === id);
    if (!account) throw new Error(`account ${id} is not in the pool`);
    return account;
  };

  /**
   * What `oauth/exchange` leaves once Anthropic has answered a sign-in, stamped
   * with the CONTAINER's clock: the route ages the handoff against its own.
   */
  const stageSignIn = async (who: typeof WORK) => {
    const payload = JSON.stringify({
      provider: "anthropic",
      access_token: who.access,
      refresh_token: `${who.access}-refresh`,
      expires_in: 8 * 3600,
      account_email: who.email,
    });
    await dockerExec(
      [
        "python3",
        "-c",
        "import json,os,sys,time\nos.umask(0o077)\np=json.loads(sys.argv[1])\np['createdAt']=int(time.time()*1000)\nopen(sys.argv[2],'w').write(json.dumps(p))",
        payload,
        HANDOFF_PATH,
      ],
      { user: "clawbox" },
    );
  };

  test.beforeAll(async () => {
    const status = await getStatus();
    test.skip(!status.setup_complete, "setup did not complete — the accounts card lives on a finished box");
    cookie = await loginSessionCookie();
    before = (await pool()).accounts;
  });

  test.afterAll(async () => {
    if (!cookie) return;
    for (const id of [ids.work, ids.personal].filter(Boolean)) {
      const res = await post({ action: "remove", id });
      // 404: the UI step already removed it.
      expect([200, 404]).toContain(res.status);
    }
    await dockerExec(["rm", "-f", HANDOFF_PATH], { user: "clawbox" });
  });

  test("the pool's state is the owner's and the MCP bearer's to read, and nobody else's", async () => {
    const anonymous = await get({});
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { code?: string }).code).toBe("unauthorized");

    const view = await pool();
    expect(Array.isArray(view.accounts)).toBe(true);
    expect(view.health.total).toBe(view.accounts.length);
    expect(typeof view.loginAvailable).toBe("boolean");

    // The `anthropic_accounts` MCP tool reads this route with the device bearer.
    const token = (await dockerExec(["cat", MCP_TOKEN_PATH], { user: "clawbox" })).trim();
    const asAgent = await get({ authorization: `Bearer ${token}` });
    expect(asAgent.status).toBe(200);
  });

  test("every write is the owner's, from this box's own pages", async () => {
    const noSession = await post({ action: "add_login" }, {});
    expect(noSession.status).toBe(403);
    expect(((await noSession.json()) as { code?: string }).code).toBe("owner_only");

    // The party that would spend the accounts must not be able to grant them.
    const token = (await dockerExec(["cat", MCP_TOKEN_PATH], { user: "clawbox" })).trim();
    const asAgent = await post({ action: "add_login" }, { authorization: `Bearer ${token}` });
    expect(asAgent.status).toBe(403);
    expect(((await asAgent.json()) as { code?: string }).code).toBe("owner_only");

    const foreign = await post({ action: "add_login" }, { cookie, origin: "https://attacker.example" });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { code?: string }).code).toBe("cross_origin");

    // Something that cannot be a key is refused before it could leave the box.
    const notAKey = await post({ action: "add_key", apiKey: "definitely-not-an-anthropic-key" });
    expect(notAKey.status).toBe(400);
    expect(((await notAKey.json()) as { code?: string }).code).toBe("invalid");

    const unknown = await post({ action: "make_everything_free" });
    expect(unknown.status).toBe(400);

    // None of that changed the pool.
    expect((await pool()).accounts.map((a) => a.id)).toEqual(before.map((a) => a.id));
  });

  test("two Claude accounts connect through the sign-in handoff, in order, with no token kept in the clear", async () => {
    await stageSignIn(WORK);
    const first = await act({ action: "connect_oauth", label: WORK.label });
    ids.work = first.accountId ?? "";
    expect(ids.work).not.toBe("");
    // Consumed once stored: a second connect cannot replay the same sign-in.
    expect(await dockerExec(["bash", "-c", `test -e ${HANDOFF_PATH} && echo present || echo gone`], { user: "clawbox" })).toMatch(/gone/);
    const replay = await post({ action: "connect_oauth", label: "replayed" });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { code?: string }).code).toBe("no_sign_in");

    await stageSignIn(PERSONAL);
    const second = await act({ action: "connect_oauth", label: PERSONAL.label });
    ids.personal = second.accountId ?? "";
    expect(ids.personal).not.toBe("");
    expect(ids.personal).not.toBe(ids.work);

    const view = await pool();
    const work = byId(view, ids.work);
    const personal = byId(view, ids.personal);
    expect(work).toMatchObject({ label: WORK.label, email: WORK.email, kind: "oauth", status: "ok" });
    expect(personal).toMatchObject({ label: PERSONAL.label, email: PERSONAL.email, kind: "oauth", status: "ok" });
    // New accounts join at the END of the owner's order.
    expect(personal.priority).toBe(work.priority + 1);
    expect(view.accounts.length).toBe(before.length + 2);
    if (!before.some((a) => a.status === "ok")) {
      expect(view.activeAccountId).toBe(ids.work);
    }

    // The answer carries no credential in any field …
    const body = JSON.stringify(view);
    expect(body).not.toContain(WORK.access);
    expect(body).not.toContain(PERSONAL.access);
    for (const account of view.accounts) {
      expect(Object.keys(account).filter((k) => /token|secret|key|credential|password/i.test(k))).toEqual([]);
    }
    // … and the box keeps it only encrypted: no file under data/ holds it in
    // the clear (config.json names the account, the secret store seals it).
    const clear = await dockerExec(
      ["bash", "-c", `grep -rlF -e "$0" -e "$1" ${DATA_DIR} 2>/dev/null || true`, WORK.access, PERSONAL.access],
      { user: "clawbox" },
    );
    expect(clear.trim()).toBe("");
  });

  test("a usage limit sets account #1 aside and account #2 takes over", async () => {
    const startedAt = Date.now();
    const hit = await act({ action: "simulate_limit", id: ids.work, minutes: LIMIT_MINUTES });
    // No coding run is live, so the hook only marks the account.
    expect(hit.interrupted).toEqual([]);

    const view = await pool();
    const work = byId(view, ids.work);
    expect(work.status).toBe("limited");
    expect(work.limitKind).toBe("session");
    expect(work.limitedUntil).not.toBeNull();
    // Within a few minutes of the asked-for window, allowing for clock skew
    // between the runner and the container.
    expect(Math.abs((work.limitedUntil ?? 0) - (startedAt + LIMIT_MINUTES * 60_000))).toBeLessThan(5 * 60_000);
    expect(view.health.allLimited).toBe(false);
    expect(view.health.limited).toBeGreaterThanOrEqual(1);
    if (!before.some((a) => a.status === "ok")) {
      expect(view.activeAccountId).toBe(ids.personal);
      expect(byId(view, ids.personal).active).toBe(true);
    }
  });

  test("Settings → Providers shows both accounts, the limited one with its reset time, and the owner's controls work", async ({ page }) => {
    const card = await openAccountsCard(page);

    const workRow = card.getByTestId(`anthropic-account-${ids.work}`);
    const personalRow = card.getByTestId(`anthropic-account-${ids.personal}`);
    await expect(workRow.getByTestId(`anthropic-account-label-${ids.work}`)).toHaveText(WORK.label);
    await expect(personalRow.getByTestId(`anthropic-account-label-${ids.personal}`)).toHaveText(PERSONAL.label);
    await expect(workRow.getByTestId(`anthropic-account-status-${ids.work}`)).toContainText(/Limited until \S/);
    if (!before.some((a) => a.status === "ok")) {
      await expect(personalRow.getByTestId(`anthropic-account-status-${ids.personal}`)).toContainText("In use");
    }
    await expect(card.getByTestId("anthropic-accounts-summary")).toHaveText(/^\d+ of \d+ ready$/);
    // The kind, in words; never a token.
    await expect(workRow).toContainText("Claude account");
    await expect(card).not.toContainText(WORK.access);

    // Move #1 below #2 — the order is the owner's and it is kept on the box.
    await workRow.getByRole("button", { name: "Move down" }).click();
    await expect.poll(async () => {
      const view = await pool();
      return byId(view, ids.personal).priority < byId(view, ids.work).priority;
    }).toBe(true);

    // Remove takes two taps: the first only arms it.
    const remove = personalRow.getByTestId(`anthropic-account-remove-${ids.personal}`);
    await remove.click();
    await expect(remove).toHaveText("Tap again to remove");
    expect((await pool()).accounts.some((a) => a.id === ids.personal)).toBe(true);
    await remove.click();
    await expect(personalRow).toHaveCount(0);
    expect((await pool()).accounts.some((a) => a.id === ids.personal)).toBe(false);
    ids.personal = "";
  });

  test("clearing the limit hands account #1 back", async () => {
    const view = await act({ action: "clear_limit", id: ids.work });
    const work = byId(view, ids.work);
    expect(work.status).toBe("ok");
    expect(work.limitedUntil).toBeNull();
    if (!before.some((a) => a.status === "ok")) {
      expect(view.activeAccountId).toBe(ids.work);
      expect(view.health.allLimited).toBe(false);
    }
  });
});

/** Sign in if needed, open Settings from the launcher and go to Providers. Answers the accounts card. */
async function openAccountsCard(page: Page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  if (page.url().includes("/login")) {
    await page.fill('input[type="password"]', SETUP_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 }),
      page.click('button[type="submit"]'),
    ]);
  }
  await expect(page.getByTestId("desktop-root")).toBeVisible({ timeout: 15_000 });

  // A prior spec's contextual chat prompt can sit above the desktop.
  const chatPopup = page.getByTestId("chat-popup");
  if (await chatPopup.isVisible()) {
    await chatPopup.getByTestId("chat-popup-close").click();
    await expect(chatPopup).toHaveCount(0);
  }

  await page.locator('[data-testid="shelf-launcher-button"]').filter({ visible: true }).click();
  await page.getByTestId("app-launcher").getByRole("button", { name: /settings/i }).click();
  const settingsWindow = page.getByTestId("chrome-window-settings");
  await expect(settingsWindow).toBeVisible({ timeout: 10_000 });
  await settingsWindow.getByRole("navigation").getByRole("button", { name: /Providers/ }).click();

  const card = settingsWindow.getByTestId("anthropic-accounts");
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  return card;
}
