/**
 * "Publish to ClawBox Store" (src/components/StorePublishDialog.tsx): the box
 * is asked first, and the dialog shows the connect prompt, the coming-soon
 * modal or the form — and turns a `coming_soon` publish into the modal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import StorePublishDialog from "@/components/StorePublishDialog";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));
const dispatchOpenSettingsSection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ui-events", () => ({ dispatchOpenSettingsSection }));

const PROJECT = { name: "Tinder Clone", slug: "tinder-clone", description: "Swipe", suggestedVersion: "1.0.0", published: null };
const fetchMock = vi.fn();
let onClose: () => void;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function status(body: Record<string, unknown>) {
  return json(200, { ok: true, linked: true, canPublish: true, apps: [], upgradeUrl: "https://portal.example/portal/apps", portalUrl: "https://portal.example", project: PROJECT, ...body });
}

beforeEach(() => {
  onClose = vi.fn();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StorePublishDialog", () => {
  it("asks the box for the project, then offers the form with the manifest's name read-only", async () => {
    fetchMock.mockResolvedValueOnce(status({}));
    render(<StorePublishDialog projectId="tinder-clone" onClose={onClose} />);
    expect(fetchMock.mock.calls[0][0]).toBe("/setup-api/apps/publish?projectId=tinder-clone");
    const name = await screen.findByTestId("store-publish-name");
    expect(name).toHaveValue("Tinder Clone");
    expect(name).toHaveAttribute("readonly");
    expect(screen.getByTestId("store-publish-slug")).toHaveValue("tinder-clone");
    expect(screen.getByTestId("store-publish-version")).toHaveValue("1.0.0");
    expect(screen.getByTestId("store-publish-description")).toHaveValue("Swipe");
  });

  it("names the row's directory in both requests, so a name two projects share is never guessed at", async () => {
    fetchMock
      .mockResolvedValueOnce(status({}))
      .mockResolvedValueOnce(json(201, { ok: true, app: { name: "Tinder Clone", version: "1.0.0" }, created: true, storeUrl: "https://portal.example/portal/apps" }));
    render(<StorePublishDialog projectId="tinder-clone" directory="/home/clawbox/Projects/tinder-clone" onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("store-publish-submit"));
    await screen.findByTestId("store-publish-done");
    expect(fetchMock.mock.calls[0][0]).toBe("/setup-api/apps/publish?projectId=tinder-clone&directory=%2Fhome%2Fclawbox%2FProjects%2Ftinder-clone");
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({ projectId: "tinder-clone", directory: "/home/clawbox/Projects/tinder-clone" });
  });

  it("starts from the version after the Store's", async () => {
    fetchMock.mockResolvedValueOnce(status({ project: { ...PROJECT, published: { version: "1.4.2" }, suggestedVersion: "1.4.3" } }));
    render(<StorePublishDialog projectId="tinder-clone" onClose={onClose} />);
    expect(await screen.findByTestId("store-publish-version")).toHaveValue("1.4.3");
    expect(screen.getByTestId("store-publish-published")).toHaveTextContent("1.4.2");
  });

  it("publishes what the owner typed and shows the entry", async () => {
    fetchMock
      .mockResolvedValueOnce(status({}))
      .mockResolvedValueOnce(json(201, { ok: true, app: { name: "Tinder Clone", version: "1.0.1" }, created: true, storeUrl: "https://portal.example/portal/apps" }));
    const toasts: unknown[] = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener("clawbox:toast", onToast);
    render(<StorePublishDialog projectId="tinder-clone" onClose={onClose} />);
    fireEvent.change(await screen.findByTestId("store-publish-version"), { target: { value: "1.0.1" } });
    fireEvent.change(screen.getByTestId("store-publish-icon-url"), { target: { value: "https://i.example/icon.png" } });
    fireEvent.click(screen.getByTestId("store-publish-submit"));
    expect(await screen.findByTestId("store-publish-done")).toHaveTextContent("Tinder Clone 1.0.1 is in the ClawBox Store.");
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/setup-api/apps/publish");
    expect(JSON.parse(String(init.body))).toEqual({ projectId: "tinder-clone", version: "1.0.1", slug: "tinder-clone", description: "Swipe", iconUrl: "https://i.example/icon.png" });
    expect(toasts).toEqual([expect.objectContaining({ message: "Tinder Clone 1.0.1 is in the ClawBox Store." })]);
    window.removeEventListener("clawbox:toast", onToast);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(screen.getByTestId("store-publish-view"));
    expect(open).toHaveBeenCalledWith("https://portal.example/portal/apps", "_blank", "noopener,noreferrer");
  });

  it("shows coming soon, with the portal's message and the website, when the account cannot publish", async () => {
    fetchMock.mockResolvedValueOnce(status({ canPublish: false, code: "coming_soon", message: "The Developer plan opens publishing." }));
    render(<StorePublishDialog projectId="tinder-clone" onClose={onClose} />);
    expect(await screen.findByTestId("store-publish-coming-soon")).toHaveTextContent("The Developer plan opens publishing.");
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Publishing is coming soon with the Developer plan");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(screen.getByTestId("store-publish-open-website"));
    expect(open).toHaveBeenCalledWith("https://portal.example/portal/apps", "_blank", "noopener,noreferrer");
    expect(screen.queryByTestId("store-publish-form")).toBeNull();
  });

  it("turns a coming_soon publish into the coming-soon modal", async () => {
    fetchMock
      .mockResolvedValueOnce(status({}))
      .mockResolvedValueOnce(json(403, { ok: false, code: "coming_soon", message: "Not yet.", upgradeUrl: "https://portal.example/portal/apps" }));
    render(<StorePublishDialog projectId="tinder-clone" onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("store-publish-submit"));
    expect(await screen.findByTestId("store-publish-coming-soon")).toHaveTextContent("Not yet.");
  });

  it("asks to connect the ClawBox account first when the box has none, and opens Settings there", async () => {
    fetchMock.mockResolvedValueOnce(status({ linked: false, canPublish: false, code: "not_linked" }));
    render(<StorePublishDialog projectId="tinder-clone" onClose={onClose} />);
    expect(await screen.findByTestId("store-publish-connect")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("store-publish-open-settings"));
    expect(dispatchOpenSettingsSection).toHaveBeenCalledWith("ai");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps a refusal next to the field it is about", async () => {
    fetchMock
      .mockResolvedValueOnce(status({}))
      .mockResolvedValueOnce(json(409, { ok: false, code: "slug_taken", message: "That slug is taken.", field: "slug" }));
    render(<StorePublishDialog projectId="tinder-clone" onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("store-publish-submit"));
    expect(await screen.findByTestId("store-publish-error-slug")).toHaveTextContent("That slug is taken.");
    await waitFor(() => expect(screen.getByTestId("store-publish-submit")).not.toBeDisabled());
  });
});
