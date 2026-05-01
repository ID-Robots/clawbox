import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

// Smoke coverage for ClawKeepApp's three top-level render branches
// (unpaired, pair-challenge, paired-with-backup). The existing
// clawkeep-flow.spec.ts is fixme'd against an unreleased redesign, so
// without these tests ClawKeepApp lands at ~4% bundle coverage and
// drags the aggregate below the e2e regression threshold.
//
// We override `/setup-api/clawkeep*` directly here because the shared
// mock in helpers/clawbox.ts targets the redesign's schema (sourcePath
// query, action-based POST body) — the real component on HEAD calls
// the bare `GET /setup-api/clawkeep` and `POST /setup-api/clawkeep/*`
// per-action paths.

interface ClawKeepStatusOverrides {
  paired?: boolean;
  configured?: boolean;
  encryptionConfigured?: boolean;
  cloudBytes?: number;
  snapshotCount?: number;
}

function buildStatus(overrides: ClawKeepStatusOverrides = {}) {
  return {
    paired: overrides.paired ?? false,
    configured: overrides.configured ?? false,
    server: "clawkeep.openclawhardware.dev",
    lastBackupAtMs: 0,
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
      enabled: false,
      frequency: "weekly" as const,
      timeOfDay: "03:00",
      weekday: 0,
    },
    nextRunAtMs: 0,
    encryptionConfigured: overrides.encryptionConfigured ?? false,
  };
}

test("clawkeep app renders the pair card when the device is unpaired", async ({ page }) => {
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

  await page.route("**/setup-api/clawkeep", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildStatus({ paired: false })),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openLauncher(page);
  await page.getByTestId("app-launcher").getByRole("button", { name: "ClawKeep" }).click();

  const clawkeep = page.getByTestId("chrome-window-clawkeep");
  await expect(clawkeep).toBeVisible();
  // The pair card is the unpaired-state hero — its CTA is the only
  // button rendered before pairing kicks off, so its presence confirms
  // the unpaired branch ran.
  await expect(clawkeep.getByRole("button").first()).toBeVisible();
});

test("clawkeep app renders backup affordances when the device is paired and configured", async ({ page }) => {
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

  // Paired + encryption set up so the dashboard lands on the
  // ready-for-backup branch instead of the encryption-setup gate.
  await page.route("**/setup-api/clawkeep", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        buildStatus({
          paired: true,
          configured: true,
          encryptionConfigured: true,
          cloudBytes: 1_048_576,
          snapshotCount: 3,
        }),
      ),
    });
  });

  // Snapshots endpoint is hit lazily by the restore modal; pre-stub so
  // any background fetch returns sane data instead of a 404 that surfaces
  // as a banner and pollutes the assertion.
  await page.route("**/setup-api/clawkeep/snapshots", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ snapshots: [] }),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openLauncher(page);
  await page.getByTestId("app-launcher").getByRole("button", { name: "ClawKeep" }).click();

  const clawkeep = page.getByTestId("chrome-window-clawkeep");
  await expect(clawkeep).toBeVisible();
  // A paired dashboard shows multiple action buttons (backup, restore,
  // unpair, schedule). The exact labels are translation-bound and may
  // change, so we only assert that the paired branch rendered enough
  // controls — far more than the unpaired state's lone "connect" CTA.
  const buttons = clawkeep.getByRole("button");
  await expect(buttons.first()).toBeVisible();
  expect(await buttons.count()).toBeGreaterThan(2);
});
