// ClawBox Vault service: binds 127.0.0.1:4796 (loopback only) and serves the
// API plus the desktop app under /apps/clawbox-vault/. On its first start it
// makes its own keyring and password store, and on every start it builds the
// extension the box's browser loads.
import { mkdirSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app";
import { AuditLog } from "./audit";
import { Auth } from "./auth";
import { CardCatalog } from "./cards";
import { Catalog } from "./catalog";
import { loadConfig, REPO_DIR } from "./config";
import { buildExtension } from "./extensiondir";
import { FillQueue } from "./fillqueue";
import { PassStore } from "./pass";
import { StoreSetup } from "./storeinit";
import { UiAssets } from "./ui";

const log = (line: string) => console.log(`[clawbox-vault] ${line}`);

process.umask(0o077);
const config = loadConfig();
mkdirSync(config.homeDir, { recursive: true, mode: 0o700 });
chmodSync(config.homeDir, 0o700);
const version = (JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8")) as { version: string }).version;
const auth = new Auth(config.configDir);
const audit = new AuditLog(config.configDir);
const setup = new StoreSetup({ passBin: config.passBin, storeDir: config.storeDir, gnupgHome: config.gnupgHome, env: config.passEnv, log });
const store = new PassStore({ bin: config.passBin, storeDir: config.storeDir, env: config.passEnv, log });
const catalog = new Catalog(store);
const cards = new CardCatalog(store, catalog);
const queue = new FillQueue({ timeoutMs: config.fillTimeoutMs });
const ui = await UiAssets.build(config.repoDir);
const app = createApp({ config, catalog, cards, auth, audit, queue, ui, log, version, setup });

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  // Long-polls from the extension and agent fills hold requests open.
  idleTimeout: 120,
  fetch: (req) => app.fetch(req),
});

audit.record({ actor: "system", action: "service_started", detail: `v${version}` });
log(`listening on http://${server.hostname}:${server.port}${config.basePath} (cwd ${process.cwd()})`);

// After the listener is up, so a slow key generation never holds the unit in
// "activating" and a box without pass still answers its health check.
void setup.ensure();
void buildExtension({
  repoDir: config.repoDir,
  outDir: config.extensionDir,
  service: `http://127.0.0.1:${server.port}`,
  pairSecret: auth.autoPairSecret,
  cards: config.cards,
}).then(
  () => log(`extension built in ${config.extensionDir}`),
  (err) => log(`extension not built: ${(err as Error).message.slice(0, 200)}`),
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`stopping (${sig})`);
    queue.cancelAll("extension_offline");
    server.stop(true);
    process.exit(0);
  });
}
