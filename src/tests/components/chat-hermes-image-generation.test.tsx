import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@/tests/helpers/test-utils";
import {
  GENERATED_IMAGE_PATH,
  installHermesBox,
  mountHermesChat,
  type HermesBox,
} from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * Asking a Hermes box for a picture, from the composer.
 *
 * This is the feature the capability table said was absent until now, and the
 * reason it was absent is worth keeping in view: the Hermes agent has no image
 * tool and no provider slot to grow one, so asking for a picture in words
 * reached nothing at all and the turn ran until it timed out. The proxy was
 * never the blocker — it serves image generation to the same device token voice
 * input already spends — so the fix is a caller, and the caller is the box.
 *
 * Which means the TRIGGER moves to the composer, and these tests are mostly
 * about that button being honest: present exactly when the box can draw, absent
 * otherwise, and never leaving the customer looking at a wait that has no end.
 */

let box: HermesBox;

/** A box with both halves: the credential, and a live image route to spend it on. */
function boxThatCanDraw(): void {
  box.facts.hasClawaiToken = true;
  box.facts.hasClawaiImageRoute = true;
}

const PICTURE_BUTTON = "generate-image";

async function typeAndDraw(textarea: HTMLElement, prompt: string) {
  fireEvent.change(textarea, { target: { value: prompt } });
  const button = await screen.findByTestId(PICTURE_BUTTON);
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  return button;
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  box = installHermesBox();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("the picture button", () => {
  it("is absent on a box with no ClawBox AI credential", async () => {
    // The default device: a customer on their own provider key. There is
    // nothing to pay for a picture with, so offering to draw one would be the
    // same lie the microphone used to tell.
    box.facts.hasClawaiImageRoute = true;
    await mountHermesChat(box);
    expect(screen.queryByTestId(PICTURE_BUTTON)).toBeNull();
  });

  it("is absent on a linked box whose image route is not answering", async () => {
    // The half that only a probe can know. The credential is real, and the
    // proxy is down or has retired the model id this build asks for — either
    // way a POST comes back 400 or never, and a button here would be dead.
    box.facts.hasClawaiToken = true;
    box.facts.hasClawaiImageRoute = false;
    await mountHermesChat(box);
    expect(screen.queryByTestId(PICTURE_BUTTON)).toBeNull();
  });

  it("appears once the box has both a credential and a live route", async () => {
    boxThatCanDraw();
    await mountHermesChat(box);
    await screen.findByTestId(PICTURE_BUTTON);
  });

  it("stays disabled until there is something to draw", async () => {
    // The composer's text IS the prompt, so an empty one would spend a
    // generation — one of only a handful a Free plan gets in a day — on silence.
    boxThatCanDraw();
    const textarea = await mountHermesChat(box);
    const button = await screen.findByTestId(PICTURE_BUTTON);
    expect(button).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "a red maple leaf" } });
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});

describe("a text-to-picture turn", () => {
  it("sends the prompt, shows the wait, and renders the picture that comes back", async () => {
    boxThatCanDraw();
    const textarea = await mountHermesChat(box);
    await typeAndDraw(textarea, "a red maple leaf");

    // The prompt left the composer and reached the box's own images route —
    // never the browser calling the proxy, because the token is the DEVICE's.
    await waitFor(() => expect(box.imagePrompts).toEqual(["a red maple leaf"]));
    expect(box.fetchedUrls.some((u) => u.includes("clawbox.com"))).toBe(false);
    // The prompt is drawn as the customer's own turn, so the wait has something
    // to sit under, and the composer is emptied the way a send empties it.
    await screen.findByText("a red maple leaf");
    expect(textarea).toHaveValue("");

    const picture = await screen.findByRole("img");
    expect(picture).toHaveAttribute(
      "src",
      `/setup-api/chat/media?path=${encodeURIComponent(GENERATED_IMAGE_PATH)}`,
    );
    // …and the wait comes down once there is something to show.
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("keeps the picture across a reload, because the BOX recorded it", async () => {
    // The transcript is written server-side, by the route, before and after the
    // upstream call — which is what makes a customer who closes the tab on a
    // 15-second generation find the picture waiting on their next visit. Here
    // that is simulated by remounting against the transcript the box holds.
    boxThatCanDraw();
    const mediaRef = `/setup-api/chat/media?path=${encodeURIComponent(GENERATED_IMAGE_PATH)}`;
    box.storedTranscript = [
      { role: "user", text: "a red maple leaf", timestamp: 10 },
      { role: "assistant", text: "", timestamp: 11, media: [mediaRef] },
    ];
    await mountHermesChat(box);
    await screen.findByText("a red maple leaf");
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", mediaRef));
  });

  it("says what went wrong instead of waiting forever", async () => {
    // The failure this task exists to end is a request for a picture that never
    // resolves. What replaces it has to be a SENTENCE — an error bubble the
    // customer can act on — and the wait has to actually stop.
    boxThatCanDraw();
    box.imageReply = () => ({
      ok: false,
      status: 429,
      payload: { error: "You have used up today's ClawBox AI pictures." },
    });
    const textarea = await mountHermesChat(box);
    await typeAndDraw(textarea, "a red maple leaf");

    await screen.findByText(/used up today's ClawBox AI pictures/);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("never puts the box's internals in the customer's transcript", async () => {
    // The same rule a failed turn goes through. Everything the route can say
    // was written for a customer, but the layers under it are a proxy and a
    // filesystem, and both quote what they were handed.
    boxThatCanDraw();
    box.imageReply = () => ({
      ok: false,
      status: 500,
      payload: { error: "EACCES: open '/home/clawbox/clawbox/data/chat-media/x.png'" },
    });
    const textarea = await mountHermesChat(box);
    await typeAndDraw(textarea, "a red maple leaf");

    await screen.findByText(/That picture could not be made/);
    expect(screen.queryByText(/home\/clawbox/)).toBeNull();
  });

  it("spends one generation on one intent, however fast the second click lands", async () => {
    // Two guards stand behind this and both matter: the button disables while a
    // wait is running, and the handler re-checks a REF rather than the render
    // state, because a second click can land in the window before that commit.
    // Either one catching it is the property being asserted — a double click is
    // two charges against a daily allowance that is one picture on the Free
    // plan, and the customer only asked once.
    boxThatCanDraw();
    const textarea = await mountHermesChat(box);
    fireEvent.change(textarea, { target: { value: "a red maple leaf" } });
    const button = await screen.findByTestId(PICTURE_BUTTON);
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(box.imagePrompts).toEqual(["a red maple leaf"]));
    // …and it stays one after everything has settled, rather than a second
    // request arriving a tick later.
    await screen.findByRole("img");
    expect(box.imagePrompts).toHaveLength(1);
  });
});
