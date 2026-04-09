import { expect, type Page, type Route } from "@playwright/test";

type SetupState = {
  setup_complete: boolean;
  wifi_configured: boolean;
  update_completed: boolean;
  password_configured: boolean;
  ai_model_configured: boolean;
  telegram_configured: boolean;
};

type WifiNetwork = {
  ssid: string;
  signal: number;
  security: string;
};

type FileEntry = {
  name: string;
  type: "file" | "directory";
  size: number | null;
  modified: string;
};

type FileTree = Record<string, FileEntry[]>;

type StoreCatalogApp = {
  name: string;
  slug: string;
  summary: string;
  category: string;
  rating: number;
  installs: string;
  developer?: string;
  version?: string;
  url?: string;
  tags?: string[];
};

type MockOptions = {
  initialSetup?: Partial<SetupState>;
  preferences?: Record<string, unknown>;
  wifiNetworks?: WifiNetwork[];
  files?: FileTree;
  storeApps?: StoreCatalogApp[];
  timeoutCapMs?: number;
};

const DEFAULT_SETUP: SetupState = {
  setup_complete: false,
  wifi_configured: false,
  update_completed: false,
  password_configured: false,
  ai_model_configured: false,
  telegram_configured: false,
};

const DEFAULT_PREFERENCES: Record<string, unknown> = {
  ui_language: "en",
  wp_id: "clawbox",
  wp_fit: "fill",
  wp_bg_color: "#000000",
  wp_opacity: 50,
  installed_apps: [],
  installed_meta: {},
  desktop_apps: ["settings", "files", "store"],
  hidden_installed: [],
  pinned_apps: {},
  icon_grid: {},
  desktop_open_windows: [],
  ui_mascot_hidden: 1,
  ui_chat_panel_width: 0,
  ui_chat_open: 0,
};

const DEFAULT_WIFI_NETWORKS: WifiNetwork[] = [
  { ssid: "Clawbox Lab", signal: -42, security: "WPA2" },
  { ssid: "Guest Network", signal: -58, security: "WPA2" },
];

const DEFAULT_FILES: FileTree = {
  "": [
    directoryEntry("Documents"),
    directoryEntry("Downloads"),
    fileEntry("notes.txt", 512),
  ],
  Documents: [fileEntry("welcome.md", 1024)],
  Downloads: [fileEntry("release-notes.pdf", 24_576)],
};

const DEFAULT_STORE_APPS: StoreCatalogApp[] = [
  {
    name: "Task Orbit",
    slug: "task-orbit",
    summary: "Track tasks, habits, and recurring routines from one workspace.",
    category: "productivity",
    rating: 4.8,
    installs: "12K",
    developer: "ClawBox Labs",
    version: "1.4.2",
    url: "https://openclawhardware.dev/store/apps/task-orbit",
    tags: ["tasks", "focus", "planning"],
  },
  {
    name: "Weather Deck",
    slug: "weather-deck",
    summary: "Forecast cards and travel alerts tuned for the desktop shell.",
    category: "weather-travel",
    rating: 4.6,
    installs: "8K",
    developer: "Climate Ops",
    version: "2.1.0",
    url: "https://openclawhardware.dev/store/apps/weather-deck",
    tags: ["weather", "travel"],
  },
];

function fileEntry(name: string, size: number): FileEntry {
  return {
    name,
    type: "file",
    size,
    modified: "2026-04-08T12:00:00.000Z",
  };
}

function directoryEntry(name: string): FileEntry {
  return {
    name,
    type: "directory",
    size: null,
    modified: "2026-04-08T12:00:00.000Z",
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeDir(dir: string | null): string {
  return (dir ?? "").replace(/^\/+|\/+$/g, "");
}

function splitPath(fullPath: string): { dir: string; name: string } {
  const normalized = normalizeDir(fullPath);
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.pop() ?? "";
  return { dir: parts.join("/"), name };
}

function upsertFileEntry(tree: FileTree, dir: string, entry: FileEntry) {
  const normalizedDir = normalizeDir(dir);
  const entries = tree[normalizedDir] ?? [];
  const nextEntries = entries.filter((item) => item.name !== entry.name);
  nextEntries.push(entry);
  tree[normalizedDir] = nextEntries;
}

function removeFileEntry(tree: FileTree, dir: string, name: string) {
  const normalizedDir = normalizeDir(dir);
  tree[normalizedDir] = (tree[normalizedDir] ?? []).filter((item) => item.name !== name);
}

function renameDirectory(tree: FileTree, fromPath: string, toPath: string) {
  const normalizedFrom = normalizeDir(fromPath);
  const normalizedTo = normalizeDir(toPath);
  const nextTree: FileTree = {};

  for (const [dir, entries] of Object.entries(tree)) {
    if (dir === normalizedFrom || dir.startsWith(`${normalizedFrom}/`)) {
      const suffix = dir.slice(normalizedFrom.length);
      nextTree[`${normalizedTo}${suffix}`.replace(/^\/+/, "")] = entries;
      continue;
    }

    nextTree[dir] = entries;
  }

  Object.keys(tree).forEach((key) => {
    delete tree[key];
  });
  Object.assign(tree, nextTree);
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function readRequestJson<T>(route: Route): Promise<T> {
  const rawBody = route.request().postData();
  return rawBody ? (JSON.parse(rawBody) as T) : ({} as T);
}

export async function installClawboxMocks(page: Page, options: MockOptions = {}) {
  const timeoutCapMs = options.timeoutCapMs ?? 50;

  await page.addInitScript((maxDelay) => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay: number = 0, ...args: unknown[]) => {
      const numericDelay = typeof delay === "number" ? delay : Number(delay) || 0;
      return nativeSetTimeout(handler, Math.min(numericDelay, maxDelay), ...args);
    }) as typeof window.setTimeout;
  }, timeoutCapMs);

  const setupState: SetupState = {
    ...DEFAULT_SETUP,
    ...options.initialSetup,
  };
  const preferences = {
    ...clone(DEFAULT_PREFERENCES),
    ...clone(options.preferences ?? {}),
  };
  const wifiNetworks = clone(options.wifiNetworks ?? DEFAULT_WIFI_NETWORKS);
  const storeApps = clone(options.storeApps ?? DEFAULT_STORE_APPS);
  const kvEntries: Record<string, string> = {};
  const files = clone(options.files ?? DEFAULT_FILES);
  let dismissalFingerprint: string | null = null;
  let hotspotConfig = {
    ssid: "ClawBox-Setup",
    enabled: true,
  };
  let updateBranch: string | null = null;
  const browserStatus = {
    chromium: {
      installed: false,
      path: undefined as string | undefined,
      version: undefined as string | undefined,
    },
    browser: {
      running: false,
      pid: undefined as number | undefined,
      cdpReady: false,
    },
    enabled: false,
    cdpPort: 18800,
  };

  const storeCategories = Array.from(
    storeApps.reduce((map, app) => {
      const nextCount = (map.get(app.category)?.count ?? 0) + 1;
      map.set(app.category, {
        id: app.category,
        name: app.category
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
        count: nextCount,
      });
      return map;
    }, new Map<string, { id: string; name: string; count: number }>())
      .values()
  );

  await page.route("**/setup-api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/setup-api/setup/status") {
      await fulfillJson(route, setupState);
      return;
    }

    if (path === "/setup-api/setup/complete" && method === "POST") {
      Object.assign(setupState, {
        setup_complete: true,
        wifi_configured: true,
        update_completed: true,
        password_configured: true,
        ai_model_configured: true,
        telegram_configured: true,
      });
      await fulfillJson(route, { success: true });
      return;
    }

    if (path === "/setup-api/preferences") {
      if (method === "GET") {
        if (url.searchParams.get("all") === "1") {
          await fulfillJson(route, preferences);
          return;
        }

        const keys = url.searchParams.get("keys");
        if (keys) {
          const subset: Record<string, unknown> = {};
          for (const key of keys.split(",").map((value) => value.trim()).filter(Boolean)) {
            subset[key] = preferences[key] ?? null;
          }
          await fulfillJson(route, subset);
          return;
        }

        await fulfillJson(route, preferences);
        return;
      }

      if (method === "POST") {
        const payload = await readRequestJson<Record<string, unknown>>(route);
        Object.assign(preferences, payload);
        await fulfillJson(route, { success: true });
        return;
      }
    }

    if (path === "/setup-api/kv") {
      if (method === "GET") {
        const key = url.searchParams.get("key");
        if (key) {
          await fulfillJson(route, { key, value: kvEntries[key] ?? null });
          return;
        }

        await fulfillJson(route, kvEntries);
        return;
      }

      if (method === "POST") {
        const payload = await readRequestJson<{
          entries?: Record<string, string>;
          key?: string;
          value?: string;
          delete?: string | boolean;
        }>(route);

        if (payload.entries) {
          Object.assign(kvEntries, payload.entries);
        }

        if (payload.key && payload.value !== undefined) {
          kvEntries[payload.key] = payload.value;
        }

        if (typeof payload.delete === "string") {
          delete kvEntries[payload.delete];
        } else if (payload.key && payload.delete) {
          delete kvEntries[payload.key];
        }

        await fulfillJson(route, { success: true });
        return;
      }
    }

    if (path === "/setup-api/wifi/ethernet") {
      await fulfillJson(route, { connected: false });
      return;
    }

    if (path === "/setup-api/wifi/scan") {
      await fulfillJson(route, { networks: wifiNetworks });
      return;
    }

    if (path === "/setup-api/wifi/connect" && method === "POST") {
      setupState.wifi_configured = true;
      await fulfillJson(route, { success: true });
      return;
    }

    if (path === "/setup-api/update/status") {
      setupState.update_completed = true;
      await fulfillJson(route, {
        phase: "idle",
        steps: [],
        currentStepIndex: -1,
        versions: {
          clawbox: { current: "2.2.2", target: null },
          openclaw: { current: "2026.4.8", target: null },
        },
      });
      return;
    }

    if (path === "/setup-api/update/run" && method === "POST") {
      setupState.update_completed = true;
      await fulfillJson(route, { success: true });
      return;
    }

    if (path === "/setup-api/update/openclaw" && method === "POST") {
      await fulfillJson(route, { started: true });
      return;
    }

    if (path === "/setup-api/update/versions") {
      await fulfillJson(route, {
        clawbox: { current: "2.2.2", target: null },
        openclaw: { current: "2026.4.8", target: null },
      });
      return;
    }

    if (path === "/setup-api/update/dismissal") {
      if (method === "GET") {
        await fulfillJson(route, { fingerprint: dismissalFingerprint });
        return;
      }

      if (method === "POST") {
        const payload = await readRequestJson<{ fingerprint?: string }>(route);
        dismissalFingerprint = payload.fingerprint ?? null;
        await fulfillJson(route, { success: true });
        return;
      }
    }

    if (path === "/setup-api/system/hotspot") {
      if (method === "GET") {
        await fulfillJson(route, hotspotConfig);
        return;
      }

      if (method === "POST") {
        const payload = await readRequestJson<{ ssid?: string; enabled?: boolean }>(route);
        hotspotConfig = {
          ssid: payload.ssid ?? hotspotConfig.ssid,
          enabled: payload.enabled ?? hotspotConfig.enabled,
        };
        await fulfillJson(route, { success: true });
        return;
      }
    }

    if (path === "/setup-api/system/stats") {
      await fulfillJson(route, {
        overview: {
          hostname: "clawbox",
          os: "Ubuntu 24.04",
          kernel: "6.8.0",
          uptime: "2 days",
          arch: "arm64",
          platform: "linux",
        },
        cpu: {
          usage: 28,
          model: "ARM Cortex",
          cores: 8,
          loadAvg: ["1.14", "0.88", "0.71"],
          speed: 1800,
        },
        memory: {
          total: 16 * 1024 * 1024 * 1024,
          used: 7 * 1024 * 1024 * 1024,
          free: 9 * 1024 * 1024 * 1024,
          usedPercent: 43.75,
          swap: {
            used: 512 * 1024 * 1024,
            total: 2 * 1024 * 1024 * 1024,
            percent: 25,
          },
        },
        temperature: { value: 54, display: "54 C" },
        gpu: { usage: 36 },
        storage: [
          {
            filesystem: "/dev/nvme0n1p1",
            size: "256G",
            used: "88G",
            avail: "168G",
            usePercent: 34,
            mountpoint: "/",
          },
        ],
        network: [
          { name: "wlan0", ip: "10.42.0.12", rx: 1000, tx: 2000 },
        ],
        processes: [
          { pid: "101", user: "clawbox", cpu: 4.2, mem: 3.1, command: "openclaw" },
        ],
        timestamp: Date.now(),
      });
      return;
    }

    if (path === "/setup-api/system/update-branch") {
      if (method === "GET") {
        await fulfillJson(route, { branch: updateBranch });
        return;
      }

      if (method === "POST") {
        const payload = await readRequestJson<{ branch?: string | null }>(route);
        updateBranch = payload.branch ?? null;
        await fulfillJson(route, { branch: updateBranch });
        return;
      }
    }

    if (path === "/setup-api/system/credentials" && method === "POST") {
      setupState.password_configured = true;
      await fulfillJson(route, { success: true });
      return;
    }

    if (path === "/setup-api/system/power" && method === "POST") {
      await fulfillJson(route, { success: true });
      return;
    }

    if (path === "/setup-api/vnc") {
      await fulfillJson(route, { host: "127.0.0.1", wsPort: 6080 });
      return;
    }

    if (path === "/setup-api/browser/manage") {
      if (method === "GET") {
        await fulfillJson(route, browserStatus);
        return;
      }

      if (method === "POST") {
        const payload = await readRequestJson<{ action?: string }>(route);
        switch (payload.action) {
          case "install-chromium":
            browserStatus.chromium.installed = true;
            browserStatus.chromium.path = "/usr/bin/chromium";
            browserStatus.chromium.version = "Chromium 124.0.0";
            break;
          case "enable":
            browserStatus.enabled = true;
            break;
          case "disable":
            browserStatus.enabled = false;
            browserStatus.browser.running = false;
            browserStatus.browser.pid = undefined;
            browserStatus.browser.cdpReady = false;
            break;
          case "open-browser":
            browserStatus.chromium.installed = true;
            browserStatus.chromium.path = "/usr/bin/chromium";
            browserStatus.chromium.version = "Chromium 124.0.0";
            browserStatus.enabled = true;
            browserStatus.browser.running = true;
            browserStatus.browser.pid = 4242;
            browserStatus.browser.cdpReady = true;
            break;
          case "close-browser":
            browserStatus.browser.running = false;
            browserStatus.browser.pid = undefined;
            browserStatus.browser.cdpReady = false;
            break;
          default:
            break;
        }

        await fulfillJson(route, browserStatus);
        return;
      }
    }

    if (path === "/setup-api/ai-models/oauth/providers") {
      await fulfillJson(route, { providers: [] });
      return;
    }

    if (path === "/setup-api/ai-models/status") {
      await fulfillJson(route, setupState.ai_model_configured
        ? {
            connected: true,
            providerLabel: "ClawBox AI",
            model: "clawai/deepseek-r1",
          }
        : {
            connected: false,
            providerLabel: null,
            model: null,
          });
      return;
    }

    if (path === "/setup-api/ai-models/configure" && method === "POST") {
      setupState.ai_model_configured = true;
      await fulfillJson(route, { success: true });
      return;
    }

    if (path === "/setup-api/telegram/status") {
      await fulfillJson(route, { configured: setupState.telegram_configured });
      return;
    }

    if (path === "/setup-api/telegram/configure" && method === "POST") {
      setupState.telegram_configured = true;
      await fulfillJson(route, { success: true });
      return;
    }

    if (path === "/setup-api/apps/store") {
      const requestedCategory = url.searchParams.get("category");
      const query = url.searchParams.get("q")?.toLowerCase() ?? "";
      const filteredApps = storeApps.filter((app) => {
        const matchesCategory = !requestedCategory || app.category === requestedCategory;
        const haystack = `${app.name} ${app.summary} ${app.developer ?? ""} ${(app.tags ?? []).join(" ")}`.toLowerCase();
        const matchesQuery = !query || haystack.includes(query);
        return matchesCategory && matchesQuery;
      });

      await fulfillJson(route, {
        total: filteredApps.length,
        categories: storeCategories,
        apps: filteredApps,
      });
      return;
    }

    if (path === "/setup-api/apps/skill-info") {
      const appId = url.searchParams.get("appId");
      if (appId === "home-assistant") {
        await fulfillJson(route, {
          name: "Home Assistant",
          description: "Connect to Home Assistant",
          emoji: null,
          eligible: true,
          primaryEnv: "HA_URL",
          requiredEnv: ["HA_URL", "HA_TOKEN"],
          requiredBins: [],
          requiredConfig: [],
        });
        return;
      }

      await fulfillJson(route, {
        name: appId ?? "Skill",
        description: "Mock skill",
        emoji: null,
        eligible: true,
        primaryEnv: null,
        requiredEnv: [],
        requiredBins: [],
        requiredConfig: [],
      });
      return;
    }

    if (path === "/setup-api/apps/install" && method === "POST") {
      await fulfillJson(route, {
        clawhub: { success: true },
      });
      return;
    }

    if (path === "/setup-api/apps/settings" && method === "POST") {
      await fulfillJson(route, { success: true });
      return;
    }

    if (path.startsWith("/setup-api/apps/icon/")) {
      await route.fulfill({ status: 404 });
      return;
    }

    if (path === "/setup-api/files") {
      const dir = normalizeDir(url.searchParams.get("dir"));

      if (method === "GET") {
        await fulfillJson(route, {
          files: clone(files[dir] ?? []),
          availableSpace: 1024 * 1024 * 1024,
        });
        return;
      }

      if (method === "PUT") {
        const name = url.searchParams.get("name");
        if (name) {
          upsertFileEntry(files, dir, fileEntry(name, request.postDataBuffer()?.byteLength ?? 0));
          await fulfillJson(route, { success: true });
          return;
        }
      }

      if (method === "POST") {
        const payload = await readRequestJson<{ action?: string; name?: string }>(route);
        if (payload.action === "mkdir" && payload.name) {
          upsertFileEntry(files, dir, directoryEntry(payload.name));
          files[normalizeDir(`${dir}/${payload.name}`)] = [];
          await fulfillJson(route, { success: true });
          return;
        }
      }
    }

    if (path.startsWith("/setup-api/files/")) {
      const encodedPath = path.replace("/setup-api/files/", "");
      const decodedPath = encodedPath.split("/").map(decodeURIComponent).join("/");
      const { dir, name } = splitPath(decodedPath);
      const entry = (files[dir] ?? []).find((item) => item.name === name);

      if (method === "GET") {
        await route.fulfill({
          status: entry ? 200 : 404,
          contentType: "application/octet-stream",
          body: entry ? "mock file contents" : "",
        });
        return;
      }

      if (method === "PUT") {
        const payload = await readRequestJson<{ newName?: string }>(route);
        if (entry && payload.newName) {
          const renamedEntry = {
            ...entry,
            name: payload.newName,
          };
          removeFileEntry(files, dir, name);
          upsertFileEntry(files, dir, renamedEntry);

          if (entry.type === "directory") {
            renameDirectory(files, decodedPath, dir ? `${dir}/${payload.newName}` : payload.newName);
          }

          await fulfillJson(route, { success: true });
          return;
        }
      }

      if (method === "DELETE") {
        if (entry) {
          removeFileEntry(files, dir, name);
          if (entry.type === "directory") {
            delete files[normalizeDir(decodedPath)];
          }
        }
        await fulfillJson(route, { success: true });
        return;
      }
    }

    if (path === "/setup-api/gateway/ws-config") {
      await fulfillJson(route, {
        token: "test-gateway-token",
        wsUrl: "ws://localhost:12345/mock-gateway",
        model: "clawai/deepseek-r1",
      });
      return;
    }

    await fulfillJson(route, {});
  });
}

export async function completeSetupWizard(page: Page) {
  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
  await page.getByRole("button", { name: "Connect to WiFi" }).click();
  await page.getByRole("button", { name: "Clawbox Lab" }).click();
  await page.locator("#wifi-password").fill("wireless-pass");
  await page.getByRole("button", { name: "Connect" }).click();

  const updateStep = page.getByTestId("setup-step-update");
  await expect(updateStep).toBeVisible({ timeout: 10_000 });
  const continueButton = updateStep.getByRole("button", { name: "Continue" });
  if (await continueButton.isVisible().catch(() => false)) {
    await continueButton.click();
  }
  await expect(page.getByTestId("setup-step-credentials")).toBeVisible({ timeout: 10_000 });

  await page.locator("#cred-password").fill("clawbox-pass");
  await page.locator("#cred-confirm").fill("clawbox-pass");
  await page.locator("#hotspot-password").fill("hotspot-pass");
  await page.locator("#hotspot-confirm").fill("hotspot-pass");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();
  await page.getByRole("button", { name: "Start for free" }).click();

  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
}

export async function openLauncher(page: Page) {
  await page.locator('[data-testid="shelf-launcher-button"]:visible').click();
  await expect(page.getByTestId("app-launcher")).toBeVisible();
}
