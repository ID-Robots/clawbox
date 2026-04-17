import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ClawKeepStatus } from "@/lib/clawkeep";

vi.mock("@/lib/clawkeep", () => ({
  configureClawKeepTargets: vi.fn(),
  getClawKeepStatus: vi.fn(),
  initClawKeep: vi.fn(),
  snapClawKeep: vi.fn(),
  syncClawKeep: vi.fn(),
}));

import {
  configureClawKeepTargets,
  getClawKeepStatus,
  initClawKeep,
  snapClawKeep,
  syncClawKeep,
} from "@/lib/clawkeep";

const mockConfigureClawKeepTargets = vi.mocked(configureClawKeepTargets);
const mockGetClawKeepStatus = vi.mocked(getClawKeepStatus);
const mockInitClawKeep = vi.mocked(initClawKeep);
const mockSnapClawKeep = vi.mocked(snapClawKeep);
const mockSyncClawKeep = vi.mocked(syncClawKeep);

function makeClawKeepStatus(partial: Partial<ClawKeepStatus>): ClawKeepStatus {
  return {
    initialized: false,
    sourcePath: "Documents",
    sourceAbsolutePath: "/home/clawbox/Documents",
    sourceExists: true,
    backup: {
      mode: null,
      passwordSet: false,
      workspaceId: null,
      chunkCount: 0,
      lastSync: null,
      lastSyncCommit: null,
      local: {
        enabled: false,
        path: null,
        lastSync: null,
        ready: false,
      },
      cloud: {
        enabled: false,
        connected: false,
        available: true,
        providerLabel: "ClawBox AI",
        endpoint: null,
        lastSync: null,
      },
    },
    headCommit: null,
    trackedFiles: 0,
    totalSnaps: 0,
    dirtyFiles: 0,
    clean: true,
    recent: [],
    ...partial,
  };
}

function jsonRequest(body: unknown) {
  return new NextRequest("http://localhost/setup-api/clawkeep", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/setup-api/clawkeep", () => {
  let clawKeepGet: (req: NextRequest) => Promise<Response>;
  let clawKeepPost: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/clawkeep/route");
    clawKeepGet = mod.GET;
    clawKeepPost = mod.POST;
  });

  it("rejects blank sourcePath on GET", async () => {
    const res = await clawKeepGet(new NextRequest("http://localhost/setup-api/clawkeep?sourcePath=%20%20"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "sourcePath is required" });
    expect(mockGetClawKeepStatus).not.toHaveBeenCalled();
  });

  it("returns GET status when sourcePath is valid", async () => {
    mockGetClawKeepStatus.mockResolvedValueOnce(makeClawKeepStatus({ initialized: true, sourcePath: "Documents" }));

    const res = await clawKeepGet(new NextRequest("http://localhost/setup-api/clawkeep?sourcePath=Documents"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ initialized: true, sourcePath: "Documents" });
    expect(mockGetClawKeepStatus).toHaveBeenCalledWith("Documents");
  });

  it("rejects configure when no local or cloud destination is selected", async () => {
    const res = await clawKeepPost(jsonRequest({
      action: "configure",
      sourcePath: "Documents",
      localPath: "   ",
      cloudEnabled: false,
      password: "12345678",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Choose a local folder, cloud backup, or both" });
    expect(mockConfigureClawKeepTargets).not.toHaveBeenCalled();
  });

  it("routes configure requests to configureClawKeepTargets", async () => {
    mockConfigureClawKeepTargets.mockResolvedValueOnce({ message: "Saved" } as Awaited<ReturnType<typeof configureClawKeepTargets>>);

    const res = await clawKeepPost(jsonRequest({
      action: "configure",
      sourcePath: "Documents",
      localPath: "Backups/clawkeep",
      cloudEnabled: true,
      password: "super-secret",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ message: "Saved" });
    expect(mockConfigureClawKeepTargets).toHaveBeenCalledWith("Documents", {
      localPath: "Backups/clawkeep",
      cloudEnabled: true,
      password: "super-secret",
    });
  });

  it("routes init, snap, and sync actions to the matching handlers", async () => {
    mockInitClawKeep.mockResolvedValueOnce(makeClawKeepStatus({ initialized: true }) as Awaited<ReturnType<typeof initClawKeep>>);
    mockSnapClawKeep.mockResolvedValueOnce({ message: "Snapped" } as Awaited<ReturnType<typeof snapClawKeep>>);
    mockSyncClawKeep.mockResolvedValueOnce({ message: "Synced" } as Awaited<ReturnType<typeof syncClawKeep>>);

    const initRes = await clawKeepPost(jsonRequest({ action: "init", sourcePath: "Documents" }));
    const snapRes = await clawKeepPost(jsonRequest({ action: "snap", sourcePath: "Documents", message: "manual" }));
    const syncRes = await clawKeepPost(jsonRequest({ action: "sync", sourcePath: "Documents" }));

    expect(initRes.status).toBe(200);
    expect(await initRes.json()).toMatchObject({ initialized: true });
    expect(mockInitClawKeep).toHaveBeenCalledWith("Documents");

    expect(snapRes.status).toBe(200);
    expect(await snapRes.json()).toEqual({ message: "Snapped" });
    expect(mockSnapClawKeep).toHaveBeenCalledWith("Documents", "manual");

    expect(syncRes.status).toBe(200);
    expect(await syncRes.json()).toEqual({ message: "Synced" });
    expect(mockSyncClawKeep).toHaveBeenCalledWith("Documents");
  });
});
