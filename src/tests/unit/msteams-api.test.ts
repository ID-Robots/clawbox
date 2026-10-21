import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  TeamsAuthError,
  TeamsUnavailableError,
  checkTeamsCredentials,
  isTeamsAppId,
  isTeamsTenantId,
} from "@/lib/msteams-api";

// The check is the bot's own token request. A verdict about the values must
// name which value is wrong; anything about Microsoft (throttling, outage,
// network) must never read as "wrong secret".

const APP = "11111111-2222-3333-4444-555555555555";
const TENANT = "66666666-7777-8888-9999-000000000000";
const SECRET = ["clawbox", "test", "not", "a", "real", "secret"].join("~");

let fetchMock: ReturnType<typeof vi.fn>;

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("identifier shapes", () => {
  it("takes GUIDs, and a tenant by its domain", () => {
    expect(isTeamsAppId(APP)).toBe(true);
    expect(isTeamsAppId("not-a-guid")).toBe(false);
    expect(isTeamsTenantId(TENANT)).toBe(true);
    expect(isTeamsTenantId("contoso.onmicrosoft.com")).toBe(true);
    for (const bad of ["contoso", "a/b.com", "../x.com", "x .com", ""]) expect(isTeamsTenantId(bad)).toBe(false);
  });
});

describe("checkTeamsCredentials", () => {
  it("asks for a Bot Framework token for the app, in the tenant, with the secret in the body", async () => {
    answer(200, { access_token: "x", token_type: "Bearer" });
    await expect(checkTeamsCredentials(APP, SECRET, TENANT)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(url).not.toContain(SECRET);
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(APP);
    expect(form.get("client_secret")).toBe(SECRET);
    expect(form.get("scope")).toBe("https://api.botframework.com/.default");
  });

  it.each([
    [{ error: "invalid_client", error_codes: [7000215] }, "secret_rejected"],
    [{ error: "invalid_client", error_codes: [7000222] }, "secret_rejected"],
    [{ error: "unauthorized_client", error_codes: [700016] }, "app_not_found"],
    [{ error: "invalid_request", error_codes: [90002] }, "tenant_not_found"],
    [{ error: "invalid_request", error_description: "AADSTS900023: Specified tenant identifier is neither a valid DNS name" }, "tenant_not_found"],
    [{ error: "invalid_client" }, "secret_rejected"],
  ])("reads %j as %s", async (body, problem) => {
    answer(400, body);
    await expect(checkTeamsCredentials(APP, SECRET, TENANT)).rejects.toMatchObject({ problem });
  });

  it("calls throttling, an outage, an unknown error or no network unavailable", async () => {
    answer(429, { error: "invalid_client", error_codes: [7000215] });
    await expect(checkTeamsCredentials(APP, SECRET, TENANT)).rejects.toBeInstanceOf(TeamsUnavailableError);
    answer(503, {});
    await expect(checkTeamsCredentials(APP, SECRET, TENANT)).rejects.toBeInstanceOf(TeamsUnavailableError);
    answer(400, { error: "temporarily_unavailable" });
    await expect(checkTeamsCredentials(APP, SECRET, TENANT)).rejects.toBeInstanceOf(TeamsUnavailableError);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(checkTeamsCredentials(APP, SECRET, TENANT)).rejects.toBeInstanceOf(TeamsUnavailableError);
  });

  it("refuses malformed identifiers without calling Microsoft", async () => {
    await expect(checkTeamsCredentials("nope", SECRET, TENANT)).rejects.toBeInstanceOf(TeamsAuthError);
    await expect(checkTeamsCredentials(APP, SECRET, "../evil")).rejects.toMatchObject({ problem: "tenant_not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
