import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";

/**
 * One credential, two homes.
 *
 * Voice input was dark on Hermes for exactly one reason: the transcribe route
 * looked in `openclaw.json` and nowhere else, while the Hermes flow persists
 * the SAME device token through the app's own config store. Nothing about
 * transcription is edition-specific — the lookup was. These cases are the four
 * shapes a real box can be in.
 */

const readConfig = vi.fn();
const configStoreGet = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({ readConfig: () => readConfig() }));
vi.mock("@/lib/config-store", () => ({
  get: (key: string) => configStoreGet(key),
  // Pulled in by the proxy-URL re-export chain; never called here.
  setMany: vi.fn(),
}));

const OPENCLAW_TOKEN = "tok-from-openclaw-store";
const HERMES_TOKEN = "tok-from-hermes-store";

/**
 * The provider slot ClawBox AI occupies in `openclaw.json`.
 *
 * Written as a LITERAL on purpose. This is a persisted on-disk key —
 * `install.sh` writes `models.providers.deepseek` as a bare string and
 * `scripts/gateway-pre-start.sh` reads it back — so a test that derived it from
 * the TypeScript constant would follow a rename of that constant and keep
 * passing while the real contract with the shell broke.
 */
const PERSISTED_PROVIDER_KEY = "deepseek";

function openclawConfigWith(apiKey: unknown) {
  return { models: { providers: { [PERSISTED_PROVIDER_KEY]: { apiKey } } } };
}

async function resolve() {
  const mod = await import("@/lib/harness/credentials");
  return mod.resolveClawaiToken();
}

describe("resolveClawaiToken", () => {
  it("keeps the TypeScript constant and the on-disk key in step", () => {
    // The one place the two are allowed to meet. If this fails, the rename that
    // caused it has to be carried into install.sh and gateway-pre-start.sh too.
    expect(CLAWBOX_AI_PROVIDER).toBe(PERSISTED_PROVIDER_KEY);
  });

  beforeEach(() => {
    vi.resetModules();
    readConfig.mockReset();
    configStoreGet.mockReset();
  });

  it("reads the OpenClaw store when that is where the token lives", async () => {
    readConfig.mockResolvedValue(openclawConfigWith(OPENCLAW_TOKEN));
    configStoreGet.mockResolvedValue(null);
    expect(await resolve()).toBe(OPENCLAW_TOKEN);
    // The fallback is not consulted when the first store answers.
    expect(configStoreGet).not.toHaveBeenCalled();
  });

  it("falls back to the Hermes store — the case that lit up voice input", async () => {
    readConfig.mockResolvedValue({});
    configStoreGet.mockResolvedValue(HERMES_TOKEN);
    expect(await resolve()).toBe(HERMES_TOKEN);
    expect(configStoreGet).toHaveBeenCalledWith("clawai_token");
  });

  it("still answers when there is no OpenClaw config to read at all", async () => {
    // A Hermes SKU has no `~/.openclaw` tree. A throw here is not a failure,
    // it is the whole reason there is a second place to look.
    readConfig.mockRejectedValue(new Error("ENOENT"));
    configStoreGet.mockResolvedValue(HERMES_TOKEN);
    expect(await resolve()).toBe(HERMES_TOKEN);
  });

  it("prefers the OpenClaw store on a dual box, where both hold the same token", async () => {
    readConfig.mockResolvedValue(openclawConfigWith(OPENCLAW_TOKEN));
    configStoreGet.mockResolvedValue(HERMES_TOKEN);
    expect(await resolve()).toBe(OPENCLAW_TOKEN);
  });

  it("reports nothing rather than an empty string when the box is unlinked", async () => {
    readConfig.mockResolvedValue(openclawConfigWith("   "));
    configStoreGet.mockResolvedValue("");
    expect(await resolve()).toBeNull();
    const { hasClawaiToken } = await import("@/lib/harness/credentials");
    expect(await hasClawaiToken()).toBe(false);
  });

  it("refuses a non-string the store somehow held", async () => {
    readConfig.mockResolvedValue(openclawConfigWith({ nested: "object" }));
    configStoreGet.mockResolvedValue(42);
    expect(await resolve()).toBeNull();
  });

  it("trims, so a token pasted with whitespace still works", async () => {
    readConfig.mockResolvedValue({});
    configStoreGet.mockResolvedValue(`  ${HERMES_TOKEN}\n`);
    expect(await resolve()).toBe(HERMES_TOKEN);
  });

  it("answers null when NEITHER store can be read", async () => {
    // A box with no OpenClaw tree and an unreadable or corrupt
    // `data/config.json` reaches the fallback's own catch. That branch is the
    // difference between the transcribe route answering a clean 503 "not
    // linked" and an unhandled rejection escaping it.
    readConfig.mockRejectedValue(new Error("ENOENT"));
    configStoreGet.mockRejectedValue(new Error("EACCES"));
    expect(await resolve()).toBeNull();
    const { hasClawaiToken } = await import("@/lib/harness/credentials");
    expect(await hasClawaiToken()).toBe(false);
  });

  it("re-reads on every call, because the portal can re-mint at any time", async () => {
    readConfig.mockResolvedValueOnce(openclawConfigWith("first"));
    readConfig.mockResolvedValueOnce(openclawConfigWith("second"));
    const { resolveClawaiToken } = await import("@/lib/harness/credentials");
    expect(await resolveClawaiToken()).toBe("first");
    expect(await resolveClawaiToken()).toBe("second");
  });
});

/**
 * The server-only boundary, enforced without a new runtime dependency.
 *
 * `resolveClawaiToken` returns the device's raw credential. Next's `server-only`
 * package turns a client import into a build failure, which is the strongest
 * form of this check — but it is not a dependency this repo carries, and adding
 * one drags `package.json` and `bun.lock` into a chat refactor. The property
 * that actually matters is testable directly: nothing the browser bundles may
 * reach this module.
 */
describe("the credential module stays on the server", () => {
  function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...filesUnder(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  /**
   * Any reference that would pull the module in, not just a static `import`.
   *
   * A scan for `from "…"` alone sees one of the three ways in: a lazy
   * `await import("…")` and a `require("…")` reach exactly the same code and
   * would have gone unnoticed.
   */
  const REACHES_CREDENTIALS =
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']@\/lib\/harness\/credentials["']/;

  it("is imported by no client component", () => {
    const offenders = filesUnder(join(process.cwd(), "src", "components")).filter((f) =>
      REACHES_CREDENTIALS.test(readFileSync(f, "utf8")),
    );
    // A component is bundled for the browser. An import here would ship the
    // lookup — and on the wrong build, the value — to every page that loads it.
    expect(offenders).toEqual([]);
  });

  it("is imported only by route handlers on the server side of the app", () => {
    const appDir = join(process.cwd(), "src", "app");
    const importers = filesUnder(appDir).filter((f) =>
      REACHES_CREDENTIALS.test(readFileSync(f, "utf8")),
    );
    expect(importers.length).toBeGreaterThan(0);
    for (const file of importers) {
      // Route handlers only. A `page.tsx` or a "use client" module reaching for
      // this is the case the boundary exists to stop.
      expect(file.endsWith(`${"route"}.ts`)).toBe(true);
      expect(readFileSync(file, "utf8")).not.toMatch(/^\s*["']use client["']/m);
    }
  });
});

describe("a credential the ClawBox AI proxy has refused", () => {
  beforeEach(() => {
    vi.resetModules();
    readConfig.mockReset();
    configStoreGet.mockReset();
  });

  /** The memory, freshly imported so each case starts with none. */
  async function memo() {
    const mod = await import("@/lib/harness/credentials");
    mod.resetClawaiCredentialRefusals();
    return mod;
  }

  it("remembers the status, so the next caller says the same thing", async () => {
    const mod = await memo();
    expect(mod.clawaiCredentialRefused()).toBeNull();
    mod.noteClawaiCredentialRefused(403, mod.clawaiCredentialGeneration());
    expect(mod.clawaiCredentialRefused()).toBe(403);
  });

  it("is dropped the moment the credential is rewritten", async () => {
    // What makes "re-link the device" — the instruction every refusal prints —
    // an instruction that works.
    const mod = await memo();
    mod.noteClawaiCredentialRefused(401, mod.clawaiCredentialGeneration());
    expect(mod.clawaiCredentialRefused()).toBe(401);
    mod.forgetClawaiCredentialRefusal();
    expect(mod.clawaiCredentialRefused()).toBeNull();
  });

  it("ignores a verdict that arrives after the credential changed", async () => {
    // The interleaving: a request sent with the OLD token is still in flight
    // when the owner re-links, and its 403 lands afterwards. Recording it would
    // mute the microphone and hide the picture button on a device that was just
    // successfully re-linked — over a credential it no longer holds.
    const mod = await memo();
    const inFlight = mod.clawaiCredentialGeneration();
    mod.forgetClawaiCredentialRefusal();
    mod.noteClawaiCredentialRefused(403, inFlight);
    expect(mod.clawaiCredentialRefused()).toBeNull();

    // A verdict from the CURRENT credential is still recorded.
    mod.noteClawaiCredentialRefused(403, mod.clawaiCredentialGeneration());
    expect(mod.clawaiCredentialRefused()).toBe(403);
  });

  it("asks for no credential to answer, and is handed none", async () => {
    // The security property, expressed as the shape of the API rather than by
    // rummaging in module state: nothing here takes, returns or stores the
    // token or anything derived from it. An earlier draft keyed the memory on a
    // SHA-256 of it, and CodeQL was right to read a credential reaching a bare
    // digest as a password hashed without a KDF.
    const mod = await memo();
    expect(mod.clawaiCredentialRefused.length).toBe(0);
    expect(mod.clawaiCredentialGeneration.length).toBe(0);
    expect(mod.forgetClawaiCredentialRefusal.length).toBe(0);
    // status + generation, both non-secret.
    expect(mod.noteClawaiCredentialRefused.length).toBe(2);
  });
});
