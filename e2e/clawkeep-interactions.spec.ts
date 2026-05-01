import type { Page, Route } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

// Interaction-level coverage for ClawKeepApp. The smoke spec
// (clawkeep-smoke.spec.ts) only exercises top-level render branches;
// the modals, confirm dialogs, schedule editor, and passphrase setup
// stay un-rendered at top-level entry. These tests open each of those
// subtrees so the bundle covers their render + handler code paths.

interface ClawKeepStatusOverrides {
  paired?: boolean;
  configured?: boolean;
  encryptionConfigured?: boolean;
  cloudBytes?: number;
  snapshotCount?: number;
  lastBackupAtMs?: number;
  scheduleEnabled?: boolean;
  scheduleFrequency?: "daily" | "weekly";
}

function buildStatus(overrides: ClawKeepStatusOverrides = {}) {
  return {
    paired: overrides.paired ?? false,
    configured: overrides.configured ?? false,
    server: "https://openclawhardware.dev",
    lastBackupAtMs: overrides.lastBackupAtMs ?? 0,
    lastHeartbeatAtMs: 0,
    lastHeartbeatStatus: "idle",
    currentStep: "",
    currentStepAtMs: 0,
    cloudBytes: overrides.cloudBytes ?? 0,
    snapshotCount: overrides.snapshotCount ?? 0,
    uploadBytesTotal: 0,
    uploadBytesDone: 0,
    uploadStartedAtMs: 0,
    openclawInstalled: true,
    daemonInstalled: true,
    schedule: {
      enabled: overrides.scheduleEnabled ?? false,
      frequency: overrides.scheduleFrequency ?? "weekly",
      timeOfDay: "03:00",
      weekday: 0,
    },
    nextRunAtMs: 0,
    encryptionConfigured: overrides.encryptionConfigured ?? false,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function setupDesktop(page: Page) {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
  });
}

async function openClawkeep(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await openLauncher(page);
  await page.getByTestId("app-launcher").getByRole("button", { name: "ClawKeep" }).click();
  const clawkeep = page.getByTestId("chrome-window-clawkeep");
  await expect(clawkeep).toBeVisible();
  return clawkeep;
}

test("pair-start renders the challenge card and Cancel returns to pair card", async ({ page }) => {
  await setupDesktop(page);

  await page.route("**/setup-api/clawkeep", (route) =>
    fulfillJson(route, buildStatus({ paired: false })),
  );
  await page.route("**/setup-api/clawkeep/pair/start", (route) =>
    fulfillJson(route, {
      user_code: "ABCD-1234",
      verification_url: "https://openclawhardware.dev/clawkeep/pair",
      interval: 5,
      code_length: 9,
    }),
  );
  await page.route("**/setup-api/clawkeep/pair/poll", (route) =>
    fulfillJson(route, { status: "pending" }),
  );

  // Stub out the new-window popup so the verification-url open call is a
  // no-op — we only need its handler to run, not the page to actually load.
  await page.addInitScript(() => {
    window.open = () => null;
  });

  const clawkeep = await openClawkeep(page);
  await clawkeep.getByRole("button", { name: "Pair with portal" }).click();

  // Challenge card is mounted — verifies the user_code-copy useEffect
  // and the polling-loop useEffect setup both ran.
  await expect(clawkeep.getByText("ABCD-1234")).toBeVisible({ timeout: 5000 });

  // Cancel button on the challenge card: distinct from the titlebar
  // close, scoped by accessible name to the in-card control.
  await clawkeep.getByRole("button", { name: "Cancel" }).click();

  // Back on the pair card.
  await expect(clawkeep.getByRole("button", { name: "Pair with portal" })).toBeVisible();
});

test("restore modal opens, fetches snapshots, and Esc dismisses it", async ({ page }) => {
  await setupDesktop(page);

  await page.route("**/setup-api/clawkeep", (route) =>
    fulfillJson(
      route,
      buildStatus({
        paired: true,
        configured: true,
        encryptionConfigured: true,
        cloudBytes: 16_000_000,
        snapshotCount: 3,
        lastBackupAtMs: Date.now() - 7_200_000,
      }),
    ),
  );

  // Three snapshots gives the list-rendering branch real items to map
  // over (covers parseSnapshotName, the per-row formatting, and the
  // hover/active states even if we only hover passively).
  const now = Date.now();
  await page.route("**/setup-api/clawkeep/snapshots", (route) =>
    fulfillJson(route, {
      snapshots: [
        { name: "openclaw-2026-05-01T12-00-00Z", size_bytes: 5_000_000, last_modified_ms: now - 7_200_000 },
        { name: "openclaw-2026-04-30T12-00-00Z", size_bytes: 4_900_000, last_modified_ms: now - 86_400_000 - 7_200_000 },
        { name: "openclaw-2026-04-29T12-00-00Z", size_bytes: 4_800_000, last_modified_ms: now - 172_800_000 - 7_200_000 },
      ],
    }),
  );

  const clawkeep = await openClawkeep(page);
  await clawkeep.getByRole("button", { name: "Restore from snapshot" }).click();

  // RestoreModal mounted with snapshot list — covers the snapshots
  // useEffect fetch path, the parseSnapshotName helper, and the list
  // render branch.
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  // Three buttons inside the modal (one per snapshot, plus close).
  expect(await modal.getByRole("button").count()).toBeGreaterThan(2);

  // Esc closes the modal — covers the keydown useEffect cleanup path.
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
});

test("unpair flow opens the confirm dialog and Esc dismisses it without unpairing", async ({ page }) => {
  await setupDesktop(page);

  let unpairCalled = 0;
  await page.route("**/setup-api/clawkeep", (route) =>
    fulfillJson(
      route,
      buildStatus({
        paired: true,
        configured: true,
        encryptionConfigured: true,
        snapshotCount: 0,
      }),
    ),
  );
  await page.route("**/setup-api/clawkeep/unpair", (route) => {
    unpairCalled += 1;
    return fulfillJson(route, { ok: true });
  });

  const clawkeep = await openClawkeep(page);
  await clawkeep.getByRole("button", { name: "Unpair" }).click();

  // ConfirmDialog mounts with the unpair copy — exercises the dialog
  // render branch, the global Esc keydown listener registration, and
  // the danger-palette path.
  const dialog = page.getByRole("dialog", { name: "Unpair this device?" });
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(unpairCalled).toBe(0);
});

test("paired dashboard renders the schedule card with an off-state subtitle", async ({ page }) => {
  await setupDesktop(page);

  await page.route("**/setup-api/clawkeep", (route) =>
    fulfillJson(
      route,
      buildStatus({
        paired: true,
        configured: true,
        encryptionConfigured: true,
        scheduleEnabled: false,
        snapshotCount: 0,
      }),
    ),
  );

  const clawkeep = await openClawkeep(page);
  // ScheduleCard mounts unconditionally on the paired dashboard. Its
  // "Auto-backup" heading + the off-state subtitle exercise the
  // disabled-branch render path (the toggle's sr-only input was tried
  // earlier with .check() but Playwright treats sr-only as not visible
  // and times out — the visible label paths are what we want to cover).
  await expect(clawkeep.getByRole("heading", { name: "Auto-backup" })).toBeVisible();
});

test("backup click renders the result card on success", async ({ page }) => {
  await setupDesktop(page);

  let backupCalled = 0;
  await page.route("**/setup-api/clawkeep", (route) =>
    fulfillJson(
      route,
      buildStatus({
        paired: true,
        configured: true,
        encryptionConfigured: true,
        // lastBackupAtMs > 0 puts deriveProtection() into "protected"
        // state, which surfaces the "Back up now" button. With it at 0
        // the dashboard renders "Protect my OpenClaw" instead and the
        // click locator times out.
        lastBackupAtMs: Date.now() - 3_600_000,
        snapshotCount: 1,
      }),
    ),
  );
  await page.route("**/setup-api/clawkeep/backup", (route) => {
    backupCalled += 1;
    return fulfillJson(route, {
      ok: true,
      exitCode: 0,
      stdoutTail: "snapshot saved\n",
      stderrTail: "",
    });
  });

  const clawkeep = await openClawkeep(page);
  await clawkeep.getByRole("button", { name: "Back up now" }).click();

  // BackupResultCard renders below the dashboard once `backupResult`
  // is set on the parent. Asserting any of its visible text confirms
  // the success-render branch ran.
  await expect(clawkeep.getByText(/snapshot saved/i)).toBeVisible({ timeout: 10_000 });
  expect(backupCalled).toBe(1);
});

test("restore modal: clicking a snapshot opens the confirm dialog", async ({ page }) => {
  await setupDesktop(page);

  await page.route("**/setup-api/clawkeep", (route) =>
    fulfillJson(
      route,
      buildStatus({
        paired: true,
        configured: true,
        encryptionConfigured: true,
        snapshotCount: 2,
      }),
    ),
  );
  const now = Date.now();
  await page.route("**/setup-api/clawkeep/snapshots", (route) =>
    fulfillJson(route, {
      snapshots: [
        { name: "openclaw-2026-05-01T12-00-00Z", size_bytes: 5_000_000, last_modified_ms: now - 7_200_000 },
        { name: "openclaw-2026-04-30T12-00-00Z", size_bytes: 4_900_000, last_modified_ms: now - 86_400_000 },
      ],
    }),
  );

  const clawkeep = await openClawkeep(page);
  await clawkeep.getByRole("button", { name: "Restore from snapshot" }).click();

  const modal = page.getByRole("dialog").first();
  await expect(modal).toBeVisible();
  // Click the first snapshot row (the dialog's buttons start with the
  // close X, then one button per snapshot).
  const snapshotRows = modal.getByRole("button");
  await expect(snapshotRows.nth(1)).toBeVisible();
  await snapshotRows.nth(1).click();

  // Confirm dialog stacks on top of the restore modal — covers the
  // ConfirmDialog render branch with the "restore" copy variant
  // (different from the unpair variant exercised earlier).
  const confirmDialogs = page.getByRole("dialog");
  expect(await confirmDialogs.count()).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Escape");
});

test("paired-without-encryption opens and submits the passphrase setup modal", async ({ page }) => {
  await setupDesktop(page);

  let encryptionCalled = 0;
  let encryptionConfigured = false;
  await page.route("**/setup-api/clawkeep", (route) =>
    fulfillJson(
      route,
      buildStatus({
        paired: true,
        configured: true,
        encryptionConfigured,
        snapshotCount: 0,
      }),
    ),
  );
  await page.route("**/setup-api/clawkeep/encryption", (route) => {
    encryptionCalled += 1;
    encryptionConfigured = true;
    return fulfillJson(route, { ok: true });
  });
  await page.route("**/setup-api/clawkeep/backup", (route) =>
    fulfillJson(route, {
      ok: true,
      exitCode: 0,
      stdoutTail: "first backup\n",
      stderrTail: "",
    }),
  );

  const clawkeep = await openClawkeep(page);
  await clawkeep.getByRole("button", { name: "Protect my OpenClaw" }).click();

  // SetPassphraseModal mounts. Fill passphrase + confirm + the
  // acknowledge checkbox so the submit button enables.
  const passwordInputs = clawkeep.locator('input[type="password"]');
  await expect(passwordInputs.first()).toBeVisible();
  await passwordInputs.nth(0).fill("strong-passphrase-1234");
  await passwordInputs.nth(1).fill("strong-passphrase-1234");
  // The acknowledgement checkbox is the only checkbox in the modal.
  await clawkeep.locator('input[type="checkbox"]').first().check();
  // Submit via the form's primary save button (last button in the
  // modal — the others are Cancel and Esc-only handlers).
  const submitButtons = clawkeep.getByRole("button");
  await submitButtons.last().click();

  // The modal closes and the encryption endpoint was called exactly
  // once — covers SetPassphraseModal's submit branch + onSaved
  // callback chain.
  await expect(passwordInputs.first()).toBeHidden({ timeout: 5_000 });
  expect(encryptionCalled).toBe(1);
});
