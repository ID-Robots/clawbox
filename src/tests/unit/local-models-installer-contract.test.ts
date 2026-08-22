import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";

/**
 * The Local Models tab reads the device by looking for the exact artefacts
 * `scripts/install-voice.sh` writes. If the installer ever moves a unit name,
 * the stamp or the Piper directory, the tab would quietly report every voice
 * engine as missing — the same class of silent drift the tab was built to end.
 *
 * So this asserts against the SHIPPED SCRIPT, not against a copy of its values:
 * change the installer without changing the library and this test fails.
 */

const INSTALLER = new URL("../../../scripts/install-voice.sh", import.meta.url);

async function installer(): Promise<string> {
  return await fs.readFile(INSTALLER, "utf8");
}

describe("local-models agrees with the voice installer", () => {
  it("watches for the unit files the installer actually writes", async () => {
    const script = await installer();
    const { KOKORO_UNIT, WHISPER_UNIT } = await import("@/lib/local-models");
    expect(script).toContain(`$SYSTEMD_USER/${KOKORO_UNIT}`);
    expect(script).toContain(`$SYSTEMD_USER/${WHISPER_UNIT}`);
  });

  it("looks for the units in the directory the installer writes them to", async () => {
    const script = await installer();
    const { SYSTEMD_USER_DIR } = await import("@/lib/local-models");
    expect(script).toContain('SYSTEMD_USER="$CLAWBOX_HOME/.config/systemd/user"');
    expect(SYSTEMD_USER_DIR.endsWith("/.config/systemd/user")).toBe(true);
  });

  it("looks for the Kokoro stamp at the installer's path", async () => {
    const script = await installer();
    const { KOKORO_STAMP } = await import("@/lib/local-models");
    expect(script).toContain('KOKORO_STAMP="$CLAWBOX_HOME/.cache/clawbox/kokoro-installed"');
    expect(KOKORO_STAMP.endsWith("/.cache/clawbox/kokoro-installed")).toBe(true);
  });

  it("looks for Piper where the installer puts it", async () => {
    const script = await installer();
    const { PIPER_DIR, PIPER_BINARY, PIPER_VOICE_DIR } = await import("@/lib/local-models");
    expect(script).toContain('PIPER_DIR="${PIPER_DIR:-$CLAWBOX_HOME/.local/share/piper}"');
    expect(script).toContain('PIPER_VOICE_DIR="${PIPER_VOICE_DIR:-$PIPER_DIR/voices}"');
    expect(script).toContain('"$PIPER_DIR/piper"');
    expect(PIPER_DIR.endsWith("/.local/share/piper")).toBe(true);
    expect(PIPER_BINARY.endsWith("/.local/share/piper/piper")).toBe(true);
    expect(PIPER_VOICE_DIR.endsWith("/.local/share/piper/voices")).toBe(true);
  });
});

describe("local-models agrees with the sudoers grants", () => {
  it("issues exactly the ollama command the sudoers file allows", async () => {
    // sudoers Cmnd_Spec matching is argument-exact. A grant for
    // `systemctl disable ollama.service` does NOT authorise
    // `systemctl disable --now ollama.service`; getting this wrong means the
    // toggle hangs on a password prompt no web request can answer.
    const sudoers = await fs.readFile(new URL("../../../config/clawbox-sudoers", import.meta.url), "utf8");
    const { OLLAMA_UNIT } = await import("@/lib/local-models");
    for (const verb of ["enable", "disable"]) {
      const granted = sudoers
        .split("\n")
        .some(line => line.trim().startsWith("clawbox ")
          && /\/usr\/bin\/systemctl/.test(line)
          && new RegExp(`\\b${verb}\\s+--now\\s+${OLLAMA_UNIT.replace(/[.]/g, "\\.")}\\s*$`).test(line));
      expect(granted, `no NOPASSWD grant for systemctl ${verb} --now ${OLLAMA_UNIT}`).toBe(true);
    }
  });
});
