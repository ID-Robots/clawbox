import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";

const baseStatus = {
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
      endpoint: "https://openclawhardware.dev/api/clawkeep/device-backups",
      lastSync: null,
    },
  },
  headCommit: null,
  trackedFiles: 0,
  totalSnaps: 0,
  dirtyFiles: 0,
  clean: true,
  recent: [],
};

describe("ClawKeepApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function getCloudToggle() {
    return screen.getByTestId("cloud-toggle");
  }

  it("shows the ClawBox AI connect action when cloud backup is enabled but disconnected", async () => {
    const onOpenAiProviderSettings = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => baseStatus,
          text: async () => JSON.stringify(baseStatus),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ClawKeepApp onOpenAiProviderSettings={onOpenAiProviderSettings} />);

    await screen.findByText("Back up one folder");
    const cloudToggle = getCloudToggle();
    fireEvent.click(cloudToggle);

    const connectButton = await screen.findByRole("button", { name: "Connect ClawBox AI" });
    fireEvent.click(connectButton);

    expect(onOpenAiProviderSettings).toHaveBeenCalledTimes(1);
  });

  it("saves a local backup plan with the configured password", async () => {
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => baseStatus,
          text: async () => JSON.stringify(baseStatus),
        });
      }
      if (url === "/setup-api/clawkeep" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ message: "Saved plan" }),
          text: async () => JSON.stringify({ message: "Saved plan" }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ClawKeepApp />);

    await screen.findByText("Back up one folder");

    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "  super-secret  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/clawkeep", expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePath: "Documents",
          action: "configure",
          localPath: "Backups/clawkeep",
          cloudEnabled: false,
          password: "super-secret",
        }),
      }));
    });
  });

  it("runs init, configure, snap, and sync when turning on backup for the first time", async () => {
    const postBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return {
          ok: true,
          json: async () => baseStatus,
          text: async () => JSON.stringify(baseStatus),
        };
      }
      if (url === "/setup-api/clawkeep" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        postBodies.push(body);
        const action = body.action;
        if (action === "init") {
          return {
            ok: true,
            json: async () => ({ initialized: true }),
            text: async () => JSON.stringify({ initialized: true }),
          };
        }
        if (action === "configure") {
          return {
            ok: true,
            json: async () => ({ status: { ...baseStatus, initialized: true, backup: { ...baseStatus.backup, passwordSet: true, local: { ...baseStatus.backup.local, enabled: true, path: "/home/clawbox/Backups/clawkeep", ready: true } } }, message: "Saved plan" }),
            text: async () => "",
          };
        }
        if (action === "snap") {
          return {
            ok: true,
            json: async () => ({ message: "Snapped" }),
            text: async () => "",
          };
        }
        if (action === "sync") {
          return {
            ok: true,
            json: async () => ({ status: { ...baseStatus, initialized: true, backup: { ...baseStatus.backup, mode: "local", passwordSet: true, local: { ...baseStatus.backup.local, enabled: true, path: "/home/clawbox/Backups/clawkeep", ready: true }, lastSync: new Date().toISOString() } }, message: "Backed up to local." }),
            text: async () => "",
          };
        }
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ClawKeepApp />);

    await screen.findByText("Back up one folder");

    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "super-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on backup" }));

    await waitFor(() => {
      expect(postBodies.map((body) => body.action)).toEqual(["init", "configure", "snap", "sync"]);
    });

    expect(postBodies[1]).toMatchObject({
      sourcePath: "Documents",
      action: "configure",
      localPath: "Backups/clawkeep",
      cloudEnabled: false,
      password: "super-secret",
    });
    expect(postBodies[2]).toMatchObject({
      sourcePath: "Documents",
      action: "snap",
    });
  });

  it("shows a password error before the first backup when no password is set", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => baseStatus,
          text: async () => JSON.stringify(baseStatus),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ClawKeepApp />);

    await screen.findByText("Back up one folder");
    fireEvent.click(screen.getByRole("button", { name: "Turn on backup" }));

    expect(await screen.findByText("Choose a password with at least 8 characters before turning on backup.")).toBeInTheDocument();
  });

  it("requires a password before saving settings for the first time", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => baseStatus,
          text: async () => JSON.stringify(baseStatus),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ClawKeepApp />);

    await screen.findByText("Back up one folder");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByText("Choose a password with at least 8 characters.")).toBeInTheDocument();
  });

  it("switches to cloud-only mode and hides the local folder input", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => baseStatus,
          text: async () => JSON.stringify(baseStatus),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ClawKeepApp />);

    await screen.findByText("Back up one folder");
    fireEvent.click(getCloudToggle());

    expect(screen.queryByPlaceholderText("Backups/clawkeep")).not.toBeInTheDocument();
    expect(screen.getByText("Connect ClawBox AI first.")).toBeInTheDocument();
  });

  it("supports both destinations and saves an updated local folder", async () => {
    const connectedCloudStatus = {
      ...baseStatus,
      backup: {
        ...baseStatus.backup,
        cloud: {
          ...baseStatus.backup.cloud,
          connected: true,
        },
      },
    };
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => connectedCloudStatus,
          text: async () => JSON.stringify(connectedCloudStatus),
        });
      }
      if (url === "/setup-api/clawkeep" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ message: "Saved settings" }),
          text: async () => JSON.stringify({ message: "Saved settings" }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ClawKeepApp />);

    await screen.findByText("Back up one folder");
    fireEvent.click(screen.getByRole("button", { name: "Both" }));
    fireEvent.change(screen.getByPlaceholderText("Backups/clawkeep"), {
      target: { value: "Vault/clawkeep" },
    });
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "super-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/clawkeep", expect.objectContaining({
        body: JSON.stringify({
          sourcePath: "Documents",
          action: "configure",
          localPath: "Vault/clawkeep",
          cloudEnabled: true,
          password: "super-secret",
        }),
      }));
    });
  });

  it("shows connected cloud state, saved password placeholder, and the latest snap", async () => {
    const connectedStatus = {
      ...baseStatus,
      initialized: true,
      backup: {
        ...baseStatus.backup,
        mode: "both" as const,
        passwordSet: true,
        chunkCount: 3,
        lastSync: new Date(Date.now() - 60_000).toISOString(),
        local: {
          ...baseStatus.backup.local,
          enabled: true,
          path: "/home/clawbox/Backups/clawkeep",
          ready: true,
        },
        cloud: {
          ...baseStatus.backup.cloud,
          enabled: true,
          connected: true,
        },
      },
      recent: [{
        hash: "abc123",
        date: new Date(Date.now() - 60_000).toISOString(),
        message: "nightly backup",
      }],
    };
    vi.stubGlobal("fetch", vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => connectedStatus,
          text: async () => JSON.stringify(connectedStatus),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ClawKeepApp />);

    await screen.findByRole("button", { name: "Back up now" });
    expect(screen.getByDisplayValue("Backups/clawkeep")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Leave blank to keep your current password")).toBeInTheDocument();
    expect(screen.getByText("Cloud backup is ready.")).toBeInTheDocument();
    expect(screen.getByText(/Latest snap: nightly backup/i)).toBeInTheDocument();
    expect(screen.getByText(/3 encrypted chunks stored/i)).toBeInTheDocument();
  });

  it("shows a helpful error when loading status fails", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(<ClawKeepApp />);

    expect(await screen.findByText("Failed to load ClawKeep for Documents (500): Internal Server Error")).toBeInTheDocument();
  });

  it("keeps the existing password when saving changed destinations", async () => {
    const existingBackupStatus = {
      ...baseStatus,
      initialized: true,
      backup: {
        ...baseStatus.backup,
        mode: "local" as const,
        passwordSet: true,
        local: {
          ...baseStatus.backup.local,
          enabled: true,
          path: "/home/clawbox/Backups/clawkeep",
          ready: true,
        },
        cloud: {
          ...baseStatus.backup.cloud,
          connected: true,
        },
      },
    };
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => existingBackupStatus,
          text: async () => JSON.stringify(existingBackupStatus),
        });
      }
      if (url === "/setup-api/clawkeep" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ message: "Saved settings" }),
          text: async () => JSON.stringify({ message: "Saved settings" }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ClawKeepApp />);

    await screen.findByRole("button", { name: "Back up now" });
    fireEvent.click(screen.getByRole("button", { name: "Both" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/clawkeep", expect.objectContaining({
        body: JSON.stringify({
          sourcePath: "Documents",
          action: "configure",
          localPath: "Backups/clawkeep",
          cloudEnabled: true,
          password: "",
        }),
      }));
    });
  });

  it("refreshes status and opens both folder pickers", async () => {
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Documents") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => baseStatus,
          text: async () => JSON.stringify(baseStatus),
        });
      }
      if (url.startsWith("/setup-api/clawkeep?sourcePath=Projects") && (!init || !init.method || init.method === "GET")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...baseStatus, sourcePath: "Projects", sourceAbsolutePath: "/home/clawbox/Projects" }),
          text: async () => JSON.stringify({ ...baseStatus, sourcePath: "Projects", sourceAbsolutePath: "/home/clawbox/Projects" }),
        });
      }
      if (url.startsWith("/setup-api/files?dir=")) {
        const dir = new URL(`http://localhost${url}`).searchParams.get("dir");
        const files = dir === "Projects" || dir === "Archive"
          ? []
          : [
              { name: "Projects", type: "directory" },
              { name: "Archive", type: "directory" },
            ];
        return Promise.resolve({
          ok: true,
          json: async () => ({ files }),
          text: async () => JSON.stringify({ files }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ClawKeepApp />);

    await screen.findByText("Back up one folder");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input]) => input.toString().startsWith("/setup-api/clawkeep?sourcePath=Documents"))).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Browse" })[0]);
    expect(await screen.findByRole("dialog", { name: "Choose the folder you want to protect" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Choose the folder you want to protect" })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Browse" })[1]);
    expect(await screen.findByRole("dialog", { name: "Choose where local backup copies should live" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Choose where local backup copies should live" })).not.toBeInTheDocument();
    });
  });
});
