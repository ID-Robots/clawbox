/**
 * Settings → Coding Agent → Secrets, the card.
 *
 * The properties under test:
 *
 *  1. NO VALUE IS EVER ON SCREEN after a save. The field is cleared, nothing is
 *     re-read into it, and the confirmation names the entry without describing
 *     the value. An input that looked as though it held the saved secret would
 *     be a lie about what the box can tell you.
 *  2. THE THREE GATES ARE VISIBLE AND SEPARATE: the master switch posts to the
 *     switch route, a row's tick posts to the store, and the scope picker
 *     decides which runs an entry reaches.
 *  3. A REFUSAL IS SAID IN THE OWNER'S LANGUAGE when the route sent a code this
 *     build knows, and in the box's own words when it did not.
 *  4. ONE WRITE AT A TIME: a control mid-write cannot be pressed twice.
 *  5. "IMPORT FROM ASSISTANT" deals in NAMES: it is drawn only when the import
 *     route answers this session with a source, posts a name and a scope and
 *     nothing else, and no value is on screen at any point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSecretsCard from "@/components/CodingAgentSecretsCard";
import { BOX_SCOPE, MIN_SECRET_VALUE_CHARS } from "@/lib/project-secrets-shape";

// The card's own words, in English, the way the rules-card suite does it:
// asserting on the catalogue's copy rather than on the key is what catches a
// string that never entered it.
const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const TOKEN = "vrc_live_9Q3k2Zx7pLmN4tR8sW1yB6dF0hJ5aC";

interface Call { url: string; method: string; body: unknown }

let calls: Call[] = [];
let secrets: unknown[] = [];
let injectSecrets = false;
/** Set to make the next write fail with this status and body. */
let refuse: { status: number; body: unknown } | null = null;
/** The import route's answer to a GET; null answers 403, as for a non-owner. */
let assistant: { names: { name: string; source: string }[]; sources: string[] } | null = null;
/** Set to make every GET of the import route answer this status and body instead. */
let assistantRefusal: { status: number; body: unknown } | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function payload() {
  return { secrets, max: 64, maxValueChars: 8192, injectSecrets };
}

function stubFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method !== "GET") calls.push({ url, method, body });
    if (url.startsWith("/setup-api/coding-agent/projects")) {
      return json({ directory: "/home/clawbox/Projects", projects: [{ folder: "shop", name: "Corner Shop", kind: "folder" }] });
    }
    if (url.startsWith("/setup-api/coding-agent/secrets/import")) {
      if (method === "GET") {
        if (assistantRefusal) return json(assistantRefusal.body, assistantRefusal.status);
        return assistant ? json(assistant) : json({ error: "owner only", kind: "owner_only" }, 403);
      }
      if (refuse) { const r = refuse; refuse = null; return json(r.body, r.status); }
      const expiry = body.expiresAt ? { expiresAt: body.expiresAt, expired: false } : {};
      secrets = [...secrets, { name: body.name, scope: body.scope, inject: false, readable: true, createdAt: 1, updatedAt: 1, ...expiry }];
      return json({ imported: { name: body.name, scope: body.scope, ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}) }, ...payload() });
    }
    if (url.startsWith("/setup-api/coding-agent/secrets")) {
      if (method === "GET") return json(payload());
      if (refuse) { const r = refuse; refuse = null; return json(r.body, r.status); }
      if (body && typeof body.injectSecrets === "boolean") {
        injectSecrets = body.injectSecrets;
        return json(payload());
      }
      if (method === "DELETE") {
        const name = new URL(url, "http://x").searchParams.get("name");
        secrets = secrets.filter((s) => (s as { name: string }).name !== name);
      } else if (body && typeof body.value === "string") {
        secrets = [...secrets, { name: body.name, scope: body.scope ?? BOX_SCOPE, inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
      } else if (body && typeof body.inject === "boolean") {
        secrets = secrets.map((s) => ((s as { name: string }).name === body.name ? { ...(s as object), inject: body.inject } : s));
      }
      return json(payload());
    }
    return json({ error: "unexpected" }, 404);
  }));
}

beforeEach(() => {
  calls = [];
  secrets = [];
  injectSecrets = false;
  refuse = null;
  assistant = null;
  assistantRefusal = null;
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The card once its first read is back. */
async function mounted() {
  render(<CodingAgentSecretsCard />);
  await screen.findByTestId("coding-agent-secrets-card");
  await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-count")).toBeInTheDocument());
}

describe("the list", () => {
  it("says the list is empty only once the box has answered", async () => {
    await mounted();
    expect(await screen.findByTestId("coding-agent-secrets-empty")).toBeInTheDocument();
  });

  it("shows a name and its scope, and never a value", async () => {
    secrets = [{ name: "DEPLOY_TOKEN", scope: BOX_SCOPE, inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
    await mounted();
    const row = await screen.findByTestId("coding-agent-secret-row");
    expect(row).toHaveTextContent("DEPLOY_TOKEN");
    expect(row).toHaveTextContent("Every project on this box");
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("names a project's scope the way the projects list does, not by its folder key", async () => {
    secrets = [{ name: "SHOP_TOKEN", scope: "shop", inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
    await mounted();
    await waitFor(() => expect(screen.getByTestId("coding-agent-secret-row")).toHaveTextContent("Corner Shop"));
  });

  it("says so when the box can no longer decrypt an entry, and only then", async () => {
    secrets = [
      { name: "OLD_TOKEN", scope: BOX_SCOPE, inject: true, readable: false, createdAt: 1, updatedAt: 1 },
      { name: "NEW_TOKEN", scope: BOX_SCOPE, inject: true, readable: true, createdAt: 1, updatedAt: 1 },
    ];
    await mounted();
    // One warning, for the one entry that has the problem.
    await waitFor(() => expect(screen.getAllByTestId("coding-agent-secret-unreadable")).toHaveLength(1));
  });
});

describe("saving one", () => {
  it("posts the name, the value and the chosen scope, ticked", async () => {
    await mounted();
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "shop_token" } });
    fireEvent.change(screen.getByTestId("coding-agent-secret-value"), { target: { value: TOKEN } });
    fireEvent.change(screen.getByTestId("coding-agent-secret-scope"), { target: { value: "shop" } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));

    await waitFor(() => expect(calls).toHaveLength(1));
    // Upper-cased on the way out: the store's names are shell variable names,
    // and a typed lower-case one is a typo rather than a different secret.
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { name: "SHOP_TOKEN", value: TOKEN, scope: "shop", inject: true },
    });
  });

  it("clears the value field and never reads one back into it", async () => {
    await mounted();
    const value = screen.getByTestId("coding-agent-secret-value") as HTMLInputElement;
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "DEPLOY_TOKEN" } });
    fireEvent.change(value, { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));

    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-saved")).toBeInTheDocument());
    expect(value).toHaveValue("");
    expect(screen.getByTestId("coding-agent-secret-name")).toHaveValue("");
    // The confirmation names the entry and says the value is gone for good.
    expect(screen.getByTestId("coding-agent-secrets-saved")).toHaveTextContent("DEPLOY_TOKEN");
    expect(document.body.textContent).not.toContain(TOKEN);
    // And the row that appears holds no value either.
    expect(await screen.findByTestId("coding-agent-secret-row")).not.toHaveTextContent(TOKEN);
  });

  it("keeps the value out of the DOM while it is being typed", async () => {
    await mounted();
    const value = screen.getByTestId("coding-agent-secret-value");
    // A password field: not read out over the owner's shoulder, and not
    // offered to autofill as a plain one.
    expect(value).toHaveAttribute("type", "password");
  });

  it("refuses a name the store would refuse, without a round trip", async () => {
    await mounted();
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "2FA!" } });
    fireEvent.change(screen.getByTestId("coding-agent-secret-value"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));

    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error")).toBeInTheDocument());
    expect(calls).toHaveLength(0);
  });

  it("asks for the value before posting an empty one", async () => {
    await mounted();
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "DEPLOY_TOKEN" } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error")).toHaveTextContent("Type the value first."));
    expect(calls).toHaveLength(0);
  });
});

describe("the two switches", () => {
  it("posts the master switch to the STORE's route, which is the one with the origin fence", async () => {
    // Not `enable`, where the feature's other switches live: this one is the
    // consent for handing credentials to an unattended shell, so it has to
    // land on the route that checks the origin as well as the cookie.
    await mounted();
    fireEvent.click(screen.getByTestId("coding-agent-secrets-inject"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/setup-api/coding-agent/secrets");
    expect(calls[0].body).toEqual({ injectSecrets: true });
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-inject")).toHaveAttribute("aria-checked", "true"));
  });

  it("renders the state the route answered with, not the one the click hoped for", async () => {
    await mounted();
    refuse = { status: 403, body: { error: "Changing the switch needs a signed-in browser session.", kind: "owner_only" } };
    fireEvent.click(screen.getByTestId("coding-agent-secrets-inject"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error")).toBeInTheDocument());
    expect(screen.getByTestId("coding-agent-secrets-inject")).toHaveAttribute("aria-checked", "false");
  });

  it("posts a row's own tick to the store, naming that row's scope", async () => {
    secrets = [{ name: "SHOP_TOKEN", scope: "shop", inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secret-inject"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      url: "/setup-api/coding-agent/secrets",
      method: "POST",
      body: { name: "SHOP_TOKEN", scope: "shop", inject: false },
    });
  });
});

describe("removing one", () => {
  it("names the entry and its scope in the query", async () => {
    secrets = [{ name: "SHOP_TOKEN", scope: "shop", inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secret-remove"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("name=SHOP_TOKEN");
    expect(calls[0].url).toContain("scope=shop");
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-empty")).toBeInTheDocument());
  });
});

describe("a refusal", () => {
  it("is said in the owner's language when the route sent a code this build knows", async () => {
    await mounted();
    refuse = { status: 400, body: { error: "PATH is a name this ClawBox uses itself.", kind: "invalid", code: "reserved_name" } };
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "SOME_NAME" } });
    fireEvent.change(screen.getByTestId("coding-agent-secret-value"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error"))
      .toHaveTextContent("That name is one this box uses itself. Choose another."));
  });

  it("falls back to the box's own sentence for a code this build has not heard of", async () => {
    await mounted();
    refuse = { status: 400, body: { error: "A brand-new refusal from a newer route.", kind: "invalid", code: "something_new" } };
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "SOME_NAME" } });
    fireEvent.change(screen.getByTestId("coding-agent-secret-value"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error"))
      .toHaveTextContent("A brand-new refusal from a newer route."));
  });

  it("is announced, because it only ever appears after the route has answered", async () => {
    await mounted();
    refuse = { status: 500, body: { error: "broken", code: "store_unwritable" } };
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "SOME_NAME" } });
    fireEvent.change(screen.getByTestId("coding-agent-secret-value"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This box could not read or write its secret store.");
  });

  it("keeps the list it last knew when the read itself fails", async () => {
    secrets = [{ name: "DEPLOY_TOKEN", scope: BOX_SCOPE, inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
    await mounted();
    await screen.findByTestId("coding-agent-secret-row");
    // A card that claimed the list was empty would invite the owner to
    // re-enter a credential that is already there.
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "gone" }, 500)));
    fireEvent.click(screen.getByTestId("coding-agent-secrets-inject"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error")).toBeInTheDocument());
    expect(screen.getByTestId("coding-agent-secret-row")).toHaveTextContent("DEPLOY_TOKEN");
  });
});

describe("a read that failed", () => {
  it("does not draw the empty state, and does not unlock the add form", async () => {
    // The hole this closes: `loaded` used to be set in a `finally`, so a failed
    // FIRST read drew "this box has no secrets" over a list nobody could see
    // and enabled Save over it — and a save REPLACES an entry of the same name
    // and scope, so the owner could overwrite a credential the card had never
    // shown them.
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/coding-agent/projects")) return json({ projects: [] });
      return json({ error: "gone" }, 500);
    }));
    render(<CodingAgentSecretsCard />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error")).toBeInTheDocument());
    expect(screen.queryByTestId("coding-agent-secrets-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-secret-add")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-secret-name")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-secret-value")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-secrets-inject")).toBeDisabled();
  });
});

describe("the fields have names of their own", () => {
  it("labels both inputs, so a placeholder is not the only thing naming them", async () => {
    // A placeholder is gone the moment the owner types and is not an
    // accessible name; the one visible label belongs to the group.
    await mounted();
    expect(screen.getByLabelText("Variable name")).toBe(screen.getByTestId("coding-agent-secret-name"));
    expect(screen.getByLabelText("Value")).toBe(screen.getByTestId("coding-agent-secret-value"));
  });

  it("refuses a value under the floor before it leaves the browser", async () => {
    await mounted();
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "SHORT_ONE" } });
    fireEvent.change(screen.getByTestId("coding-agent-secret-value"), { target: { value: "x".repeat(MIN_SECRET_VALUE_CHARS - 1) } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error")).toBeInTheDocument());
    expect(calls).toHaveLength(0);
  });
});

describe("one write at a time", () => {
  it("disables the other controls while a write is in flight", async () => {
    secrets = [{ name: "DEPLOY_TOKEN", scope: BOX_SCOPE, inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
    await mounted();
    // `let` with a narrowing assignment inside the closure reads as `never` to
    // TypeScript; the box keeps the resolver at a type the caller can call.
    const held: { release: (() => void) | null } = { release: null };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return json(payload());
      await new Promise<void>((resolve) => { held.release = resolve; });
      return json(payload());
    }));

    fireEvent.click(screen.getByTestId("coding-agent-secrets-inject"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secret-remove")).toBeDisabled());
    // The switch mid-write is disabled by its own busy state, so a second
    // click cannot race the first.
    expect(screen.getByTestId("coding-agent-secrets-inject")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-secret-add")).toBeDisabled();
    held.release?.();
    await waitFor(() => expect(screen.getByTestId("coding-agent-secret-remove")).not.toBeDisabled());
  });
});

describe("import from assistant", () => {
  const offered = () => ({
    names: [{ name: "GITHUB_TOKEN", source: "hermes" }, { name: "NOTION_API_KEY", source: "hermes" }],
    sources: ["hermes"],
  });

  it("is not drawn when the import route refuses this session", async () => {
    await mounted();
    // The first read is back; the import route answered 403 (not the owner).
    await waitFor(() => expect(screen.getByTestId("coding-agent-secret-add")).not.toBeDisabled());
    expect(screen.queryByTestId("coding-agent-secrets-import")).not.toBeInTheDocument();
  });

  it("is not drawn on a box with no source to copy from", async () => {
    assistant = { names: [], sources: [] };
    await mounted();
    await waitFor(() => expect(screen.getByTestId("coding-agent-secret-add")).not.toBeDisabled());
    expect(screen.queryByTestId("coding-agent-secrets-import")).not.toBeInTheDocument();
  });

  it("posts a NAME and a scope, and the copy arrives un-ticked with no value on screen", async () => {
    assistant = offered();
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    const picker = await screen.findByTestId("coding-agent-secrets-import-picker");
    // Names only: no field in the picker could hold a value.
    expect(picker.querySelector("input")).toBeNull();
    fireEvent.change(screen.getByTestId("coding-agent-secrets-import-name"), { target: { value: "NOTION_API_KEY" } });
    fireEvent.change(screen.getByTestId("coding-agent-secrets-import-scope"), { target: { value: "shop" } });
    fireEvent.click(screen.getByTestId("coding-agent-secrets-import-copy"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      url: "/setup-api/coding-agent/secrets/import",
      method: "POST",
      body: { name: "NOTION_API_KEY", scope: "shop" },
    });
    expect(await screen.findByTestId("coding-agent-secrets-imported"))
      .toHaveTextContent(t("codingAgent.secretsImported", { name: "NOTION_API_KEY" }));
    // The picker closes, and the new row is there — switched off.
    expect(screen.queryByTestId("coding-agent-secrets-import-picker")).not.toBeInTheDocument();
    const row = await screen.findByTestId("coding-agent-secret-row");
    expect(row).toHaveTextContent("NOTION_API_KEY");
    expect(screen.getByTestId("coding-agent-secret-inject")).toHaveAttribute("aria-checked", "false");
  });

  it("sends no expiry unless the owner picks one, and limits the copy to one run when they do", async () => {
    assistant = offered();
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    expect(await screen.findByTestId("coding-agent-secrets-import-expiry")).toHaveValue("none");
    fireEvent.change(screen.getByTestId("coding-agent-secrets-import-expiry"), { target: { value: "run" } });
    fireEvent.click(screen.getByTestId("coding-agent-secrets-import-copy"));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ name: "GITHUB_TOKEN", scope: BOX_SCOPE, expiresAt: "run" });
    expect(await screen.findByTestId("coding-agent-secret-expiry")).toHaveTextContent(t("codingAgent.secretsExpiryRun"));
    // Still un-ticked: the expiry narrows a grant, it never makes one.
    expect(screen.getByTestId("coding-agent-secret-inject")).toHaveAttribute("aria-checked", "false");

    // And the next copy starts from "none" again.
    fireEvent.click(screen.getByTestId("coding-agent-secrets-import-open"));
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-copy"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual({ name: "NOTION_API_KEY", scope: BOX_SCOPE });
  });

  it("sends the end of the chosen day, and refuses a day already over before anything is posted", async () => {
    assistant = offered();
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    fireEvent.change(await screen.findByTestId("coding-agent-secrets-import-expiry"), { target: { value: "date" } });
    const until = await screen.findByTestId("coding-agent-secrets-import-until");

    fireEvent.change(until, { target: { value: "2001-01-01" } });
    fireEvent.click(screen.getByTestId("coding-agent-secrets-import-copy"));
    expect(await screen.findByTestId("coding-agent-secrets-error")).toHaveTextContent(t("codingAgent.secretsImportUntilInvalid"));
    expect(calls).toEqual([]);

    const day = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const input = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    fireEvent.change(until, { target: { value: input } });
    fireEvent.click(screen.getByTestId("coding-agent-secrets-import-copy"));
    await waitFor(() => expect(calls).toHaveLength(1));
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999).toISOString();
    expect(calls[0].body).toEqual({ name: "GITHUB_TOKEN", scope: BOX_SCOPE, expiresAt: end });
    expect(await screen.findByTestId("coding-agent-secret-expiry")).toHaveTextContent(
      t("codingAgent.secretsExpiryUntil", { date: new Date(end).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) }),
    );
  });

  it("says when a copy no longer reaches any run", async () => {
    secrets = [
      { name: "ONE_RUN_TOKEN", scope: BOX_SCOPE, inject: true, readable: true, createdAt: 1, updatedAt: 1, expiresAt: "run", expired: true },
      { name: "OLD_TOKEN", scope: BOX_SCOPE, inject: true, readable: true, createdAt: 1, updatedAt: 1, expiresAt: "2001-01-01T00:00:00.000Z", expired: true },
    ];
    await mounted();
    const lines = await screen.findAllByTestId("coding-agent-secret-expiry");
    expect(lines.map((line) => line.textContent)).toEqual([t("codingAgent.secretsExpiryUsed"), t("codingAgent.secretsExpired")]);
  });

  it("will not offer a name already in the list for the chosen scope", async () => {
    assistant = offered();
    secrets = [{ name: "GITHUB_TOKEN", scope: BOX_SCOPE, inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    const select = await screen.findByTestId("coding-agent-secrets-import-name") as HTMLSelectElement;
    const github = [...select.options].find((o) => o.value === "GITHUB_TOKEN")!;
    expect(github.disabled).toBe(true);
    expect(github.textContent).toBe(t("codingAgent.secretsImportHere", { name: "GITHUB_TOKEN" }));
    // The choice moved to the one that can be copied.
    expect(select.value).toBe("NOTION_API_KEY");
    // In another scope the same name is fine again.
    fireEvent.change(screen.getByTestId("coding-agent-secrets-import-scope"), { target: { value: "shop" } });
    expect(github.disabled).toBe(false);
  });

  it("says so when the assistant holds nothing to copy, and offers no copy button", async () => {
    assistant = { names: [], sources: ["hermes"] };
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    expect(await screen.findByTestId("coding-agent-secrets-import-empty")).toHaveTextContent(t("codingAgent.secretsImportEmpty"));
    expect(screen.queryByTestId("coding-agent-secrets-import-copy")).not.toBeInTheDocument();
  });

  it("words a refusal in the owner's language", async () => {
    assistant = offered();
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    await screen.findByTestId("coding-agent-secrets-import-picker");
    refuse = { status: 409, body: { error: "There is already a secret called GITHUB_TOKEN.", kind: "conflict", code: "exists" } };
    fireEvent.click(screen.getByTestId("coding-agent-secrets-import-copy"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error"))
      .toHaveTextContent(t("codingAgent.secretsRefusedExists")));
    // Still open, so the owner can pick another.
    expect(screen.getByTestId("coding-agent-secrets-import-picker")).toBeInTheDocument();
  });

  it("closes without a write on Cancel", async () => {
    assistant = offered();
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-cancel"));
    expect(screen.queryByTestId("coding-agent-secrets-import-picker")).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("says so when the assistant's key file cannot be read, rather than hiding the import", async () => {
    assistantRefusal = { status: 500, body: { error: "This ClawBox could not read the assistant's key file.", kind: "invalid", code: "source_unreadable" } };
    await mounted();
    expect(await screen.findByTestId("coding-agent-secrets-import-unreadable"))
      .toHaveTextContent(t("codingAgent.secretsImportSourceFailed"));
    expect(screen.queryByTestId("coding-agent-secrets-import-open")).not.toBeInTheDocument();
  });

  it("asks again what is on offer after a refused copy, and words a key the assistant no longer holds", async () => {
    assistant = offered();
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    await screen.findByTestId("coding-agent-secrets-import-picker");
    // The assistant's file lost GITHUB_TOKEN while the picker was open.
    refuse = { status: 404, body: { error: "The assistant holds no key called GITHUB_TOKEN.", kind: "not_found", code: "not_held" } };
    assistant = { names: [{ name: "NOTION_API_KEY", source: "hermes" }], sources: ["hermes"] };
    fireEvent.click(screen.getByTestId("coding-agent-secrets-import-copy"));

    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error"))
      .toHaveTextContent(t("codingAgent.secretsImportGone")));
    await waitFor(() => {
      const select = screen.getByTestId("coding-agent-secrets-import-name") as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(["NOTION_API_KEY"]);
    });
  });

  it("says in the owner's language that the import was switched off, and stops offering it", async () => {
    assistant = offered();
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    await screen.findByTestId("coding-agent-secrets-import-picker");
    const off = { error: "Importing keys from the assistant is switched off on this ClawBox.", kind: "disabled", code: "disabled" };
    refuse = { status: 404, body: off };
    assistantRefusal = { status: 404, body: off };
    fireEvent.click(screen.getByTestId("coding-agent-secrets-import-copy"));

    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error"))
      .toHaveTextContent(t("codingAgent.secretsImportDisabled")));
    await waitFor(() => expect(screen.queryByTestId("coding-agent-secrets-import")).not.toBeInTheDocument());
  });

  it("fills in the floor when a copy is refused as too short", async () => {
    assistant = offered();
    await mounted();
    fireEvent.click(await screen.findByTestId("coding-agent-secrets-import-open"));
    await screen.findByTestId("coding-agent-secrets-import-picker");
    refuse = { status: 400, body: { error: "too short", kind: "invalid", code: "value_too_short" } };
    fireEvent.click(screen.getByTestId("coding-agent-secrets-import-copy"));

    const alert = await screen.findByTestId("coding-agent-secrets-error");
    await waitFor(() => expect(alert).toHaveTextContent(t("codingAgent.secretsRefusedShort", { n: MIN_SECRET_VALUE_CHARS })));
    expect(alert.textContent).not.toContain("{n}");
  });
});
