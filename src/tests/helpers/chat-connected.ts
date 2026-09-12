import { expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";

/**
 * Wait until a chat surface has finished its gateway handshake.
 *
 * `ChatPopup` drops every `chat` / `session.message` event whose `sessionKey`
 * is not the one it is showing (`ChatPopup.tsx`, the `sk !== sessionKeyRef`
 * guard), and it only learns that key from the `connect` RESPONSE. A fake
 * socket that answers on `setTimeout(0)` and a test that pushes a turn as soon
 * as the socket OBJECT exists are therefore racing: on an idle machine the
 * handshake has already landed, and under a full-suite run it has not — the
 * turn is dropped for good and the test waits out its whole budget for
 * something that will never render.
 *
 * Measured on beta, 2026-09-12: four chat suites failed only in a full run,
 * passed in isolation, and still failed with the test budget raised to 60 s.
 * It was never slowness.
 *
 * The main tab carries the key in the DOM, which is the surface's own report
 * that it has it — a stronger signal than anything the fake socket can say
 * about what it sent.
 */
export async function waitForChatSession(sessionKey = "agent:main:main"): Promise<void> {
  await waitFor(() =>
    expect(screen.getAllByTestId("chat-tab")[0]).toHaveAttribute("data-session-key", sessionKey),
  );
}
