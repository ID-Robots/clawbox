/**
 * The owner's secret store: the crypto, the file, and what a run is handed.
 *
 * The properties under test are the ones the feature would be worthless
 * without:
 *
 *  1. A VALUE NEVER SITS IN CLEARTEXT. `data/secrets.json` must not contain the
 *     bytes the owner typed, under any key, and the round trip through the
 *     cipher must give them back exactly.
 *  2. THE FILE IS 0600, and stays 0600 across a rewrite.
 *  3. THE LABEL IS BOUND. A row edited to name another scope or another
 *     variable does not open — the AAD is the whole point of using GCM here.
 *  4. INJECTION IS GATED THREE TIMES: the owner's switch, the entry's tick, and
 *     the scope. All three must be open, and the scope must actually separate
 *     one project from another.
 *  5. THE DEVICE'S OWN NAMES ARE REFUSED. An entry called `PATH`,
 *     `LD_PRELOAD` or `CLAUDE_DS_PROVIDER` would be a way to change what a run
 *     runs or which account pays for it, so it cannot be stored at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const configGet = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());

let root = "";
let dataDir = "";
let restoreEnv: () => void;
let store: typeof import("@/lib/project-secrets");

/** The session secret the key is derived from, written where auth.ts looks. */
const SESSION_SECRET = "5b".repeat(32);

const TOKEN = "vrc_live_9Q3k2Zx7pLmN4tR8sW1yB6dF0hJ5aC";

function secretsPath(): string {
  return path.join(dataDir, "secrets.json");
}

function fileText(): string {
  return fs.readFileSync(secretsPath(), "utf-8");
}

function mode(): string {
  return (fs.statSync(secretsPath()).mode & 0o777).toString(8);
}

/** The stored rows, as the module wrote them. */
function rows(): Record<string, unknown>[] {
  return JSON.parse(fileText()) as Record<string, unknown>[];
}

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "NODE_ENV");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-secrets-")));
  dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  // getOrCreateSecret reads data/.session-secret and creates it if it is not
  // there. Written so the key is stable across the module reloads below.
  fs.writeFileSync(path.join(dataDir, ".session-secret"), SESSION_SECRET, { mode: 0o600 });
  process.env.CLAWBOX_ROOT = root;
  // The store reads the FILE deliberately, never SESSION_SECRET — an operator
  // override that came and went would make every stored value unreadable. This
  // sets it to something ELSE, which is the assertion.
  process.env.SESSION_SECRET = "ff".repeat(32);

  vi.resetModules();
  configGet.mockReset().mockResolvedValue(undefined);
  configSet.mockReset().mockResolvedValue(undefined);
  vi.doMock("@/lib/config-store", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/config-store")>()),
    get: configGet,
    set: configSet,
  }));
  store = await import("@/lib/project-secrets");
  store._resetSecretKeyCacheForTests();
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
  vi.doUnmock("@/lib/config-store");
});

/** The owner's switch, which `resolveSecretsForRun` reads first. */
function switchOn(on: boolean): void {
  configGet.mockImplementation(async (key: string) => (key === store.SECRET_INJECT_CONFIG_KEY ? on : undefined));
}

describe("what reaches the disk", () => {
  it("keeps no cleartext, and gives the value back exactly", async () => {
    await store.setSecret({ name: "VERCEL_TOKEN", value: TOKEN, scope: store.BOX_SCOPE, inject: true });

    // THE headline assertion: the bytes the owner typed are not in the file,
    // under any key and in no encoding this store uses.
    const text = fileText();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(Buffer.from(TOKEN, "utf8").toString("base64"));

    // …and the only way out is a run's environment.
    switchOn(true);
    const resolved = await store.resolveSecretsForRun({ project: null });
    expect(resolved.env).toEqual({ VERCEL_TOKEN: TOKEN });
    expect(resolved.names).toEqual(["VERCEL_TOKEN"]);
    expect(resolved.unreadable).toEqual([]);
  });

  it("writes 0600, and still 0600 after a rewrite", async () => {
    await store.setSecret({ name: "A_TOKEN", value: TOKEN, scope: store.BOX_SCOPE });
    expect(mode()).toBe("600");
    await store.setSecret({ name: "B_TOKEN", value: "another-long-enough-value", scope: store.BOX_SCOPE });
    expect(mode()).toBe("600");
    expect(rows()).toHaveLength(2);
  });

  it("gives each entry its own IV, so two rows holding the same value do not match", async () => {
    await store.setSecret({ name: "ONE", value: TOKEN, scope: store.BOX_SCOPE });
    await store.setSecret({ name: "TWO", value: TOKEN, scope: store.BOX_SCOPE });
    const [a, b] = rows();
    expect(a.iv).not.toBe(b.iv);
    // The ciphertexts differ too — which is what the IV buys. Equal
    // ciphertexts would tell a reader of the file that the two rows are the
    // same credential without opening either.
    expect(a.value).not.toBe(b.value);
  });

  it("never puts a value in a view, however the list is read", async () => {
    await store.setSecret({ name: "VERCEL_TOKEN", value: TOKEN, scope: store.BOX_SCOPE, inject: true });
    const list = await store.listSecrets();
    expect(JSON.stringify(list)).not.toContain(TOKEN);
    expect(list[0]).toMatchObject({ name: "VERCEL_TOKEN", scope: store.BOX_SCOPE, inject: true, readable: true });
  });

  it("does not lose the owner's list when a save follows an unreadable store", async () => {
    await store.setSecret({ name: "KEEP_ME", value: TOKEN, scope: store.BOX_SCOPE });
    fs.writeFileSync(secretsPath(), "{ not json");
    // Refused, not read as empty: read-as-empty would be written back empty by
    // the next save, taking the list with it.
    await expect(store.setSecret({ name: "NEW_ONE", value: TOKEN, scope: store.BOX_SCOPE }))
      .rejects.toMatchObject({ code: "store_unreadable" });
    expect(fileText()).toBe("{ not json");
  });
});

describe("the label is bound to the row", () => {
  it("refuses to open a row moved to another scope", async () => {
    await store.setSecret({ name: "SHOP_TOKEN", value: TOKEN, scope: "shop", inject: true });
    const edited = rows();
    edited[0].scope = "other";
    fs.writeFileSync(secretsPath(), JSON.stringify(edited));
    store._resetSecretKeyCacheForTests();

    switchOn(true);
    const resolved = await store.resolveSecretsForRun({ project: "other" });
    expect(resolved.env).toEqual({});
    expect(resolved.unreadable).toEqual(["SHOP_TOKEN"]);
    // The list still shows it, so the owner can save the value again.
    expect(await store.listSecrets()).toMatchObject([{ name: "SHOP_TOKEN", readable: false }]);
  });

  it("refuses to open a row renamed to another variable", async () => {
    await store.setSecret({ name: "REAL_NAME", value: TOKEN, scope: store.BOX_SCOPE, inject: true });
    const edited = rows();
    edited[0].name = "OTHER_NAME";
    fs.writeFileSync(secretsPath(), JSON.stringify(edited));
    store._resetSecretKeyCacheForTests();

    switchOn(true);
    expect((await store.resolveSecretsForRun({ project: null })).env).toEqual({});
  });

  it("reports a row sealed under another box's key as unreadable, not as corrupt", async () => {
    await store.setSecret({ name: "OLD_BOX", value: TOKEN, scope: store.BOX_SCOPE, inject: true });
    // What a factory reset leaves behind: the store, and a new session secret.
    fs.writeFileSync(path.join(dataDir, ".session-secret"), "a1".repeat(32), { mode: 0o600 });
    store._resetSecretKeyCacheForTests();

    expect(await store.listSecrets()).toMatchObject([{ name: "OLD_BOX", readable: false }]);
    switchOn(true);
    expect((await store.resolveSecretsForRun({ project: null })).unreadable).toEqual(["OLD_BOX"]);
  });
});

describe("what a run is given", () => {
  beforeEach(async () => {
    await store.setSecret({ name: "BOX_WIDE", value: "box-scope-value-long-enough", scope: store.BOX_SCOPE, inject: true });
    await store.setSecret({ name: "SHOP_ONLY", value: "shop-scope-value-long-enough", scope: "shop", inject: true });
    await store.setSecret({ name: "NOT_TICKED", value: "untick-scope-value-long-enough", scope: store.BOX_SCOPE, inject: false });
  });

  it("gives a run nothing at all while the owner's switch is off", async () => {
    switchOn(false);
    expect(await store.resolveSecretsForRun({ project: "shop" })).toEqual({ env: {}, names: [], unreadable: [] });
  });

  it("gives a run nothing while the switch has never been answered", async () => {
    // Absent, not false: a box that has never been asked must not have said yes.
    configGet.mockResolvedValue(undefined);
    expect((await store.resolveSecretsForRun({ project: "shop" })).names).toEqual([]);
  });

  it("gives the box scope plus its own project, and no other project's", async () => {
    switchOn(true);
    const shop = await store.resolveSecretsForRun({ project: "shop" });
    expect(Object.keys(shop.env).sort()).toEqual(["BOX_WIDE", "SHOP_ONLY"]);

    const other = await store.resolveSecretsForRun({ project: "warehouse" });
    expect(Object.keys(other.env)).toEqual(["BOX_WIDE"]);
  });

  it("gives a run in no project the box scope alone", async () => {
    switchOn(true);
    expect(Object.keys((await store.resolveSecretsForRun({ project: null })).env)).toEqual(["BOX_WIDE"]);
  });

  it("leaves an un-ticked entry out, however it is scoped", async () => {
    switchOn(true);
    const resolved = await store.resolveSecretsForRun({ project: "shop" });
    expect(resolved.env).not.toHaveProperty("NOT_TICKED");
  });

  it("lets a project's entry win over a box-wide one of the same name", async () => {
    await store.setSecret({ name: "STRIPE_KEY", value: "box-level-stripe-key-value", scope: store.BOX_SCOPE, inject: true });
    await store.setSecret({ name: "STRIPE_KEY", value: "shop-level-stripe-key-value", scope: "shop", inject: true });
    switchOn(true);
    expect((await store.resolveSecretsForRun({ project: "shop" })).env.STRIPE_KEY).toBe("shop-level-stripe-key-value");
    expect((await store.resolveSecretsForRun({ project: "warehouse" })).env.STRIPE_KEY).toBe("box-level-stripe-key-value");
  });

  it("keeps a project ACTUALLY CALLED box apart from the box scope", async () => {
    // The hole this closes: with the plain word `box` as the sentinel, a secret
    // saved for a project of that name was stored as box-wide and handed to
    // every run on the device. `BOX_SCOPE` is outside the project alphabet, so
    // the two cannot collide.
    expect(store.BOX_SCOPE).not.toMatch(store.SECRET_SCOPE_RE);
    await store.setSecret({ name: "BOXPROJ_KEY", value: "a-project-called-box-value", scope: "box", inject: true });
    switchOn(true);
    // The project named "box" gets it…
    expect((await store.resolveSecretsForRun({ project: "box" })).env).toHaveProperty("BOXPROJ_KEY");
    // …and nobody else does, which is the whole point.
    expect((await store.resolveSecretsForRun({ project: "shop" })).env).not.toHaveProperty("BOXPROJ_KEY");
    expect((await store.resolveSecretsForRun({ project: null })).env).not.toHaveProperty("BOXPROJ_KEY");
  });

  it("hands over NOTHING for a name whose project override cannot be opened", async () => {
    // Not the box-wide value: the owner chose a different credential for this
    // project, and handing over the general one silently would be the worst of
    // the three possible answers.
    await store.setSecret({ name: "STRIPE_KEY", value: "box-level-stripe-key-value", scope: store.BOX_SCOPE, inject: true });
    await store.setSecret({ name: "STRIPE_KEY", value: "shop-level-stripe-key-value", scope: "shop", inject: true });
    const edited = rows();
    // The project row, sealed under a key this box does not have.
    const at = edited.findIndex((r) => r.name === "STRIPE_KEY" && r.scope === "shop");
    edited[at].keyId = "0".repeat(16);
    edited[at].tag = Buffer.alloc(16).toString("base64");
    fs.writeFileSync(secretsPath(), JSON.stringify(edited));
    store._resetSecretKeyCacheForTests();

    switchOn(true);
    const resolved = await store.resolveSecretsForRun({ project: "shop" });
    expect(resolved.env).not.toHaveProperty("STRIPE_KEY");
    expect(resolved.unreadable).toEqual(["STRIPE_KEY"]);
    // Another project is unaffected: its runs get the box-wide value.
    expect((await store.resolveSecretsForRun({ project: "warehouse" })).env.STRIPE_KEY).toBe("box-level-stripe-key-value");
  });

  it("does not report a box-wide row it cannot open when the project's own row opens", async () => {
    await store.setSecret({ name: "STRIPE_KEY", value: "box-level-stripe-key-value", scope: store.BOX_SCOPE, inject: true });
    await store.setSecret({ name: "STRIPE_KEY", value: "shop-level-stripe-key-value", scope: "shop", inject: true });
    const edited = rows();
    const at = edited.findIndex((r) => r.name === "STRIPE_KEY" && r.scope === store.BOX_SCOPE);
    edited[at].keyId = "0".repeat(16);
    edited[at].tag = Buffer.alloc(16).toString("base64");
    fs.writeFileSync(secretsPath(), JSON.stringify(edited));
    store._resetSecretKeyCacheForTests();

    switchOn(true);
    const resolved = await store.resolveSecretsForRun({ project: "shop" });
    expect(resolved.env.STRIPE_KEY).toBe("shop-level-stripe-key-value");
    // Nothing is wrong from this run's point of view, so nothing is reported.
    expect(resolved.unreadable).toEqual([]);
  });

  it("answers nothing rather than throwing when the store cannot be read", async () => {
    // A damaged store must not fail the run: the names on the record are what
    // tells the owner a credential did not arrive.
    fs.writeFileSync(secretsPath(), "{ not json");
    switchOn(true);
    expect(await store.resolveSecretsForRun({ project: "shop" })).toEqual({ env: {}, names: [], unreadable: [] });
  });

  it("re-checks the name on the way out, so an older build's row cannot reach a run", async () => {
    // Hand-written the way a store from a build with a shorter reserved list
    // would look. `setSecret` would refuse this name; the resolve must too.
    const edited = rows();
    edited.push({ ...edited[0], name: "LD_PRELOAD" });
    fs.writeFileSync(secretsPath(), JSON.stringify(edited));
    switchOn(true);
    expect(await store.resolveSecretsForRun({ project: null })).toMatchObject({ env: { BOX_WIDE: expect.any(String) } });
    expect((await store.resolveSecretsForRun({ project: null })).env).not.toHaveProperty("LD_PRELOAD");
  });
});

describe("what may be stored", () => {
  it("refuses a name that is not an environment variable name", async () => {
    for (const name of ["lowercase", "2FA_TOKEN", "HAS-DASH", "HAS SPACE", "", "A".repeat(65)]) {
      await expect(store.setSecret({ name, value: TOKEN })).rejects.toMatchObject({ code: "invalid_name" });
    }
  });

  it("refuses a name the device uses for its own run wiring", async () => {
    // Every one of these is a way to change what a run RUNS or who pays for
    // it, which is why they are refused at the door rather than dropped later.
    for (const name of [
      "PATH", "HOME", "SHELL", "IFS",
      "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "BASH_FUNC_DEPLOY",
      // BASH_ENV is SOURCED by a non-interactive bash before its own body —
      // a way to run code inside the claude-ds wrapper itself.
      "BASH_ENV", "BASHOPTS",
      "NODE_OPTIONS", "PYTHONSTARTUP", "GIT_SSH_COMMAND",
      "CLAUDE_DS_PROVIDER", "CLAUDE_DS_MODEL", "CLAWBOX_RUN_ARTIFACTS_DIR", "ANTHROPIC_API_KEY",
    ]) {
      await expect(store.setSecret({ name, value: TOKEN })).rejects.toMatchObject({ code: "reserved_name" });
    }
    expect(fs.existsSync(secretsPath())).toBe(false);
  });

  it("refuses a scope that is a path rather than a label", async () => {
    for (const scope of ["../etc", "a/b", "", "x".repeat(65)]) {
      await expect(store.setSecret({ name: "OK_NAME", value: TOKEN, scope })).rejects.toMatchObject({ code: "invalid_scope" });
    }
  });

  it("refuses an empty value, an over-long one, and one with control characters", async () => {
    await expect(store.setSecret({ name: "OK_NAME", value: "   " })).rejects.toMatchObject({ code: "invalid_value" });
    // Below the floor the redaction shares with it — a value the box would
    // inject and could not scrub is refused at the save.
    await expect(store.setSecret({ name: "OK_NAME", value: "short" }))
      .rejects.toMatchObject({ code: "value_too_short" });
    await expect(store.setSecret({ name: "OK_NAME", value: "x".repeat(store.MAX_SECRET_VALUE_CHARS + 1) }))
      .rejects.toMatchObject({ code: "value_too_long" });
    // A NUL would truncate the variable where the kernel copies it.
    await expect(store.setSecret({ name: "OK_NAME", value: "abcdefgh\u0000ijkl" })).rejects.toMatchObject({ code: "invalid_value" });
  });

  it("keeps the newlines a PEM key is made of, and trims the one a paste adds", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----";
    await store.setSecret({ name: "DEPLOY_KEY", value: `${pem}\n`, scope: store.BOX_SCOPE, inject: true });
    switchOn(true);
    expect((await store.resolveSecretsForRun({ project: null })).env.DEPLOY_KEY).toBe(pem);
  });

  it("refuses a new entry at the cap rather than evicting one", async () => {
    for (let i = 0; i < store.MAX_SECRETS; i += 1) {
      await store.setSecret({ name: `TOKEN_${i}`, value: `value-number-${i}-long-enough` });
    }
    await expect(store.setSecret({ name: "ONE_MORE", value: TOKEN })).rejects.toMatchObject({ code: "full" });
    // Replacing one that is there still works at the cap.
    await expect(store.setSecret({ name: "TOKEN_0", value: "a-rotated-value-long-enough" })).resolves.toMatchObject({ name: "TOKEN_0" });
    expect(rows()).toHaveLength(store.MAX_SECRETS);
  });

  it("keeps createdAt and the owner's tick when a rotated value replaces one", async () => {
    const first = await store.setSecret({ name: "ROTATED", value: TOKEN, scope: store.BOX_SCOPE, inject: true });
    const again = await store.setSecret({ name: "ROTATED", value: "the-rotated-value-long-enough", scope: store.BOX_SCOPE });
    expect(again.createdAt).toBe(first.createdAt);
    // Re-pasting a rotated token is not a reason to re-ask whether runs may
    // have it.
    expect(again.inject).toBe(true);
    expect(rows()).toHaveLength(1);
  });

  it("holds one name per scope, and the same name in two scopes apart", async () => {
    await store.setSecret({ name: "API_KEY", value: "box-level-value-long-enough", scope: store.BOX_SCOPE });
    await store.setSecret({ name: "API_KEY", value: "shop-level-value-long-enough", scope: "shop" });
    await store.setSecret({ name: "API_KEY", value: "box-level-value-replaced-ok", scope: store.BOX_SCOPE });
    expect(rows()).toHaveLength(2);
  });
});

describe("the tick and the removal", () => {
  it("ticks and un-ticks one entry without touching its value", async () => {
    await store.setSecret({ name: "TICKABLE", value: TOKEN, scope: store.BOX_SCOPE, inject: false });
    expect((await store.setSecretInject({ name: "TICKABLE", scope: store.BOX_SCOPE, inject: true })).inject).toBe(true);
    switchOn(true);
    expect((await store.resolveSecretsForRun({ project: null })).env.TICKABLE).toBe(TOKEN);
    expect((await store.setSecretInject({ name: "TICKABLE", scope: store.BOX_SCOPE, inject: false })).inject).toBe(false);
    expect((await store.resolveSecretsForRun({ project: null })).env).toEqual({});
  });

  it("says so rather than inventing a row when the name is not there", async () => {
    await expect(store.setSecretInject({ name: "MISSING", inject: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(store.deleteSecret({ name: "MISSING" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("removes one entry and leaves the other scope's alone", async () => {
    await store.setSecret({ name: "API_KEY", value: "box-level-value-long-enough", scope: store.BOX_SCOPE });
    await store.setSecret({ name: "API_KEY", value: "shop-level-value-long-enough", scope: "shop" });
    const left = await store.deleteSecret({ name: "API_KEY", scope: "shop" });
    expect(left).toMatchObject([{ name: "API_KEY", scope: store.BOX_SCOPE }]);
    expect(rows()).toHaveLength(1);
  });

  it("loses no entry when two writes overlap", async () => {
    // The reason the module serialises every mutation: two read-modify-writes
    // over one file, from two clicks in two windows. Overlapped without the
    // chain, the second writes the list it read before the first landed.
    await Promise.all([
      store.setSecret({ name: "FIRST_ONE", value: "first-value-long-enough" }),
      store.setSecret({ name: "SECOND_ONE", value: "second-value-long-enough" }),
      store.setSecret({ name: "THIRD_ONE", value: "third-value-long-enough" }),
    ]);
    expect((await store.listSecrets()).map((s) => s.name).sort()).toEqual(["FIRST_ONE", "SECOND_ONE", "THIRD_ONE"]);
  });

  it("does not let one failed write poison the next", async () => {
    const results = await Promise.allSettled([
      store.setSecret({ name: "bad name", value: TOKEN }),
      store.setSecret({ name: "GOOD_NAME", value: TOKEN }),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
  });
});

describe("the switch", () => {
  it("writes the config key, and refuses anything that is not a boolean", async () => {
    await expect(store.setInjectSecrets(true)).resolves.toBe(true);
    expect(configSet).toHaveBeenCalledWith(store.SECRET_INJECT_CONFIG_KEY, true);
    await expect(store.setInjectSecrets("yes")).rejects.toMatchObject({ code: "invalid_value" });
  });

  it("reads absent as off", async () => {
    configGet.mockResolvedValue(undefined);
    expect(await store.getInjectSecrets()).toBe(false);
    configGet.mockResolvedValue("true");
    // A string is not a yes: only the boolean the switch writes is.
    expect(await store.getInjectSecrets()).toBe(false);
  });
});
