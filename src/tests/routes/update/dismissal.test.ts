import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sqlite-store", () => ({
  sqliteGet: vi.fn(),
  sqliteSet: vi.fn(),
  sqliteDelete: vi.fn(),
}));

import { sqliteDelete, sqliteGet, sqliteSet } from "@/lib/sqlite-store";

const mockSqliteGet = vi.mocked(sqliteGet);
const mockSqliteSet = vi.mocked(sqliteSet);
const mockSqliteDelete = vi.mocked(sqliteDelete);

describe("update dismissal route", () => {
  let getDismissal: () => Promise<Response>;
  let postDismissal: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockSqliteGet.mockResolvedValue("v2.2.3|2026.4.6");
    mockSqliteSet.mockResolvedValue();
    mockSqliteDelete.mockResolvedValue();

    const mod = await import("@/app/setup-api/update/dismissal/route");
    getDismissal = mod.GET;
    postDismissal = mod.POST;
  });

  it("returns the stored dismissal fingerprint", async () => {
    const response = await getDismissal();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fingerprint: "v2.2.3|2026.4.6",
    });
  });

  it("returns 500 when reading the fingerprint fails", async () => {
    mockSqliteGet.mockRejectedValueOnce(new Error("db offline"));

    const response = await getDismissal();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "db offline" });
  });

  it("rejects invalid JSON bodies", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    const response = await postDismissal(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
  });

  it("persists a fingerprint", async () => {
    const response = await postDismissal(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: "v2.2.3|2026.4.6" }),
    }));

    expect(response.status).toBe(200);
    expect(mockSqliteSet).toHaveBeenCalledWith("update:dismissed-versions", "v2.2.3|2026.4.6");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("clears the dismissal when fingerprint is null", async () => {
    const response = await postDismissal(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: null }),
    }));

    expect(response.status).toBe(200);
    expect(mockSqliteDelete).toHaveBeenCalledWith("update:dismissed-versions");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects non-string fingerprints", async () => {
    const response = await postDismissal(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: 123 }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid fingerprint" });
  });

  it("rejects fingerprints longer than the supported limit", async () => {
    const response = await postDismissal(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: "x".repeat(201) }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid fingerprint" });
  });

  it("returns 500 when persisting fails", async () => {
    mockSqliteSet.mockRejectedValueOnce(new Error("write failed"));

    const response = await postDismissal(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: "v2.2.3|2026.4.6" }),
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "write failed" });
  });

  it("returns a generic 500 error for non-Error write failures", async () => {
    mockSqliteDelete.mockRejectedValueOnce("write failed");

    const response = await postDismissal(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint: null }),
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to write dismissal" });
  });
});
