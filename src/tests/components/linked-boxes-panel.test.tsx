import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import LinkedBoxesPanel from "@/components/LinkedBoxesPanel";
import { LINKED_BOXES_CHANGED_EVENT, LINKED_BOXES_URL } from "@/lib/box-switcher";
import { translations } from "@/lib/translations";

/**
 * Settings → Linked ClawBoxes (TASK-2519), against a fake
 * `/setup-api/linked-boxes` that keeps what it is sent: this box fixed as
 * number 1, add / move / remove saving the whole list, every refusal in the
 * owner's words, and this box's own addresses offered for the other boxes.
 * Strings come from the real catalogue.
 */

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const { translations: table } = await import("@/lib/translations");
  const t = (key: string, params?: Record<string, string | number>) => {
    let s = table.en[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
  return {
    ...actual,
    useT: () => ({ t, locale: "en", localeResolved: true, setLocale: () => {} }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

const en = translations.en;
const tx = (key: string, params: Record<string, string | number> = {}) => {
  let s = en[key];
  if (!s) throw new Error(`catalogue has no ${key}`);
  for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};

type Box = { name: string; url: string };
let server: { boxes: Box[]; refuse: string | null; tunnel: Record<string, unknown>; host: Record<string, unknown> };
let puts: Box[][];
const realFetch = globalThis.fetch;

beforeEach(() => {
  server = {
    boxes: [],
    refuse: null,
    tunnel: { mode: "named", hostname: "mainbox.example.com", tunnelUrl: "https://mainbox.example.com" },
    host: { hostname: "mainbox", fqdn: "mainbox.local", ipv4: "192.0.2.10" },
  };
  puts = [];
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === LINKED_BOXES_URL && (!init || !init.method || init.method === "GET")) {
      return new Response(JSON.stringify({ self: { name: "mainbox" }, boxes: server.boxes, max: 8 }), { status: 200 });
    }
    if (url === LINKED_BOXES_URL && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { boxes: Box[] };
      puts.push(body.boxes);
      if (server.refuse) return new Response(JSON.stringify({ code: server.refuse, error: "no" }), { status: 400 });
      server.boxes = body.boxes;
      return new Response(JSON.stringify({ self: { name: "mainbox" }, boxes: server.boxes, max: 8 }), { status: 200 });
    }
    if (url === "/setup-api/tunnel/status") return new Response(JSON.stringify(server.tunnel), { status: 200 });
    if (url === "/setup-api/system/hostname") return new Response(JSON.stringify(server.host), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function addBox(name: string, url: string) {
  fireEvent.change(screen.getByTestId("linked-boxes-name-input"), { target: { value: name } });
  fireEvent.change(screen.getByTestId("linked-boxes-url-input"), { target: { value: url } });
  fireEvent.click(screen.getByTestId("linked-boxes-add"));
}

describe("Settings → Linked ClawBoxes", () => {
  it("shows this box as number 1, fixed, with the shortcut and the help", async () => {
    render(<LinkedBoxesPanel />);
    const first = await screen.findByTestId("linked-boxes-row-1");
    expect(within(first).getByText("mainbox")).toBeInTheDocument();
    expect(within(first).getByText(tx("settings.linkedBoxes.thisBox"))).toBeInTheDocument();
    expect(within(first).getByText(`${window.location.origin}/`)).toBeInTheDocument();
    expect(within(first).getByText("Ctrl+Shift+1")).toBeInTheDocument();
    expect(within(first).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("linked-boxes-empty")).toHaveTextContent(tx("settings.linkedBoxes.empty"));
    const help = screen.getByTestId("linked-boxes-help");
    for (const k of ["howBrowser", "howReturn", "howKiosk", "howFrames"]) {
      expect(help).toHaveTextContent(tx(`settings.linkedBoxes.${k}`));
    }
  });

  it("adds a box, saves the whole list and tells the switcher", async () => {
    const changed = vi.fn();
    window.addEventListener(LINKED_BOXES_CHANGED_EVENT, changed);
    try {
      render(<LinkedBoxesPanel />);
      await screen.findByTestId("linked-boxes-add-form");
      await addBox("  Laptop ", "laptop.example.com/login");
      const row = await screen.findByTestId("linked-boxes-row-2");
      expect(within(row).getByText("Laptop")).toBeInTheDocument();
      expect(within(row).getByText("http://laptop.example.com/")).toBeInTheDocument();
      expect(within(row).getByText("Ctrl+Shift+2")).toBeInTheDocument();
      expect(puts).toEqual([[{ name: "Laptop", url: "http://laptop.example.com/" }]]);
      expect(changed).toHaveBeenCalledTimes(1);
      // The form is ready for the next one.
      expect(screen.getByTestId("linked-boxes-name-input")).toHaveValue("");
      expect(screen.getByTestId("linked-boxes-url-input")).toHaveValue("");
    } finally {
      window.removeEventListener(LINKED_BOXES_CHANGED_EVENT, changed);
    }
  });

  it("moves and removes, each a save of the whole list", async () => {
    server.boxes = [{ name: "Laptop", url: "https://laptop.example.com/" }, { name: "NAS", url: "http://nas.example.net/" }];
    render(<LinkedBoxesPanel />);
    await screen.findByTestId("linked-boxes-row-3");
    expect(screen.getByTestId("linked-boxes-up-2")).toBeDisabled();
    expect(screen.getByTestId("linked-boxes-down-3")).toBeDisabled();
    expect(screen.getByTestId("linked-boxes-down-2")).toHaveAccessibleName(tx("settings.linkedBoxes.moveDown", { name: "Laptop" }));

    fireEvent.click(screen.getByTestId("linked-boxes-down-2"));
    await waitFor(() => expect(within(screen.getByTestId("linked-boxes-row-2")).getByText("NAS")).toBeInTheDocument());
    expect(puts.at(-1)!.map((b) => b.name)).toEqual(["NAS", "Laptop"]);

    fireEvent.click(screen.getByTestId("linked-boxes-up-3"));
    await waitFor(() => expect(within(screen.getByTestId("linked-boxes-row-2")).getByText("Laptop")).toBeInTheDocument());
    expect(puts.at(-1)!.map((b) => b.name)).toEqual(["Laptop", "NAS"]);

    fireEvent.click(screen.getByTestId("linked-boxes-remove-2"));
    await waitFor(() => expect(screen.queryByTestId("linked-boxes-row-3")).toBeNull());
    expect(puts.at(-1)).toEqual([{ name: "NAS", url: "http://nas.example.net/" }]);
  });

  it("refuses a bad address, this box itself and a box already listed, before saving", async () => {
    server.boxes = [{ name: "Laptop", url: "https://laptop.example.com/" }];
    render(<LinkedBoxesPanel />);
    await screen.findByTestId("linked-boxes-row-2");
    await waitFor(() => expect(screen.getByTestId("linked-boxes-own-addresses")).toBeInTheDocument());

    const cases: [string, string, string][] = [
      ["Bad", "javascript:alert(1)", "invalidUrl"],
      ["Me", window.location.origin, "self"],
      // This box under its other addresses is still this box.
      ["Me too", "mainbox.local:3000", "self"],
      ["Me three", "https://mainbox.example.com/", "self"],
      // A loopback address is the machine the browser runs on.
      ["Loop", "localhost:3005", "self"],
      ["Again", "https://LAPTOP.example.com/x", "duplicate"],
    ];
    for (const [name, url, key] of cases) {
      await addBox(name, url);
      expect(await screen.findByTestId("linked-boxes-error"), `${url}`).toHaveTextContent(tx(`settings.linkedBoxes.error.${key}`));
    }
    expect(puts).toEqual([]);
  });

  it("says why the box refused a list, and keeps the list it has", async () => {
    server.refuse = "too_many";
    render(<LinkedBoxesPanel />);
    await screen.findByTestId("linked-boxes-add-form");
    await addBox("Laptop", "https://laptop.example.com");
    expect(await screen.findByTestId("linked-boxes-error")).toHaveTextContent(tx("settings.linkedBoxes.error.tooMany"));
    expect(screen.queryByTestId("linked-boxes-row-2")).toBeNull();
    server.refuse = "whatever_else";
    await addBox("Laptop", "https://laptop.example.com");
    await waitFor(() => expect(screen.getByTestId("linked-boxes-error")).toHaveTextContent(tx("settings.linkedBoxes.error.saveFailed")));
  });

  it("takes no ninth box", async () => {
    server.boxes = Array.from({ length: 8 }, (_, i) => ({ name: `Box ${i + 2}`, url: `https://b${i}.example.com/` }));
    render(<LinkedBoxesPanel />);
    await screen.findByTestId("linked-boxes-row-9");
    expect(screen.getByText(tx("settings.linkedBoxes.full"))).toBeInTheDocument();
    expect(screen.getByTestId("linked-boxes-name-input")).toBeDisabled();
    expect(screen.getByTestId("linked-boxes-url-input")).toBeDisabled();
    expect(screen.getByTestId("linked-boxes-add")).toBeDisabled();
  });

  it("offers this box's own lasting addresses to add on the others", async () => {
    render(<LinkedBoxesPanel />);
    const card = await screen.findByTestId("linked-boxes-own-addresses");
    // jsdom serves the page on port 3000: the LAN addresses carry it.
    expect(within(card).getAllByTestId(/^linked-boxes-own-address-/).map((el) => el.textContent)).toEqual([
      "https://mainbox.example.com/",
      "http://mainbox.local:3000/",
      "http://192.0.2.10:3000/",
    ]);
  });

  it("never offers a quick tunnel's address, which changes with every start", async () => {
    server.tunnel = { mode: "quick", hostname: null, tunnelUrl: "https://random-words.trycloudflare.com" };
    render(<LinkedBoxesPanel />);
    const card = await screen.findByTestId("linked-boxes-own-addresses");
    expect(card).not.toHaveTextContent("trycloudflare");
  });

  it("says so when the list cannot be read, and reads it again on Try again", async () => {
    const ok = globalThis.fetch;
    let fail = true;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === LINKED_BOXES_URL && fail) return new Response("{}", { status: 500 });
      return (ok as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    render(<LinkedBoxesPanel />);
    expect(await screen.findByText(tx("settings.linkedBoxes.error.loadFailed"))).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByText(tx("settings.linkedBoxes.retry")));
    expect(await screen.findByTestId("linked-boxes-row-1")).toBeInTheDocument();
  });
});
