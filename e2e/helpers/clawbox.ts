import { expect, type Locator, type Page, type Route } from "@playwright/test";

type SetupState = {
  setup_complete: boolean;
  wifi_configured: boolean;
  update_completed: boolean;
  password_configured: boolean;
  local_ai_configured: boolean;
  local_ai_provider?: string | null;
  local_ai_model?: string | null;
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
  local_ai_configured: false,
  local_ai_provider: null,
  local_ai_model: null,
  ai_model_configured: false,
  telegram_configured: false,
};

// The ids and labels /setup-api/providers/status gives the on-device engine
// (LOCAL_PROVIDER_LABELS in src/lib/provider-status.ts). A provider outside
// this map gets no row there, and so gets none here.
const LOCAL_PROVIDER_LABELS: Record<string, string> = {
  llamacpp: "Gemma 4 (on-device)",
  ollama: "Ollama Local",
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
    url: "https://clawbox.com/store/apps/task-orbit",
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
    url: "https://clawbox.com/store/apps/weather-deck",
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

/**
 * What the Voice tab's Play button gets back: a real, decodable WAV (8 kHz,
 * 16-bit mono, 50 ms of silence), so the panel hands its player a clip a
 * browser can play rather than a body it has to reject — which lets a spec
 * assert that the clip DOES decode. Headless Chromium plays blob: audio like
 * any other browser; what refuses it is a Content-Security-Policy with no
 * `media-src`, where media falls back to `default-src 'self'` and a blob: src
 * fails with "Media load rejected by URL safety check". That is a fault of the
 * page's headers (next.config.ts), not of the browser or the box, and it fires
 * for real users exactly as it does here.
 */
const SILENT_WAV = buildSilentWav();

function buildSilentWav(): Buffer {
  const sampleRate = 8000;
  const samples = 400;
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
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
  const clawKeepState = {
    initialized: false,
    passwordSet: false,
    mode: null as "local" | "cloud" | "both" | null,
    localEnabled: false,
    localPath: null as string | null,
    chunkCount: 0,
    lastSync: null as string | null,
    lastSyncCommit: null as string | null,
    recent: [] as Array<{ hash: string; date: string; message: string }>,
  };
  let updateBranch: string | null = null;
  let gatewayHealthChecksRemaining = 0;
  let chatActiveSource: "primary" | "local" | null = setupState.ai_model_configured
    ? "primary"
    : setupState.local_ai_configured
      ? "local"
      : null;
  // ── The box's on-device AI, as ONE set of facts ──────────────────────────
  //
  // Settings -> Local AI (the inventory and each row's role), Settings -> Voice
  // (which engine speaks first, with which voice) and the chat's transcription
  // all describe the same hardware, so every route below is DERIVED from these
  // variables rather than written on its own. A Local AI tab that called Kokoro
  // absent beside a Voice tab that had it speaking is exactly the drift the
  // specs exist to catch, and a mock that contradicts itself cannot catch it.
  //
  // The box: Gemma 4 (llama.cpp) installed iff setup says local AI is
  // configured; Ollama installed, serving one extra model; Kokoro installed
  // and running; Whisper NOT installed. Everything cloud-side — the cloud
  // voice, cloud transcription — exists iff setup says ClawBox AI is linked
  // (`ai_model_configured`), because on the real box both are that one
  // credential: a linked box speaks from the cloud first until the owner picks
  // the box, an unlinked one has only Kokoro and reads the cloud as
  // unavailable. Whisper is the "absent engine" every negative assertion leans
  // on: it must read as absent and offer no control.
  let localOnly = false;
  let voiceChoice: "auto" | "local" | "cloud" = "auto";
  let voiceLanguage = "en";
  const voiceVoices: Record<"local" | "cloud", string> = { local: "af_heart", cloud: "alloy" };
  const codingAgent = {
    enabled: false,
    defaultDirectory: "/home/clawbox/projects" as string | null,
    effort: "max",
    subagents: false,
    maxTurns: 200,
    tokenLimit: null as number | null,
  };

  const browserStatus = {
    chromium: {
      installed: false,
      path: undefined as string | undefined,
      version: undefined as string | undefined,
      // Whether clawbox-browser.service could start this binary; the app keys
      // its launch on this rather than on `installed`.
      serviceSafe: undefined as boolean | undefined,
    },
    browser: {
      running: false,
      pid: undefined as number | undefined,
      cdpReady: false,
    },
    enabled: false,
    cdpPort: 18800,
    // A fresh box has not been through the browser wizard.
    setupComplete: false,
    autoOpen: true,
    startUrl: "https://www.google.com",
  };

  const buildClawKeepStatus = (sourcePath: string) => {
    const normalizedSource = normalizeDir(sourcePath);
    const parentDir = splitPath(normalizedSource).dir;
    const sourceName = normalizedSource.split("/").filter(Boolean).pop() ?? normalizedSource;
    const sourceExists = normalizedSource === ""
      ? true
      : (files[parentDir] ?? []).some((entry) => entry.type === "directory" && entry.name === sourceName);
    const cloudEnabled = clawKeepState.mode === "cloud" || clawKeepState.mode === "both";
    return {
      initialized: clawKeepState.initialized,
      sourcePath: normalizedSource,
      sourceAbsolutePath: `/home/clawbox/${normalizedSource}`.replace(/\/+$/, ""),
      sourceExists,
      backup: {
        mode: clawKeepState.mode,
        passwordSet: clawKeepState.passwordSet,
        workspaceId: "workspace-demo",
        chunkCount: clawKeepState.chunkCount,
        lastSync: clawKeepState.lastSync,
        lastSyncCommit: clawKeepState.lastSyncCommit,
        local: {
          enabled: clawKeepState.localEnabled,
          path: clawKeepState.localPath ? `/home/clawbox/${clawKeepState.localPath}` : null,
          lastSync: clawKeepState.localEnabled ? clawKeepState.lastSync : null,
          ready: clawKeepState.localEnabled,
        },
        cloud: {
          enabled: cloudEnabled,
          connected: setupState.ai_model_configured,
          available: true,
          providerLabel: "ClawBox AI",
          endpoint: "https://clawbox.com/api/clawkeep/device-backups",
          lastSync: cloudEnabled ? clawKeepState.lastSync : null,
        },
      },
      headCommit: clawKeepState.initialized ? "abc123" : null,
      trackedFiles: sourceExists ? 1 : 0,
      totalSnaps: clawKeepState.recent.length,
      dirtyFiles: 0,
      clean: true,
      recent: clawKeepState.recent,
    };
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

  const getPrimaryChatModel = () => (setupState.ai_model_configured ? "clawai/deepseek-r1" : null);
  const getLocalChatModel = () => (setupState.local_ai_configured ? setupState.local_ai_model ?? null : null);
  const getLocalChatLabel = () => {
    if (setupState.local_ai_provider === "ollama") return "Ollama Local";
    if (setupState.local_ai_provider === "llamacpp") return "Gemma 4 Local";
    return "Local AI";
  };
  const buildChatModelState = () => {
    const primaryModel = getPrimaryChatModel();
    const localModel = getLocalChatModel();
    let activeSource = chatActiveSource;

    if (activeSource === "primary" && !primaryModel) {
      activeSource = localModel ? "local" : null;
    } else if (activeSource === "local" && !localModel) {
      activeSource = primaryModel ? "primary" : null;
    } else if (!activeSource) {
      activeSource = primaryModel ? "primary" : localModel ? "local" : null;
    }

    chatActiveSource = activeSource;

    const options = [
      ...(primaryModel
        ? [{
            id: primaryModel,
            label: "ClawBox AI",
            model: primaryModel,
            provider: "clawai",
            available: true,
            settingsSection: "ai",
            isLocal: false,
          }]
        : [{
            id: "__setup_ai__",
            label: "AI Provider",
            model: null,
            provider: null,
            available: false,
            settingsSection: "ai",
            isLocal: false,
          }]),
      ...(localModel
        ? [{
            id: localModel,
            label: getLocalChatLabel(),
            model: localModel,
            provider: setupState.local_ai_provider,
            available: true,
            settingsSection: "localAi",
            isLocal: true,
          }]
        : [{
            id: "__setup_local__",
            label: "Local AI",
            model: null,
            provider: null,
            available: false,
            settingsSection: "localAi",
            isLocal: true,
          }]),
    ];

    const activeModel =
      activeSource === "primary"
        ? primaryModel
        : activeSource === "local"
          ? localModel
          : null;

    return {
      activeOptionId: options.find((option) => option.model === activeModel)?.id ?? null,
      activeSource,
      activeLabel:
        activeSource === "primary"
          ? (primaryModel ? "ClawBox AI" : null)
          : activeSource === "local"
            ? (localModel ? getLocalChatLabel() : null)
            : null,
      activeModel,
      options,
      primary: {
        available: !!primaryModel,
        label: primaryModel ? "ClawBox AI" : null,
        model: primaryModel,
      },
      local: {
        available: !!localModel,
        label: localModel ? getLocalChatLabel() : null,
        model: localModel,
      },
    };
  };

  const buildLocalModels = () => {
    const gemmaInstalled = setupState.local_ai_configured && setupState.local_ai_provider === "llamacpp";
    return {
      models: [
        // Each line rides with its code, as the real route sends it: the panel
        // renders the code through the catalogue and the English is its fallback.
        {
          id: "llamacpp", name: "Gemma 4", kind: "llm", runtime: "Answers on this box", runtimeCode: "answersOnBox",
          installed: gemmaInstalled, enabled: null,
          running: gemmaInstalled ? "running" : "not-installed",
          diskBytes: null, memoryBytes: gemmaInstalled ? 2_147_483_648 : null,
          control: "none", managedBy: "localAi",
          detail: gemmaInstalled ? "Answering right now." : "Not installed.",
          detailCode: gemmaInstalled ? "llamacppAnswering" : "llamacppNotInstalled",
        },
        {
          id: "kokoro", name: "Kokoro", kind: "tts", runtime: "Voice on this box", runtimeCode: "voiceOnBox",
          installed: true, enabled: true, running: "running",
          diskBytes: null, memoryBytes: 412_000_000, control: "user-unit",
          detail: "Speaking from this box.", detailCode: "kokoroSpeaking",
        },
        {
          id: "whisper", name: "Whisper", kind: "stt", runtime: "Transcribes on this box", runtimeCode: "transcribesOnBox",
          installed: false, enabled: null, running: "not-installed",
          diskBytes: null, memoryBytes: null, control: "none",
          detail: "Not installed. Speech is transcribed in the cloud.", detailCode: "whisperNotInstalled",
        },
        // The memory embedder's own row: Qwen 3 on this box's llama.cpp, woken
        // by the local-AI proxy and asleep in between. No switch — Memory
        // Shard owns it — only the pointer there.
        {
          id: "embeddings", name: "Memory search", nameCode: "memorySearch", kind: "embedding",
          runtime: "Qwen 3 via llama.cpp", runtimeCode: "modelVia", params: { model: "Qwen 3", via: "llama.cpp" },
          installed: true, enabled: null, running: "on-demand",
          diskBytes: 639_000_000, memoryBytes: null, control: "none", managedBy: "clawkeep",
          detail: "Ready. Wakes when you search, then sleeps to save memory.", detailCode: "embeddingsReady",
        },
      ],
      unavailable: [],
    };
  };

  // Mirrors selectionError in src/lib/voice-output.ts, so the mock refuses
  // exactly the selections the real route refuses, with the same words.
  const voiceSelectionError = (
    choice: "auto" | "local" | "cloud",
    engines: { id: string; configured: boolean }[],
  ): string | null => {
    if (choice === "auto") {
      return engines.some((e) => e.configured) ? null : "This box has no voice it can use.";
    }
    const engine = engines.find((e) => e.id === choice);
    if (!engine || !engine.configured) return "That voice is not available on this box.";
    return null;
  };

  // The shape /setup-api/tts answers with (src/lib/voice-output.ts). `auto` is
  // cloud-first — the standing product default — and `local` puts the box
  // first; the Voice tab reads the order off `choice`, the Local AI tab reads
  // Kokoro's role off the same field.
  //
  // The cloud engine follows the same setup fact every other surface reads: on
  // the real box its credential is ClawBox AI's token, so a box that is not
  // linked has no cloud voice (`configured: false`, the option greyed out, no
  // privacy notice), and `auto` resolves to the box's own voice — exactly what
  // resolvePreferredEngine and buildVoiceDisclosure produce for that box.
  const buildVoiceStatus = () => {
    const cloudVoice = setupState.ai_model_configured;
    const engine = voiceChoice === "local" || !cloudVoice ? "local" : "cloud";
    const providerId = engine === "local" ? "tts-local-cli" : "openai";
    return {
      choice: voiceChoice,
      activeProviderId: providerId,
      activeEngine: engine,
      preferredEngine: engine,
      drifted: false,
      engines: [
        {
          id: "cloud", providerId: "openai", label: "ClawBox cloud",
          configured: cloudVoice,
          detail: cloudVoice
            ? "Speaks in the cloud. The words to be spoken leave this box."
            : "No cloud voice is set up on this box.",
        },
        {
          id: "local", providerId: "tts-local-cli", label: "On this box",
          configured: true,
          detail: "Speaks on the box itself. Nothing leaves it. Installed: Kokoro.",
        },
      ],
      warning: !cloudVoice
        ? null
        : engine === "cloud"
          ? "Privacy notice: Voice uses ClawBox AI cloud TTS. Text sent for speech leaves this ClawBox."
          : "Privacy notice: If On this box is unavailable, voice may use ClawBox AI cloud TTS. Text sent for speech may leave this ClawBox.",
      language: voiceLanguage,
      voice: { ...voiceVoices },
      // The gateway's half of speech, in the shape the real route answers it:
      // this fixture is an OpenClaw box, and it has the ffmpeg a channel voice
      // note is encoded with — so the Voice tab draws no amber repair line.
      channels: { supportedOnEdition: true, voiceNoteReady: true },
    };
  };

  // The harness runs on the box's ClawBox AI plan, so its readiness is the
  // same linkage fact as the cloud voice: an unlinked box is not ready, and
  // says so with the real route's sentence.
  const buildCodingAgentStatus = () => {
    const clawaiConnected = setupState.ai_model_configured;
    const problems = clawaiConnected
      ? []
      : ["ClawBox AI is not connected. Open Settings → AI Models and sign in to ClawBox AI first."];
    return {
      enabled: codingAgent.enabled,
      ready: clawaiConnected,
      readiness: {
        ready: clawaiConnected, wrapperInstalled: true, claudeInstalled: true,
        clawaiConnected, capabilityDropAvailable: true, problems,
    },
      running: 0,
      defaultDirectory: codingAgent.defaultDirectory,
      effort: codingAgent.effort,
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      subagents: codingAgent.subagents,
      maxTurns: codingAgent.maxTurns,
      minMaxTurns: 10,
      maxMaxTurns: 1000,
      tokenLimit: codingAgent.tokenLimit,
      minTokenLimit: 100_000,
    };
  };

  await page.route("**/setup-api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/setup-api/setup/status") {
      await fulfillJson(route, setupState);
      return;
    }

    // The mocked device is an OpenClaw box. This route has to answer for real:
    // this handler owns every /setup-api path and ends in a catch-all `{}`,
    // which carries neither `active` nor `edition`, so fetchHarness resolves
    // null. The desktop treats an unknown harness as "hide both harnesses'
    // apps" (fail closed, page.tsx harnessHiddenAppIds), which silently took
    // the App Store and the OpenClaw Control UI off the shelf — the two apps
    // store-flow and installed-app-settings drive.
    if (path === "/setup-api/harness/active") {
      await fulfillJson(route, { active: "openclaw", edition: "openclaw", activeKnown: true });
      return;
    }

    if (path === "/setup-api/setup/complete" && method === "POST") {
      Object.assign(setupState, {
        setup_complete: true,
        wifi_configured: true,
        update_completed: true,
        password_configured: true,
        local_ai_configured: true,
        local_ai_provider: "llamacpp",
        local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
        ai_model_configured: true,
        telegram_configured: true,
      });
      chatActiveSource = "primary";
      gatewayHealthChecksRemaining = Math.max(gatewayHealthChecksRemaining, 2);
      await fulfillJson(route, { success: true });
      return;
    }

    if (path === "/setup-api/gateway/health") {
      const available = gatewayHealthChecksRemaining <= 0;
      if (gatewayHealthChecksRemaining > 0) {
        gatewayHealthChecksRemaining -= 1;
      }
      await fulfillJson(route, { available, port: 18789 });
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
      // Ethernet present: the setup specs drive the Ethernet-first happy path
      // ("Continue with Ethernet"), which advances in-page. The WiFi-handoff
      // path is covered by setup-wifi-handoff.spec.ts, which overrides this
      // route (no cable) and mocks the box's home-network origin.
      await fulfillJson(route, { connected: true, cable: true });
      return;
    }

    if (path === "/setup-api/wifi/scan") {
      await fulfillJson(route, { networks: wifiNetworks });
      return;
    }

    if (path === "/setup-api/wifi/connect" && method === "POST") {
      setupState.wifi_configured = true;
      // Single-radio handoff: the route is fire-and-forget and returns
      // "connecting", then the wizard polls /wifi/connect-status for the
      // real outcome (see WifiStep). The mock has no radio to lose, so the
      // status endpoint below reports success right away.
      await fulfillJson(route, { status: "connecting" });
      return;
    }

    if (path === "/setup-api/wifi/connect-status") {
      await fulfillJson(route, { phase: "connected", ssid: "Clawbox Lab", reason: null });
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
      // `available` is what VNCApp keys on; without it every screen it draws —
      // including the one embedded in the Browser app — is the repair screen.
      await fulfillJson(route, { host: "127.0.0.1", available: true, vncPort: 5900, wsPort: 6080 });
      return;
    }

    if (path === "/setup-api/browser/setup" && method === "POST") {
      const payload = await readRequestJson<{ setupComplete?: boolean; autoOpen?: boolean; startUrl?: string | null }>(route);
      if (typeof payload.setupComplete === "boolean") browserStatus.setupComplete = payload.setupComplete;
      if (typeof payload.autoOpen === "boolean") browserStatus.autoOpen = payload.autoOpen;
      if (typeof payload.startUrl === "string" && payload.startUrl !== "") browserStatus.startUrl = payload.startUrl;
      await fulfillJson(route, {
        setupComplete: browserStatus.setupComplete,
        autoOpen: browserStatus.autoOpen,
        startUrl: browserStatus.startUrl,
      });
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
            browserStatus.chromium.serviceSafe = true;
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
            browserStatus.chromium.serviceSafe = true;
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

    if (path === "/setup-api/llamacpp/status") {
      await fulfillJson(route, {
        running: setupState.local_ai_provider === "llamacpp",
        models: setupState.local_ai_provider === "llamacpp" && setupState.local_ai_model
          ? [{ id: setupState.local_ai_model.split("/").pop(), owned_by: "llama.cpp" }]
          : [],
        baseUrl: "http://127.0.0.1:8080/v1",
      });
      return;
    }

    if (path === "/setup-api/llamacpp/install" && method === "POST") {
      const payload = await readRequestJson<{ model?: string; scope?: "primary" | "local" }>(route);
      const model = payload.model || "gemma4-e2b-it-q4_0";
      setupState.local_ai_configured = true;
      setupState.local_ai_provider = "llamacpp";
      setupState.local_ai_model = `llamacpp/${model}`;

      if (payload.scope !== "local") {
        setupState.ai_model_configured = true;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({ status: `Preparing llama.cpp for ${model}...` })}\n${JSON.stringify({ status: "llama.cpp is ready. Applying ClawBox configuration..." })}\n${JSON.stringify({ success: true, model, status: `${model} is installed, running, and configured.` })}\n`,
      });
      return;
    }

    if (path === "/setup-api/ollama/status") {
      await fulfillJson(route, {
        running: true,
        models: setupState.local_ai_provider === "ollama" && setupState.local_ai_model
          ? [{ name: setupState.local_ai_model.split("/").pop(), size: 3_400_000_000 }]
          : [],
      });
      return;
    }

    if (path === "/setup-api/ai-models/status") {
      // ClawKeep / Remote Desktop / chat-popup gates check tier-related
      // fields for paid-plan entitlement. The shared mock claims Pro
      // tier (flash) for both the active chat provider (`clawaiTier`)
      // AND the account-level tier (`clawaiAccountTier`) so existing
      // e2e tests that drive the paired ClawKeep flow or the chat
      // dropdown don't trip the Free-user upgrade card. Tests that
      // need the Free or no-clawai-account paths can override this
      // route inline.
      await fulfillJson(route, setupState.ai_model_configured
        ? {
            connected: true,
            provider: "clawai",
            providerLabel: "ClawBox AI",
            model: "clawai/deepseek-r1",
            clawaiTier: "flash",
            clawaiAccountTier: "flash",
            clawaiConfigured: true,
          }
        : {
            connected: false,
            provider: null,
            providerLabel: null,
            model: null,
            clawaiTier: null,
            clawaiAccountTier: null,
            clawaiConfigured: false,
          });
      return;
    }

    if (path === "/setup-api/chat/model") {
      if (method === "GET") {
        await fulfillJson(route, buildChatModelState());
        return;
      }

      if (method === "POST") {
        const payload = await readRequestJson<{ source?: "primary" | "local"; model?: string }>(route);
        const state = buildChatModelState();
        const target = typeof payload.model === "string" && payload.model
          ? state.options.find((option) => option.model === payload.model) ?? null
          : payload.source === "primary"
            ? {
                available: state.primary.available,
                model: state.primary.model,
                settingsSection: "ai" as const,
              }
            : payload.source === "local"
              ? {
                  available: state.local.available,
                  model: state.local.model,
                  settingsSection: "localAi" as const,
                }
              : null;
        if (!target) {
          await fulfillJson(route, { error: "Invalid chat model source" }, 400);
          return;
        }
        if (!target.available || !target.model) {
          await fulfillJson(route, { error: target.settingsSection === "localAi" ? "Local AI is not configured" : "AI provider is not configured" }, 400);
          return;
        }

        chatActiveSource = target.settingsSection === "localAi" ? "local" : "primary";
        await fulfillJson(route, buildChatModelState());
        return;
      }
    }

    if (path === "/setup-api/ai-models/configure" && method === "POST") {
      const payload = await readRequestJson<{ provider?: string; apiKey?: string; scope?: "primary" | "local" }>(route);
      if (payload.scope === "local") {
        setupState.local_ai_configured = true;
        setupState.local_ai_provider = payload.provider ?? "llamacpp";
        setupState.local_ai_model = payload.provider === "ollama"
          ? `ollama/${payload.apiKey || "llama3.2:3b"}`
          : `llamacpp/${payload.apiKey || "gemma4-e2b-it-q4_0"}`;
      } else {
        setupState.ai_model_configured = true;
        if (!chatActiveSource) chatActiveSource = "primary";
      }
      await fulfillJson(route, { success: true });
      return;
    }

    if (path === "/setup-api/clawkeep") {
      if (method === "GET") {
        const sourcePath = normalizeDir(url.searchParams.get("sourcePath"));
        if (!sourcePath) {
          await fulfillJson(route, { error: "sourcePath is required" }, 400);
          return;
        }
        await fulfillJson(route, buildClawKeepStatus(sourcePath));
        return;
      }

      if (method === "POST") {
        const payload = await readRequestJson<{
          action?: string;
          sourcePath?: string;
          localPath?: string;
          cloudEnabled?: boolean;
          password?: string;
          message?: string;
        }>(route);
        const sourcePath = normalizeDir(payload.sourcePath ?? "");
        if (!sourcePath) {
          await fulfillJson(route, { error: "sourcePath is required" }, 400);
          return;
        }

        switch (payload.action) {
          case "init":
            clawKeepState.initialized = true;
            await fulfillJson(route, buildClawKeepStatus(sourcePath));
            return;
          case "configure": {
            const localPath = normalizeDir(payload.localPath ?? "");
            const cloudEnabled = !!payload.cloudEnabled;
            clawKeepState.passwordSet = typeof payload.password === "string" && payload.password.length >= 8;
            clawKeepState.localEnabled = !!localPath;
            clawKeepState.localPath = localPath || null;
            clawKeepState.mode = localPath && cloudEnabled ? "both" : localPath ? "local" : cloudEnabled ? "cloud" : null;
            await fulfillJson(route, { status: buildClawKeepStatus(sourcePath), message: "Saved settings" });
            return;
          }
          case "snap": {
            const now = new Date().toISOString();
            clawKeepState.recent = [
              {
                hash: `snap-${Date.now()}`,
                date: now,
                message: payload.message || "backup",
              },
              ...clawKeepState.recent,
            ].slice(0, 8);
            await fulfillJson(route, { message: "Snapshot saved" });
            return;
          }
          case "sync": {
            const now = new Date().toISOString();
            clawKeepState.lastSync = now;
            clawKeepState.lastSyncCommit = "abc123";
            clawKeepState.chunkCount = Math.max(clawKeepState.chunkCount, 1);
            await fulfillJson(route, { status: buildClawKeepStatus(sourcePath), message: "Backup complete" });
            return;
          }
          default:
            await fulfillJson(route, { error: "Unknown action" }, 400);
            return;
        }
      }
    }

    if (path === "/setup-api/telegram/status") {
      await fulfillJson(route, { configured: setupState.telegram_configured });
      return;
    }

    if (path === "/setup-api/telegram/configure" && method === "POST") {
      setupState.telegram_configured = true;
      gatewayHealthChecksRemaining = Math.max(gatewayHealthChecksRemaining, 2);
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
      const state = buildChatModelState();
      await fulfillJson(route, {
        token: "test-gateway-token",
        wsUrl: "ws://localhost:12345/mock-gateway",
        model: state.activeSource === "local" ? state.local.model : state.primary.model,
      });
      return;
    }

    // Settings -> Providers. The connection overview every provider surface
    // reads: which providers hold a sign-in, and which one answers first. The
    // rows follow the same setup facts ai-models/status answers from, and the
    // local row is the engine `local_ai_provider` names — the setup mocks can
    // put Ollama there, and a strip that called it Gemma 4 regardless would
    // let a spec pass against a box the real route never describes.
    if (path === "/setup-api/providers/status") {
      const localProvider = setupState.local_ai_configured ? setupState.local_ai_provider ?? null : null;
      const localLabel = localProvider ? LOCAL_PROVIDER_LABELS[localProvider] : undefined;
      const providers = [
        ...(setupState.ai_model_configured
          ? [{ id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, enabled: true, section: "ai" }]
          : []),
        ...(localProvider && localLabel
          ? [{
              id: localProvider, label: localLabel, state: "connected",
              isDefault: !setupState.ai_model_configured, enabled: true, section: "localAi",
            }]
          : []),
      ];
      await fulfillJson(route, {
        harness: "openclaw",
        providers,
        defaultProvider: providers.find((row) => row.isDefault)?.id ?? null,
        degraded: false,
      });
      return;
    }

    // Settings -> Local AI: the inventory. Both "installed" and "not installed"
    // rows, because the tab's whole point is telling the two apart — a mock
    // with only working engines proves nothing about the absent one.
    if (path === "/setup-api/local-models") {
      if (method === "POST") {
        const payload = await readRequestJson<{ id?: string; enabled?: boolean }>(route);
        if (typeof payload.id !== "string" || typeof payload.enabled !== "boolean") {
          await fulfillJson(route, { error: "Expected an engine id and an enabled flag." }, 400);
          return;
        }
        // The real route's two refusals: an id the inventory has never heard
        // of (404), and a real engine with no switch here (400). No switch is
        // mocked: the voice engines' toggles are exercised by their own specs
        // and the memory embedder has none (the proxy wakes it).
        if (!["llamacpp", "kokoro", "whisper", "embeddings"].includes(payload.id)) {
          await fulfillJson(route, { error: "Unknown model." }, 404);
          return;
        }
        await fulfillJson(route, { error: "That model cannot be turned on or off here." }, 400);
        return;
      }
      await fulfillJson(route, buildLocalModels());
      return;
    }

    if (path === "/setup-api/local-ai/exclusive") {
      if (method === "POST") {
        const payload = await readRequestJson<{ enabled?: boolean }>(route);
        localOnly = payload.enabled === true;
      }
      await fulfillJson(route, { enabled: localOnly });
      return;
    }

    // Settings -> Voice, and Kokoro's role on the Local AI tab.
    if (path === "/setup-api/tts") {
      if (method === "POST") {
        const payload = await readRequestJson<{
          action?: string;
          choice?: string;
          language?: string;
          engine?: string;
          voice?: string;
        }>(route);
        if (payload.action === "select" && (payload.choice === "auto" || payload.choice === "local" || payload.choice === "cloud")) {
          // The real route refuses to write a primary the box cannot honour
          // (selectionError in src/lib/voice-output.ts): on an unlinked box
          // the cloud voice is not configured, and picking it must answer 409,
          // not a 200 that the Voice tab would read as a working choice.
          const refusal = voiceSelectionError(payload.choice, buildVoiceStatus().engines);
          if (refusal) {
            await fulfillJson(route, { error: refusal }, 409);
            return;
          }
          voiceChoice = payload.choice;
        } else if (payload.action === "language" && typeof payload.language === "string") {
          voiceLanguage = payload.language;
        } else if (payload.action === "voice" && (payload.engine === "local" || payload.engine === "cloud") && typeof payload.voice === "string") {
          voiceVoices[payload.engine] = payload.voice;
        } else {
          await fulfillJson(route, { error: "Unknown voice action" }, 400);
          return;
        }
      }
      await fulfillJson(route, buildVoiceStatus());
      return;
    }

    if (path === "/setup-api/tts/sample" && method === "POST") {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: SILENT_WAV });
      return;
    }

    // Speech in. Whisper is not on this box, so the cloud is the only engine
    // that can be in the chain — and, as on the real route (where `configured`
    // is "the box holds a ClawBox AI token"), only when the box is linked. An
    // unlinked box with no Whisper transcribes nowhere, and the chain says so.
    if (path === "/setup-api/stt") {
      const cloudConfigured = setupState.ai_model_configured;
      await fulfillJson(route, {
        primary: "cloud",
        engines: {
          cloud: { configured: cloudConfigured, label: "ClawBox cloud" },
          local: { installed: false, label: "On this box", detail: "The on-box transcriber is not installed." },
        },
        chain: cloudConfigured ? ["cloud"] : [],
        channels: { supportedOnEdition: true },
      });
      return;
    }

    // Coding Agent app -> Settings. The switch is not optimistic — the panel
    // renders whatever the route answers — so `enable` has to answer the
    // whole re-read status, exactly as the real route does.
    if (path === "/setup-api/coding-agent/status") {
      await fulfillJson(route, buildCodingAgentStatus());
      return;
    }

    if (path === "/setup-api/coding-agent/enable" && method === "POST") {
      const payload = await readRequestJson<Partial<typeof codingAgent>>(route);
      if (typeof payload.enabled === "boolean") codingAgent.enabled = payload.enabled;
      if (payload.defaultDirectory !== undefined) codingAgent.defaultDirectory = payload.defaultDirectory;
      if (typeof payload.effort === "string") codingAgent.effort = payload.effort;
      if (typeof payload.subagents === "boolean") codingAgent.subagents = payload.subagents;
      if (typeof payload.maxTurns === "number") codingAgent.maxTurns = payload.maxTurns;
      if (payload.tokenLimit !== undefined) codingAgent.tokenLimit = payload.tokenLimit;
      await fulfillJson(route, buildCodingAgentStatus());
      return;
    }

    // The Coding Agent app's home: no runs, no projects on this box.
    if (path === "/setup-api/coding-agent/runs") {
      await fulfillJson(route, { runs: [] });
      return;
    }
    if (path === "/setup-api/coding-agent/projects") {
      await fulfillJson(route, { projects: [] });
      return;
    }

    if (path === "/setup-api/coding-agent/git") {
      await fulfillJson(route, { installed: true, connected: false, login: null, loginCommand: "gh auth login" });
      return;
    }

    await fulfillJson(route, {});
  });
}

/**
 * The wizard step right after WiFi: the update step auto-advances to
 * credentials the moment it sees there's nothing to install, and with test
 * timers capped (installClawboxMocks) that can happen before Playwright
 * catches the update step on screen — so race the two steps rather than
 * assuming the update step lingers long enough to assert.
 */
export function wizardStepAfterWifi(page: Page) {
  return page
    .getByTestId("setup-step-update")
    .or(page.getByTestId("setup-step-credentials"))
    .first();
}

/**
 * Fill the credentials step the way a customer does.
 *
 * The hotspot password and its confirmation sit behind a disclosure on the
 * hotspot's own card (CredentialsStep.tsx) — the row states the requirement,
 * a tap opens the fields. Both are still mandatory: the primary action stays
 * unavailable until they are supplied and matching, which is what every caller
 * of this helper goes on to exercise.
 */
export async function fillCredentialsStep(page: Page) {
  await page.locator("#cred-password").fill("clawbox-pass");
  await page.locator("#cred-confirm").fill("clawbox-pass");
  await page.getByRole("button", { name: /Hotspot Password/i }).click();
  await page.locator("#hotspot-password").fill("hotspot-pass");
  await page.locator("#hotspot-confirm").fill("hotspot-pass");
}

/**
 * Submit the credentials step, through the write-down confirmation.
 *
 * Connect no longer saves: both secrets this step sets are write-only
 * afterwards, so the wizard reads them back and waits for a deliberate
 * acknowledgement first (CredentialsWriteDownDialog.tsx). Asserting the
 * dialog here means every setup path that walks past step 3 also proves the
 * interposition is still there.
 */
export async function submitCredentialsStep(page: Page) {
  await page.getByRole("button", { name: /^Connect$/ }).click();
  const writeDown = page.getByTestId("credentials-writedown-dialog");
  await expect(writeDown).toBeVisible({ timeout: 10_000 });
  // The acknowledgement input is visually replaced, so its own label sits over
  // it — clicking the label is both what a customer does and the only thing
  // Playwright can land on.
  await writeDown.getByTestId("writedown-ack-label").click();
  await expect(writeDown.getByTestId("writedown-ack")).toBeChecked();
  await writeDown.getByTestId("writedown-continue").click();
}

/**
 * Choose an AI provider from the wizard's provider list.
 *
 * The list shows the provider currently in play and keeps the rest behind its
 * "Show more providers" toggle (AIModelsStep.tsx), so anything other than the
 * default needs the list opened first. Picking closes it again on the chosen
 * row, so this is also how a test hops from one provider to the next.
 */
export async function pickAiProvider(page: Page, name: string) {
  const step = page.getByTestId("setup-step-ai-models");
  await expandAiProviderList(page);
  await step.getByText(name, { exact: true }).first().click();
}

/**
 * Open the provider list if anything is still hidden behind its toggle.
 *
 * Two async beats stand between arriving at this step and the list holding
 * still, and the expansion has to be decided after BOTH:
 *
 *  1. the device edition resolves — until it does, the step's testid sits on a
 *     neutral skeleton that renders no radiogroup at all;
 *  2. the provider in play lands — `selectedProvider` is what collapses the
 *     list onto a single row (`providerListCollapsed` in AIModelsStep.tsx), so
 *     until it resolves the list renders in full with no toggle on it.
 *
 * A point-in-time `count()` taken between those two reads an uncollapsed list,
 * concludes there is nothing to open, and the list then collapses underneath
 * whatever the caller asserts next. The checked radio is beat 2's signal: the
 * list cannot collapse before one exists, so waiting for it makes the count
 * that follows a reading of the settled list rather than a race.
 */
export async function expandAiProviderList(page: Page) {
  const step = page.getByTestId("setup-step-ai-models");
  const group = step.getByRole("radiogroup", { name: "AI Provider" });
  await expect(group).toBeVisible();
  await expect(group.locator("input[type=radio]:checked")).toHaveCount(1);

  const moreToggle = group.getByRole("button", { name: /more provider/i });
  if ((await moreToggle.count()) > 0) {
    await moreToggle.first().click();
    // The toggle renders only while something is still hidden, so its going
    // away is the list being fully open — and leaves the caller asserting
    // against an expanded list rather than a mid-transition one.
    await expect(moreToggle).toHaveCount(0);
  }
}

export async function completeSetupWizard(page: Page) {
  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
  // Ethernet-first happy path: a wired uplink lets the wizard advance in-page.
  // (The WiFi path is covered by setup-wifi-handoff.spec.ts.)
  await page.getByRole("button", { name: "Continue with Ethernet" }).click();

  const updateStep = page.getByTestId("setup-step-update");
  const credentialsStep = page.getByTestId("setup-step-credentials");
  await expect(wizardStepAfterWifi(page)).toBeVisible({ timeout: 10_000 });
  if (await updateStep.isVisible().catch(() => false)) {
    const advancedAutomatically = await expect(credentialsStep).toBeVisible({ timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    if (!advancedAutomatically) {
      await updateStep.getByRole("button", { name: "Continue" }).click();
    }
  }
  await expect(credentialsStep).toBeVisible({ timeout: 10_000 });

  await fillCredentialsStep(page);
  await submitCredentialsStep(page);

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();
  await pickAiProvider(page, "OpenAI GPT");
  await page.locator("#ai-api-key").fill("sk-test-openai-key");
  await page.getByRole("button", { name: /Connect to OpenAI GPT/i }).click();

  // Local AI step was removed from initial setup (see SetupWizard.tsx) —
  // owners now reach Gemma/Ollama via Settings → Local AI on demand. The
  // wizard now goes straight from AI provider to Telegram.
  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
}

/**
 * Open the chat popup from the shelf's crab button.
 *
 * Not `getByRole("button", { name: "Chat" })`: three controls now answer to
 * that name — the desktop icon, the shelf's app icon and this toggle — because
 * the chat app's own label became the translated "Chat" (it used to be the
 * unique "Claw"). Only this one opens the popup; the other two open a window.
 * The shelf renders in two layouts and only one is on screen, hence `:visible`
 * — the same shape openLauncher uses for its own button.
 */
export async function openChatPopup(page: Page) {
  const button = page.locator('[data-testid="shelf-chat-button"]:visible').first();
  await waitForHydration(button);
  await button.click();
}

/**
 * The shelf is server-rendered, so its buttons are visible — and clickable, as
 * far as Playwright's actionability checks go — before React has attached a
 * single handler to them. A click that lands in that window is simply lost,
 * and on a loaded box (a build running beside the suite) the window is long
 * enough to lose one every few runs. React marks a node it has hydrated with
 * its own expando (`__reactProps$…`), so that is the signal: not "the button
 * exists", but "the button has its onClick".
 */
async function waitForHydration(target: Locator) {
  await expect
    .poll(
      () => target.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps"))),
      { message: "the shelf should be hydrated before it is clicked" },
    )
    .toBe(true);
}

export async function openLauncher(page: Page) {
  const launcher = page.getByTestId("app-launcher");
  const alreadyOpen = await launcher.isVisible().catch(() => false);
  if (alreadyOpen) return;

  const button = page.locator('[data-testid="shelf-launcher-button"]:visible').first();
  await waitForHydration(button);
  // Click until the launcher is actually there. A forced click can land in the
  // gap between hydration and the shelf's handlers being wired (React attaches
  // its root listener before every component has subscribed to it), and with
  // a second browser competing for CPU that gap is wide enough to lose the
  // click entirely — the old single click + 15 s wait was the one flake that
  // kept the e2e job on one worker. Re-checking before each retry keeps a
  // late-arriving open from being toggled shut by the next click.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await launcher.isVisible().catch(() => false)) return;
    await button.click({ force: true });
    const shown = await launcher
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) return;
  }
  await expect(launcher).toBeVisible();
}
