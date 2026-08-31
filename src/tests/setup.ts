import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Testing Library's waitFor/findBy give up after 1 s by default. That is a
// budget for a render on an idle laptop; on a loaded CI runner or this Jetson
// (four workers, the slow files started first) a jsdom render of the chat can
// take longer, and the only tests that ever tripped it were waiting for
// something that arrived a moment later. A passing wait costs the same at any
// budget; only a genuinely failing one takes longer to say so.
configure({ asyncUtilTimeout: 5_000 });

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Unit tests must never write the REAL ~/.openclaw: on an OpenClaw 2 box a
// recreated legacy auth-profiles.json poisons the migrated sqlite auth store
// and the gateway refuses every turn until `doctor --fix` runs (this bit the
// dev box on 2026-08-31 — a configure-route suite without an fs mock wrote
// the real store mid-run). Every openclaw-path module honors OPENCLAW_HOME,
// so point it at a per-run scratch before any suite imports one. `??=` keeps
// suites that stage their own OPENCLAW_HOME fully in charge.
import os from "os";
import path from "path";
process.env.OPENCLAW_HOME ??= path.join(os.tmpdir(), `clawbox-vitest-openclaw-${process.pid}`);
