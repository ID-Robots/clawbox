import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";
import {
  PRIME_RADIANT_BASE_URL,
  PRIME_RADIANT_E2E_DIR,
  PRIME_RADIANT_E2E_SECRET,
} from "./helpers/prime-radiant-server";

// Prime Radiant end to end, against a REAL server: the desktop's own routes
// stay mocked as in every other spec, while `/setup-api/prime-radiant/**`
// goes through to the test-mode server playwright.config.ts starts for this
// spec (deterministic model and embedder, every root in a temp directory —
// see helpers/prime-radiant-server.ts). Open the app (which makes the vault),
// drop three synthetic documents, read the pages in Browse, run the nightly
// pass so the contradiction between two of them becomes a review item, settle
// it in Review and find the verified claim on its page.

const FIXTURES = path.join(__dirname, "fixtures", "prime-radiant");
const DOCUMENTS = ["warehouse-handbook.md", "inventory-audit.md", "office-guide.md"];
const TITLES = [
  "Acme Widgets Ltd warehouse handbook",
  "Acme Widgets Ltd inventory audit",
  "Acme Widgets Ltd office guide",
];
const WINNER = "The Acme Widgets warehouse stores 950 crates of sprockets.";

/** The secret the test server signs sessions with: the one on its disk, or one we put there first. */
function sessionSecret(): string {
  try {
    const existing = fs.readFileSync(PRIME_RADIANT_E2E_SECRET, "utf-8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // not written yet
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(PRIME_RADIANT_E2E_SECRET), { recursive: true });
  fs.writeFileSync(PRIME_RADIANT_E2E_SECRET, secret, { mode: 0o600 });
  return secret;
}

/** An owner session cookie, minted the way `createSessionCookie` mints one. */
function ownerCookie(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, gen: 0 })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

async function openPrimeRadiant(page: Page) {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    chatFacts: { onboardingArmed: false },
  });
  // Registered after the mocks, so it is asked first: Prime Radiant's routes
  // reach the server.
  await page.route("**/setup-api/prime-radiant/**", (route) => route.continue());
  await page.context().addCookies([{ name: "clawbox_session", value: ownerCookie(), url: PRIME_RADIANT_BASE_URL }]);

  await page.goto(`${PRIME_RADIANT_BASE_URL}/`);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  // Pinned on the shelf beside Memory Shard.
  await page.getByTestId("shelf-app-prime-radiant").click();
  const window = page.getByTestId("chrome-window-prime-radiant");
  await expect(window).toBeVisible();
  const app = window.getByTestId("prime-radiant-app");
  // A fresh box: the app sends POST init and lands on Browse with no pages.
  await expect(app.getByTestId("prime-radiant-tab-browse")).toBeVisible({ timeout: 30_000 });
  await expect(app.getByTestId("prime-radiant-empty")).toBeVisible();
  return app;
}

test.describe("Prime Radiant", () => {
  // One server, one vault: two tests of this file at once would wipe each
  // other's vault. CI runs one worker; locally, `--repeat-each` needs
  // `--workers=1` for the same reason.
  test.describe.configure({ mode: "serial" });

  test.beforeEach(() => {
    // Every attempt (a retry included) starts on a box with no vault, so
    // the nightly pass is a first night and judges every claim. The server
    // reads PRIME_RADIANT_DIR per call, so removing it is a fresh box.
    fs.rmSync(PRIME_RADIANT_E2E_DIR, { recursive: true, force: true });
  });

  test("ingest three documents, settle the contradiction, see the verified claim", async ({ page }) => {
    test.setTimeout(180_000);
    const app = await openPrimeRadiant(page);

    // ── ingest: three dropped documents, the stub model writes a page each
    await app.getByTestId("prime-radiant-tab-ingest").click();
    await app.getByTestId("prime-radiant-file-input").setInputFiles(DOCUMENTS.map((name) => path.join(FIXTURES, name)));
    const job = app.getByTestId("prime-radiant-ingest-job").first();
    await expect(job).toContainText("Finished", { timeout: 60_000 });
    await expect(job).toContainText("3 pages");

    // ── browse: the three pages, and one of them in full
    await app.getByTestId("prime-radiant-tab-browse").click();
    const rows = app.getByTestId("prime-radiant-page-row");
    await expect(rows).toHaveCount(3);
    for (const title of TITLES) await expect(rows.filter({ hasText: title })).toHaveCount(1);
    await rows.filter({ hasText: TITLES[0] }).click();
    await expect(app.getByTestId("prime-radiant-claim").filter({ hasText: "1200 crates" })).toBeVisible();
    await expect(app.getByTestId("prime-radiant-sources")).toBeVisible();
    await app.getByTestId("prime-radiant-page-back").click();

    // ── the nightly pass: the hash embedder pairs the two warehouse claims,
    // the stub judge calls 1200 against 950 a contradiction
    await app.getByTestId("prime-radiant-tab-settings").click();
    await app.getByTestId("prime-radiant-nightly-run").click();
    await expect(app.getByTestId("prime-radiant-nightly-run-row").first()).toHaveAttribute(
      "data-status",
      /^(merged|held|nothing)$/,
      { timeout: 60_000 },
    );

    // ── review: one contradiction, two candidates; keep the audit's figure
    await app.getByTestId("prime-radiant-tab-review").click();
    const item = app.getByTestId("prime-radiant-review-item").filter({ has: page.getByTestId("prime-radiant-review-candidate").filter({ hasText: WINNER }) });
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute("data-kind", "contradiction");
    const candidates = item.getByTestId("prime-radiant-review-candidate");
    await expect(candidates).toHaveCount(2);
    await expect(candidates.filter({ hasText: "1200 crates" })).toHaveCount(1);
    const claimId = (await item.getByTestId("prime-radiant-review-claim").textContent())?.trim() ?? "";
    expect(claimId).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/);
    await candidates.filter({ hasText: WINNER }).getByTestId("prime-radiant-review-pick").click();
    await expect(app.getByTestId("prime-radiant-review-item").filter({ hasText: claimId })).toHaveCount(0);

    // ── browse again: the page carrying the claim is verified, the claim
    // holds the picked text and says who verified it; the losing figure is gone
    await app.getByTestId("prime-radiant-tab-browse").click();
    const verifiedRow = rows.filter({ has: page.getByRole("img", { name: "Verified" }) });
    await expect(verifiedRow).toHaveCount(1);
    await verifiedRow.click();
    const claim = app.getByTestId("prime-radiant-claim").filter({ hasText: claimId });
    await expect(claim).toContainText(WINNER);
    await expect(claim.getByRole("img", { name: "Verified" })).toBeVisible();
    await expect(claim).toContainText("Verified by");
    await app.getByTestId("prime-radiant-page-back").click();
    for (const title of TITLES) {
      await rows.filter({ hasText: title }).click();
      await expect(app.getByTestId("prime-radiant-claims")).toBeVisible();
      await expect(app.getByTestId("prime-radiant-claim").filter({ hasText: "1200 crates" })).toHaveCount(0);
      await app.getByTestId("prime-radiant-page-back").click();
    }
    await expect(app.getByTestId("prime-radiant-counts")).toContainText("Verified pages: 1");
  });
});
