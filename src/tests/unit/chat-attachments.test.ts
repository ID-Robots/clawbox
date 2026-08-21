import { describe, expect, it, vi, afterEach } from "vitest";
import {
  classifyStagingFailure,
  createPreviewUrl,
  isPreviewableImage,
  revokePreviews,
} from "@/lib/chat-attachments";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";
import { describeTranscribeFailure } from "@/lib/chat-voice-input";

/**
 * TASK-380: the composer accepted a pasted image, showed a stamped file name
 * the user had never seen, and said nothing at all when staging failed.
 *
 * The parts worth testing away from the DOM are the two that leak: object URLs
 * pin the whole Blob until revoked, and error text is where absolute paths and
 * bearer tokens escape onto a customer's screen.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attachment previews", () => {
  it("mints an object URL for an image", () => {
    const createObjectURL = vi.fn(() => "blob:preview-1");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });

    const file = new Blob(["x"], { type: "image/png" });
    expect(createPreviewUrl(file)).toBe("blob:preview-1");
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });

  it("does not mint one for a non-image, so a PDF cannot pin its bytes", () => {
    const createObjectURL = vi.fn(() => "blob:nope");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });

    expect(createPreviewUrl(new Blob(["x"], { type: "application/pdf" }))).toBeUndefined();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("degrades to no preview where the API is absent instead of throwing", () => {
    // jsdom and the server render are both this case. An attachment without a
    // thumbnail is fine; an exception here would lose the attachment entirely.
    vi.stubGlobal("URL", {});
    expect(() => createPreviewUrl(new Blob(["x"], { type: "image/png" }))).not.toThrow();
    expect(createPreviewUrl(new Blob(["x"], { type: "image/png" }))).toBeUndefined();
  });

  it("degrades to no preview when the browser refuses to mint the URL", () => {
    vi.stubGlobal("URL", {
      createObjectURL: () => { throw new Error("refused"); },
      revokeObjectURL: vi.fn(),
    });
    expect(createPreviewUrl(new Blob(["x"], { type: "image/png" }))).toBeUndefined();
  });

  it("revokes every preview in the list and skips the ones without", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL });

    revokePreviews([
      { previewUrl: "blob:a" },
      { previewUrl: undefined },
      { previewUrl: "blob:b" },
    ]);

    expect(revokeObjectURL.mock.calls.map((c) => c[0])).toEqual(["blob:a", "blob:b"]);
  });

  it("keeps revoking after one throws, so a bad entry cannot strand the rest", () => {
    const revoked: string[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(),
      revokeObjectURL: (u: string) => {
        if (u === "blob:bad") throw new Error("nope");
        revoked.push(u);
      },
    });

    revokePreviews([{ previewUrl: "blob:bad" }, { previewUrl: "blob:good" }]);
    expect(revoked).toEqual(["blob:good"]);
  });

  it("treats only image/* as previewable", () => {
    expect(isPreviewableImage("image/jpeg")).toBe(true);
    expect(isPreviewableImage("text/plain")).toBe(false);
    expect(isPreviewableImage(undefined)).toBe(false);
  });
});

describe("staging failure classification", () => {
  it("splits by what the customer can do about it", () => {
    expect(classifyStagingFailure(413, null).reason).toBe("tooLarge");
    expect(classifyStagingFailure(400, null).reason).toBe("rejected");
    expect(classifyStagingFailure(415, null).reason).toBe("rejected");
    expect(classifyStagingFailure(401, null).reason).toBe("session");
    expect(classifyStagingFailure(403, null).reason).toBe("session");
    expect(classifyStagingFailure(500, null).reason).toBe("box");
  });

  it("calls a request that never completed the box's problem, not the file's", () => {
    // No status means fetch threw: a dropped connection or a gateway restart
    // mid-upload. Telling the user their file was rejected would send them
    // off shrinking a perfectly good screenshot.
    expect(classifyStagingFailure(undefined, null).reason).toBe("box");
  });

  it("passes through a vetted message from the box", () => {
    expect(classifyStagingFailure(413, { error: "Request exceeds the size limit" }).detail)
      .toBe("Request exceeds the size limit");
  });

  it("drops a message that carries an absolute path", () => {
    // The route answers `Upload failed: ${err.message}` and an fs error quotes
    // the path it could not write — which names the customer's home directory
    // and our media layout.
    expect(
      classifyStagingFailure(500, { error: "Upload failed: ENOSPC /home/clawbox/.openclaw/media/chat-attachments/x.png" }).detail,
    ).toBeNull();
  });
});

describe("safe error text", () => {
  it("drops paths, URLs, credentials and stack frames", () => {
    expect(sanitizeErrorMessage("wrote /home/clawbox/.openclaw/x")).toBeNull();
    expect(sanitizeErrorMessage("POST https://clawbox.com/api/ai failed")).toBeNull();
    expect(sanitizeErrorMessage("Bearer claw_abc123 rejected")).toBeNull();
    expect(sanitizeErrorMessage("TypeError\n    at handler (route.ts:12)")).toBeNull();
    expect(sanitizeErrorMessage("   ")).toBeNull();
    expect(sanitizeErrorMessage(42)).toBeNull();
  });

  it("keeps a plain sentence", () => {
    expect(sanitizeErrorMessage("Request exceeds the size limit")).toBe("Request exceeds the size limit");
  });

  it("is the same filter the voice path uses", () => {
    // Two copies of a leak filter is two places to forget a rule, so the voice
    // helper delegates here. If that delegation is ever undone, this fails.
    expect(describeTranscribeFailure({ error: "Bearer claw_abc123 rejected" })).toBeNull();
    expect(describeTranscribeFailure({ error: "Nothing was heard" })).toBe("Nothing was heard");
  });
});
