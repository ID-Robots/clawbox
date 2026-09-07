import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ClawKeepApp from "@/components/ClawKeepApp";
import { I18nProvider } from "@/lib/i18n";

/**
 * The restore picker's metadata line on a LABELLED snapshot.
 *
 * A labelled row shows the timestamp under the label, and the timestamp is
 * the whole filename when the parser does not recognise the name (an
 * encrypted `…+00-00-openclaw-backup.tar.gz.enc`, as on the box the sweep ran
 * against). The three spans sat in a flex row with no rule about who gives
 * way, so the filename broke onto two lines and "7.8 MB" / "2d ago" were
 * squeezed into two-line columns beside it (UI sweep, 2026-09-07). jsdom lays
 * nothing out, so the test pins the rule itself: the timestamp truncates, the
 * size and the age never wrap and never shrink.
 */

const BASE_STATUS = {
  paired: true,
  configured: true,
  server: "https://portal.example",
  lastBackupAtMs: Date.now() - 3_600_000,
  openclawInstalled: true,
  daemonInstalled: true,
  archiverReady: true,
  encryptionConfigured: true,
  snapshotCount: 1,
  cloudBytes: 1024,
  schedule: { enabled: false, frequency: "daily", timeOfDay: "03:00", weekday: 0, retentionKeepLast: 0 },
  nextRunAtMs: 0,
};

// The offset form the box actually writes, which the name parser does not
// recognise — so the metadata line carries the filename itself.
const SNAPSHOT = "2026-09-04T10-35-23.004+00-00-openclaw-backup.tar.gz.enc";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
    if (url.includes("/setup-api/clawkeep/snapshots")) {
      return ok({
        snapshots: [{ name: SNAPSHOT, label: "test", size_bytes: 8_178_892, last_modified_ms: Date.now() - 2 * 86_400_000 }],
      });
    }
    if (url.includes("/setup-api/clawkeep")) return ok(BASE_STATUS);
    return ok({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ClawKeep restore picker — a labelled snapshot's metadata line", () => {
  it("truncates the timestamp and keeps the size and the age whole", async () => {
    render(<I18nProvider><ClawKeepApp /></I18nProvider>);
    fireEvent.click(
      await screen.findByRole("button", { name: /Restore from snapshot/i }, { timeout: 5000 }),
    );

    const timestamp = await screen.findByText(SNAPSHOT, {}, { timeout: 5000 });
    expect(timestamp.tagName).toBe("SPAN");
    // The one part of the line that may be long is the one that gives way —
    // and its full text stays reachable.
    expect(timestamp.classList.contains("truncate")).toBe(true);
    expect(timestamp.classList.contains("min-w-0")).toBe(true);
    expect(timestamp.getAttribute("title")).toBe(SNAPSHOT);

    const line = timestamp.parentElement!;
    expect(line.classList.contains("min-w-0")).toBe(true);

    const size = screen.getByText("7.8 MB");
    const age = screen.getByText("2d ago");
    expect(size.parentElement).toBe(line);
    expect(age.parentElement).toBe(line);
    for (const span of [size, age]) {
      expect(span.classList.contains("whitespace-nowrap")).toBe(true);
      expect(span.classList.contains("shrink-0")).toBe(true);
    }
  });
});
