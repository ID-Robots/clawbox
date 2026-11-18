// Builds the real service (fetch handler) on top of a temp store, with logs
// captured in memory so tests can grep them.
import { createApp } from "../../src/server/app";
import { AuditLog } from "../../src/server/audit";
import { Auth } from "../../src/server/auth";
import { CardCatalog } from "../../src/server/cards";
import { Catalog } from "../../src/server/catalog";
import { loadConfig } from "../../src/server/config";
import { FillQueue } from "../../src/server/fillqueue";
import { PassStore } from "../../src/server/pass";
import { UiAssets } from "../../src/server/ui";
import { PASS_BIN, type TempStore } from "./tempstore";

export const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
export const BASE = "http://127.0.0.1:4796";

export interface TestVault {
  app: ReturnType<typeof createApp>;
  auth: Auth;
  catalog: Catalog;
  cards: CardCatalog;
  audit: AuditLog;
  queue: FillQueue;
  logs: string[];
  mcpToken: string;
  request(path: string, init?: { method?: string; body?: unknown; token?: string | null; origin?: string | null; host?: string; raw?: string }): Promise<Response>;
}

export async function createTestVault(
  store: TempStore,
  opts: { withUi?: boolean; fillTimeoutMs?: number; cardConfirmMs?: number; cards?: boolean } = {},
): Promise<TestVault> {
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const config = {
    ...loadConfig({
      CLAWBOX_VAULT_HOME: store.root,
      CLAWBOX_VAULT_STORE_DIR: store.storeDir,
      CLAWBOX_VAULT_GNUPGHOME: store.gnupgHome,
      CLAWBOX_VAULT_CONFIG_DIR: store.configDir,
      CLAWBOX_VAULT_PASS_BIN: PASS_BIN,
      // Cards are off unless a test asks for them, as on a box.
      ...(opts.cards ? { CLAWBOX_VAULT_CARDS: "1" } : {}),
    }),
    passEnv: store.env,
    fillTimeoutMs: opts.fillTimeoutMs ?? 3_000,
    cardConfirmMs: opts.cardConfirmMs ?? 3_000,
    pollWaitMs: 2_000,
  };
  const auth = new Auth(config.configDir);
  const audit = new AuditLog(config.configDir);
  const catalog = new Catalog(new PassStore({ bin: config.passBin, storeDir: config.storeDir, env: store.env, log }));
  const cards = new CardCatalog(catalog.store, catalog);
  const queue = new FillQueue({ timeoutMs: config.fillTimeoutMs });
  const ui = opts.withUi ? await UiAssets.build(config.repoDir) : null;
  const app = createApp({ config, catalog, cards, auth, audit, queue, ui, log, version: "test" });
  const mcpToken = (await Bun.file(auth.mcpTokenFile).text()).trim();

  return {
    app,
    auth,
    catalog,
    cards,
    audit,
    queue,
    logs,
    mcpToken,
    request(path, init = {}) {
      const headers: Record<string, string> = { host: init.host ?? "127.0.0.1:4796" };
      if (init.token) headers.authorization = `Bearer ${init.token}`;
      if (init.origin) headers.origin = init.origin;
      let body: string | undefined;
      if (init.raw !== undefined || init.body !== undefined) {
        headers["content-type"] = "application/json";
        body = init.raw ?? JSON.stringify(init.body);
      }
      return app.fetch(new Request(`${BASE}${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body }));
    },
  };
}

/** Set the PIN, open a UI session, pair an extension; returns both tokens. */
export async function pairExtension(v: TestVault, pin = "correct horse 42"): Promise<{ ui: string; ext: string }> {
  let res = await v.request("/api/ui/setup", { body: { pin } });
  if (res.status === 409) res = await v.request("/api/ui/unlock", { body: { pin } });
  const ui = ((await res.json()) as { token: string }).token;
  const { code } = (await (await v.request("/api/ui/pairing", { body: {}, token: ui })).json()) as { code: string };
  const paired = await v.request("/api/pair", { body: { code }, origin: EXT_ORIGIN });
  const ext = ((await paired.json()) as { token: string }).token;
  return { ui, ext };
}
