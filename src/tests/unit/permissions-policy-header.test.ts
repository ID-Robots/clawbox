import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

// The Permissions-Policy the box serves with every page.
//
// This is not a style assertion. A feature named in that header with an empty
// allowlist is switched off for the document itself: the browser rejects
// getUserMedia with NotAllowedError before the user is ever asked, in a secure
// context, with the permission already granted. The chat composer's microphone
// was exactly that for its whole first day — a button whose only possible
// outcome was "ClawBox needs microphone access", on a box where nothing had
// denied it. TASK-381.

async function policy(): Promise<string> {
  const groups = await nextConfig.headers!();
  const all = groups.flatMap(g => g.headers);
  const header = all.find(h => h.key.toLowerCase() === "permissions-policy");
  expect(header, "the box must send a Permissions-Policy").toBeTruthy();
  return header!.value;
}

describe("Permissions-Policy", () => {
  it("lets this origin use the microphone", async () => {
    // `(self)` and not `()`: voice input is a first-party feature of this UI.
    expect(await policy()).toMatch(/microphone=\(self\)/);
  });

  it("does not hand the microphone to anyone else", async () => {
    // `*` would extend it to every embedder; the portal frames this device on
    // clawbox.com and must not silently gain a microphone with it.
    const value = await policy();
    // `*` INSIDE the parentheses is the wildcard the spec actually defines —
    // `microphone=(*)` and `microphone=(self *)` both hand it to every
    // embedder, and neither contains the string `microphone=*`.
    expect(value).not.toMatch(/microphone=\([^)]*\*/);
    expect(value).not.toMatch(/microphone=\*/);
    expect(value).not.toMatch(/microphone=\([^)]*https?:/);
  });

  it("keeps the camera and geolocation switched off", async () => {
    // Neither is used anywhere in the UI, so neither is delegated. If that ever
    // changes it should be a deliberate edit here, not a side effect of the
    // line above.
    const value = await policy();
    expect(value).toMatch(/camera=\(\)/);
    expect(value).toMatch(/geolocation=\(\)/);
  });
});
