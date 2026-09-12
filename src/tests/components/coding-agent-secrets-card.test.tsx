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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSecretsCard from "@/components/CodingAgentSecretsCard";

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
    if (url.startsWith("/setup-api/coding-agent/enable")) {
      if (refuse) { const r = refuse; refuse = null; return json(r.body, r.status); }
      if (body && typeof body.injectSecrets === "boolean") injectSecrets = body.injectSecrets;
      return json(payload());
    }
    if (url.startsWith("/setup-api/coding-agent/secrets")) {
      if (method === "GET") return json(payload());
      if (refuse) { const r = refuse; refuse = null; return json(r.body, r.status); }
      if (method === "DELETE") {
        const name = new URL(url, "http://x").searchParams.get("name");
        secrets = secrets.filter((s) => (s as { name: string }).name !== name);
      } else if (body && typeof body.value === "string") {
        secrets = [...secrets, { name: body.name, scope: body.scope ?? "box", inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
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
    secrets = [{ name: "VERCEL_TOKEN", scope: "box", inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
    await mounted();
    const row = await screen.findByTestId("coding-agent-secret-row");
    expect(row).toHaveTextContent("VERCEL_TOKEN");
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
      { name: "OLD_TOKEN", scope: "box", inject: true, readable: false, createdAt: 1, updatedAt: 1 },
      { name: "NEW_TOKEN", scope: "box", inject: true, readable: true, createdAt: 1, updatedAt: 1 },
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
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "VERCEL_TOKEN" } });
    fireEvent.change(value, { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));

    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-saved")).toBeInTheDocument());
    expect(value).toHaveValue("");
    expect(screen.getByTestId("coding-agent-secret-name")).toHaveValue("");
    // The confirmation names the entry and says the value is gone for good.
    expect(screen.getByTestId("coding-agent-secrets-saved")).toHaveTextContent("VERCEL_TOKEN");
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
    fireEvent.change(screen.getByTestId("coding-agent-secret-name"), { target: { value: "VERCEL_TOKEN" } });
    fireEvent.click(screen.getByTestId("coding-agent-secret-add"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error")).toHaveTextContent("Type the value first."));
    expect(calls).toHaveLength(0);
  });
});

describe("the two switches", () => {
  it("posts the master switch to the switch route, not to the store", async () => {
    await mounted();
    fireEvent.click(screen.getByTestId("coding-agent-secrets-inject"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/setup-api/coding-agent/enable");
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
    secrets = [{ name: "VERCEL_TOKEN", scope: "box", inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
    await mounted();
    await screen.findByTestId("coding-agent-secret-row");
    // A card that claimed the list was empty would invite the owner to
    // re-enter a credential that is already there.
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "gone" }, 500)));
    fireEvent.click(screen.getByTestId("coding-agent-secrets-inject"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-secrets-error")).toBeInTheDocument());
    expect(screen.getByTestId("coding-agent-secret-row")).toHaveTextContent("VERCEL_TOKEN");
  });
});

describe("one write at a time", () => {
  it("disables the other controls while a write is in flight", async () => {
    secrets = [{ name: "VERCEL_TOKEN", scope: "box", inject: true, readable: true, createdAt: 1, updatedAt: 1 }];
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
