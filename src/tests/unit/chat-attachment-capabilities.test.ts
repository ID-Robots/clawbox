import { describe, expect, it } from "vitest";
import { attachmentAcceptAttribute, partitionAttachments } from "@/lib/chat-attachments";
import { capabilitiesFor } from "@/lib/harness/capabilities";

/**
 * What the composer accepts, decided by what the box can pass to the model.
 *
 * Two flags rather than one, because the honest answer on a Hermes box that can
 * see pictures is "pictures yes, documents no". A single canAttach would force
 * a choice between hiding a working feature and accepting a file that silently
 * never reaches the model — and both of those have shipped before.
 */

const file = (name: string, type: string) => new File([new Uint8Array([1])], name, { type });

const HERMES_WITH_IMAGES = capabilitiesFor("hermes", {
  hasClawaiToken: true,
  hermesSupportsImages: true,
  // Both halves: a turn that carries the picture and somewhere that looks at
  // it. Without the second the composer offers nothing — see the capability
  // table's own tests.
  hermesHasVisionRoute: true,
  hermesStreamsTurns: false,
});
const HERMES_BARE = capabilitiesFor("hermes", {
  hasClawaiToken: false,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
  hermesStreamsTurns: false,
});
const OPENCLAW = capabilitiesFor("openclaw", {
  hasClawaiToken: true,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
  hermesStreamsTurns: false,
});

describe("partitionAttachments", () => {
  it("takes everything where everything can reach the model", () => {
    const files = [file("a.png", "image/png"), file("b.pdf", "application/pdf")];
    const { accepted, refused } = partitionAttachments(files, OPENCLAW);
    expect(accepted).toHaveLength(2);
    expect(refused).toHaveLength(0);
  });

  it("takes the picture and refuses the document where only pictures have a way in", () => {
    // `hermes chat --image` is image-only, and the agent's own path-in-prompt
    // resolver matches picture extensions by design — a PDF has no route to the
    // model at all.
    const { accepted, refused } = partitionAttachments(
      [file("cat.png", "image/png"), file("invoice.pdf", "application/pdf")],
      HERMES_WITH_IMAGES,
    );
    expect(accepted.map((f) => f.name)).toEqual(["cat.png"]);
    expect(refused.map((f) => f.name)).toEqual(["invoice.pdf"]);
  });

  it("refuses everything on a box whose agent takes no attachment at all", () => {
    const { accepted, refused } = partitionAttachments(
      [file("cat.png", "image/png"), file("notes.txt", "text/plain")],
      HERMES_BARE,
    );
    expect(accepted).toHaveLength(0);
    expect(refused).toHaveLength(2);
  });

  it("refuses a file with no MIME type where documents cannot get in", () => {
    // An unlabelled file is not a picture as far as this decision goes, and
    // guessing in the permissive direction is how one silently never arrives.
    const { accepted } = partitionAttachments([file("mystery", "")], HERMES_WITH_IMAGES);
    expect(accepted).toHaveLength(0);
  });

  it("refuses before the upload, not after", () => {
    // Nothing about this reaches the network: a document that got as far as the
    // box would be written to disk, counted against retention and named in a
    // turn nobody could read it from.
    const { accepted, refused } = partitionAttachments([file("a.pdf", "application/pdf")], HERMES_WITH_IMAGES);
    expect(accepted).toEqual([]);
    expect(refused).toHaveLength(1);
  });
});

describe("attachmentAcceptAttribute", () => {
  it("offers pictures and documents where both work", () => {
    const accept = attachmentAcceptAttribute(OPENCLAW);
    expect(accept).toContain("image/*");
    expect(accept).toContain(".pdf");
  });

  it("offers only pictures where only pictures work", () => {
    const accept = attachmentAcceptAttribute(HERMES_WITH_IMAGES);
    expect(accept).toBe("image/*");
  });

  it("offers nothing where nothing works", () => {
    // The button itself is hidden in this state; an empty filter is what the
    // attribute would mean if it were somehow rendered.
    expect(attachmentAcceptAttribute(HERMES_BARE)).toBe("");
  });
});
