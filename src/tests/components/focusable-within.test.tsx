import { afterEach, describe, expect, it } from "vitest";
import { focusableWithin } from "@/hooks/useModalDialog";

/**
 * Direct tests for the focus-trap's candidate filter.
 *
 * These exist because one branch of it is unreachable from the component
 * tests: `checkVisibility()` is a CSSOM-View API that needs a layout engine,
 * and jsdom does not implement it. On a real device that filter always runs;
 * under the modal tests it never does. Stubbing the method here covers both
 * sides, so the trap's only genuinely new logic is not shipped untested.
 */

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

/** Give elements a checkVisibility() that reports the named ids as hidden. */
function stubVisibility(hiddenIds: string[]) {
  const proto = Element.prototype as unknown as { checkVisibility?: () => boolean };
  const had = Object.prototype.hasOwnProperty.call(proto, "checkVisibility");
  const original = proto.checkVisibility;
  proto.checkVisibility = function (this: Element) {
    return !hiddenIds.includes(this.id);
  };
  return () => {
    if (had) proto.checkVisibility = original;
    else delete proto.checkVisibility;
  };
}

describe("focusableWithin", () => {
  it("returns interactive descendants in DOM order", () => {
    const host = mount(`
      <button id="a">a</button>
      <a id="b" href="#x">b</a>
      <input id="c" />
      <select id="d"></select>
      <textarea id="e"></textarea>
      <div id="f" tabindex="0">f</div>
    `);

    expect(focusableWithin(host).map((el) => el.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("skips controls that cannot take focus", () => {
    const host = mount(`
      <button id="ok">ok</button>
      <button id="disabled" disabled>no</button>
      <input id="hiddenType" type="hidden" />
      <button id="ariaHidden" aria-hidden="true">no</button>
      <button id="nativelyHidden" hidden>no</button>
      <div id="skipped" tabindex="-1">no</div>
      <a id="noHref">no</a>
    `);

    expect(focusableWithin(host).map((el) => el.id)).toEqual(["ok"]);
  });

  it("skips anything inside an inert or hidden subtree", () => {
    const host = mount(`
      <button id="ok">ok</button>
      <div inert><button id="inInert">no</button></div>
      <div hidden><button id="inHidden">no</button></div>
    `);

    expect(focusableWithin(host).map((el) => el.id)).toEqual(["ok"]);
  });

  it("drops controls the engine reports as not visible", () => {
    const host = mount(`
      <button id="shown">shown</button>
      <button id="invisible">invisible</button>
    `);
    const restore = stubVisibility(["invisible"]);
    try {
      // The production branch: with a layout engine present, a control the
      // engine calls invisible must not become the trap's wrap target.
      expect(focusableWithin(host).map((el) => el.id)).toEqual(["shown"]);
    } finally {
      restore();
    }
  });

  it("keeps every control when the engine offers no visibility check", () => {
    const host = mount(`
      <button id="one">one</button>
      <button id="two">two</button>
    `);
    // jsdom's own state — no checkVisibility — so nothing is filtered and the
    // trap still has both ends to wrap between.
    expect("checkVisibility" in Element.prototype).toBe(false);
    expect(focusableWithin(host).map((el) => el.id)).toEqual(["one", "two"]);
  });
});
