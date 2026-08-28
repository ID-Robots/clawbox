import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { LANGUAGES } from "@/lib/i18n";
import { LOCAL_VOICES, VOICE_LANGUAGES, sampleSentence } from "@/lib/voice-catalog";

/**
 * The Voice tab's catalogues have to agree with the things they describe:
 *
 *  - the local voice list is what `clawbox-tts.sh` will actually accept, or a
 *    dropdown entry silently speaks with the script's default instead;
 *  - the language list is the desktop's own locale list, or an 11th locale
 *    lands in one place and not the other.
 *
 * Neither can be enforced by types across a shell script and a "use client"
 * module, so this test is the contract.
 */

const SCRIPT = path.resolve(__dirname, "../../../scripts/openclaw/clawbox-tts.sh");

describe("voice catalogue", () => {
  it("offers exactly the voices the local script accepts", () => {
    const listed = execFileSync("bash", [SCRIPT, "--list-voices"], { encoding: "utf8" }).trim().split(/\s+/).sort();
    expect(LOCAL_VOICES.map((v) => v.id).sort()).toEqual(listed);
  });

  it("offers exactly the desktop's languages, each with its own sample sentence", () => {
    expect(VOICE_LANGUAGES.map((l) => l.id).sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
    for (const l of VOICE_LANGUAGES) {
      expect(sampleSentence(l.id).length).toBeGreaterThan(40);
    }
  });
});
