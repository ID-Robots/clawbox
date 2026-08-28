/**
 * Global setup for the full-install e2e suite. Builds the image, boots the
 * container, and waits for install.sh to finish before any test runs. The
 * container is left running so individual tests can exercise state that
 * persists across it (notably the main→beta upgrade test, which deliberately
 * spans restarts).
 *
 * Teardown is intentionally manual — tests that need a clean slate should
 * call `composeDown({ removeVolumes: true })` themselves. CI can call
 * `docker compose -f e2e-install/docker-compose.test.yml down -v` after the
 * playwright run.
 */
import {
  composeUp,
  waitForInstallComplete,
  readInstallLog,
  dockerExec,
  InstallBootstrapFailedError,
  BOOTSTRAP_UNIT,
} from "./helpers/container";

const SKIP = process.env.CLAWBOX_E2E_SKIP_SETUP === "1";
const REBUILD = process.env.CLAWBOX_E2E_REBUILD === "1";

export default async function globalSetup() {
  if (SKIP) {
    console.log("[e2e-install] CLAWBOX_E2E_SKIP_SETUP=1, reusing existing container");
    return;
  }
  console.log("[e2e-install] booting container...");
  await composeUp({ build: REBUILD });
  try {
    await waitForInstallComplete();
    console.log("[e2e-install] install complete");
  } catch (err) {
    // The fail-fast error already carries the install-log tail in its
    // message, which Playwright prints; dumping the log here as well would
    // show it twice. The deadline path (installer hung, unit never failed)
    // still gets the long dump, because that error has no log of its own.
    if (!(err instanceof InstallBootstrapFailedError)) {
      const log = await readInstallLog(500).catch(() => "(log unavailable)");
      console.error("[e2e-install] install failed — last 500 lines of install log:\n" + log);
    }
    const journal = await dockerExec(
      ["bash", "-c", `journalctl -u ${BOOTSTRAP_UNIT} --no-pager | tail -n 200`],
      { user: "root" },
    ).catch(() => "(journal unavailable)");
    console.error("[e2e-install] bootstrap journal:\n" + journal);
    throw err;
  }
}
