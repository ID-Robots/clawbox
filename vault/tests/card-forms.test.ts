// Checkout field detection and card filling against HTML fixtures in the DOM
// test environment: autocomplete forms, split expiry (selects and inputs, 2-
// and 4-digit years), Bulgarian and German labels, input masks, and the frame
// rules: a payment provider iframe (Stripe-style) is filled when the human
// started the fill; an unknown cross-origin iframe is always refused.
import { afterEach, describe, expect, test } from "bun:test";
import { cardFieldKinds, findCardFields, fillCardFields, guardedCardFill, probeCardFrame, readTypedCard } from "../src/extension/cardforms";
import { cardFrameAccess, chipAllowed, pickCardTab, planCardFill, type CardFrameProbe } from "../src/extension/frames";
import { isPaymentFrameOrigin } from "../src/shared/hosts";
import { openPage, type DomPage } from "./helpers/dom";

const CARD = { number: "4242424242424242", cardholder: "Jane Q Doe", exp: "12/34", cvv: "123", brand: "visa" };

let page: DomPage | null = null;
afterEach(async () => {
  await page?.close();
  page = null;
});

async function open(url: string, routes: Record<string, string>): Promise<DomPage> {
  page = await openPage(url, routes);
  return page;
}

function el<T extends HTMLElement = HTMLInputElement>(win: Window, id: string): T {
  return win.document.getElementById(id) as T;
}

function kindsById(doc: Document): Record<string, string> {
  return Object.fromEntries(findCardFields(doc).map((f) => [f.el.id || f.el.getAttribute("name"), f.kind]));
}

const SHOP = "https://shop.example.com/checkout";

describe("autocomplete checkout form", () => {
  test("finds every cc-* field and nothing else", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-autocomplete.html" });
    expect(kindsById(p.top.document)).toEqual({ "cc-name": "name", "cc-number": "number", "cc-exp": "exp", "cc-csc": "cvc", "cc-type": "type" });
  });

  test("nothing is filled when the page loads", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-autocomplete.html" });
    for (const id of ["cc-name", "cc-number", "cc-exp", "cc-csc", "ship-name", "gift"]) expect(el(p.top, id).value).toBe("");
  });

  test("fills to the field's format and fires input/change/blur", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-autocomplete.html" });
    const events: string[] = [];
    for (const type of ["input", "change", "blur"]) el(p.top, "cc-number").addEventListener(type, () => events.push(type));
    const out = fillCardFields(p.top.document, CARD);
    expect(out.status).toBe("filled");
    expect(new Set(out.filled)).toEqual(new Set(["number", "name", "exp", "cvc", "type"]));
    expect(el(p.top, "cc-number").value).toBe("4242 4242 4242 4242"); // grouped like the placeholder, fits maxlength 19
    expect(el(p.top, "cc-exp").value).toBe("12 / 34"); // "MM / YY"
    expect(el(p.top, "cc-csc").value).toBe("123");
    expect(el(p.top, "cc-name").value).toBe("Jane Q Doe");
    expect(el<HTMLSelectElement>(p.top, "cc-type").value).toBe("VI");
    expect(events).toEqual(["input", "change", "blur"]);
    // shipping, gift card and newsletter fields stay untouched
    for (const id of ["ship-name", "ship-zip", "gift", "nl-email"]) expect(el(p.top, id).value).toBe("");
  });

  test("without a stored CVV the code field is reported missing, not filled", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-autocomplete.html" });
    const out = fillCardFields(p.top.document, { ...CARD, cvv: undefined });
    expect(out.missing).toEqual(["cvc"]);
    expect(el(p.top, "cc-csc").value).toBe("");
  });

  test("an input mask that reformats on input still ends up with the right digits", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-autocomplete.html" });
    const number = el(p.top, "cc-number");
    number.removeAttribute("placeholder");
    // A mask: keep digits, regroup in fours, cap at 19 characters.
    number.addEventListener("input", () => {
      const d = number.value.replace(/\D/g, "").slice(0, 16);
      number.value = d.replace(/(\d{4})(?=\d)/g, "$1 ");
    });
    const exp = el(p.top, "cc-exp");
    exp.addEventListener("input", () => {
      const d = exp.value.replace(/\D/g, "").slice(0, 4);
      exp.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    });
    fillCardFields(p.top.document, CARD);
    expect(number.value).toBe("4242 4242 4242 4242");
    expect(exp.value).toBe("12/34");
  });

  test("reads what the user typed for the card save bar", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-autocomplete.html" });
    el(p.top, "cc-number").value = "4242 4242 4242 4242";
    el(p.top, "cc-exp").value = "12 / 34";
    el(p.top, "cc-csc").value = "123";
    el(p.top, "cc-name").value = "Jane Q Doe";
    expect(readTypedCard(p.top.document, el(p.top, "checkout"))).toEqual({ number: CARD.number, exp: "12/34", cardholder: "Jane Q Doe", cvv: "123" });
    el(p.top, "cc-number").value = "4242 4242 4242 4241"; // fails Luhn: not offered
    expect(readTypedCard(p.top.document)).toBeNull();
  });
});

describe("split expiry", () => {
  test("month and year selects, number and code by name/label heuristics; a birthday select is ignored", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-split-expiry.html" });
    const kinds = kindsById(p.top.document);
    expect(kinds).toMatchObject({ number: "number", m: "expMonth", y: "expYear", sec: "cvc", n2: "number", m2: "expMonth", y2: "expYear", n3: "number", e3: "exp" });
    expect(kinds["birth-month"]).toBeUndefined();
  });

  test("fills selects (value 12 / 2034), two-digit year inputs and an MM/YYYY input", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-split-expiry.html" });
    fillCardFields(p.top.document, CARD);
    expect(el(p.top, "number").value).toBe(CARD.number);
    expect(el<HTMLSelectElement>(p.top, "m").value).toBe("12");
    expect(el<HTMLSelectElement>(p.top, "y").value).toBe("2034");
    expect(el(p.top, "sec").value).toBe("123");
    expect(el(p.top, "m2").value).toBe("12");
    expect(el(p.top, "y2").value).toBe("34");
    expect(el(p.top, "e3").value).toBe("12/2034");
    expect(el<HTMLSelectElement>(p.top, "birth-month").selectedIndex).toBe(0);
  });

  test("single-digit months pick the right option", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-split-expiry.html" });
    fillCardFields(p.top.document, { ...CARD, exp: "03/31" });
    expect(el<HTMLSelectElement>(p.top, "m").value).toBe("3");
    expect(el<HTMLSelectElement>(p.top, "y").value).toBe("2031");
    expect(el(p.top, "y2").value).toBe("31");
  });

  test("a typed card is read back from the selects", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-split-expiry.html" });
    const form = el(p.top, "pay-form");
    el(p.top, "number").value = CARD.number;
    el<HTMLSelectElement>(p.top, "m").value = "12";
    el<HTMLSelectElement>(p.top, "y").value = "2034";
    expect(readTypedCard(p.top.document, form)).toEqual({ number: CARD.number, exp: "12/34", cardholder: "", cvv: "" });
  });
});

describe("Bulgarian and German labels", () => {
  test("Bulgarian: номер на картата, картодържател, месец / година selects, CVV код, тип на картата", async () => {
    const p = await open("https://magazin.example.bg/plashtane", { "https://magazin.example.bg/plashtane": "checkout-bg.html" });
    expect(kindsById(p.top.document)).toEqual({ karta: "number", ime: "name", mesec: "expMonth", godina: "expYear", kod: "cvc", tip: "type" });
    fillCardFields(p.top.document, CARD);
    expect(el(p.top, "karta").value).toBe(CARD.number);
    expect(el(p.top, "ime").value).toBe("Jane Q Doe");
    expect(el<HTMLSelectElement>(p.top, "mesec").value).toBe("12");
    expect(el<HTMLSelectElement>(p.top, "godina").value).toBe("34");
    expect(el(p.top, "kod").value).toBe("123");
    expect(el<HTMLSelectElement>(p.top, "tip").value).toBe("visa");
    expect(el(p.top, "tel").value).toBe("");
  });

  test("German: Kartennummer, Karteninhaber, Gültig bis (MM/JJ), Prüfnummer; the voucher field is left alone", async () => {
    const p = await open("https://shop.example.de/kasse", { "https://shop.example.de/kasse": "checkout-de.html" });
    expect(kindsById(p.top.document)).toEqual({ kn: "number", ki: "name", gb: "exp", pn: "cvc" });
    fillCardFields(p.top.document, CARD);
    expect(el(p.top, "gb").value).toBe("12/34");
    expect(el(p.top, "pn").value).toBe("123");
    expect(el(p.top, "gutschein").value).toBe("");
  });

  test("a page without a card number field yields no card fields", async () => {
    const p = await open("https://bank.example.com/login", { "https://bank.example.com/login": "plain-login.html" });
    expect(cardFieldKinds(p.top.document)).toEqual([]);
    expect(fillCardFields(p.top.document, CARD)).toEqual({ status: "no_form" });
  });
});

describe("frames: payment provider iframes and foreign iframes", () => {
  const ROUTES = {
    [SHOP]: "checkout-psp.html",
    "https://js.stripe.com/v3/elements-inner-card.html": "psp-card-frame.html",
    "https://pay.widget-unknown.example/card": "psp-card-frame.html",
  };

  function probes(p: DomPage): CardFrameProbe[] {
    return p.frames.map((w, frameId) => ({ frameId, ...probeCardFrame(w) }));
  }

  test("payment provider origins are an exact allowlist on https", () => {
    for (const o of ["https://js.stripe.com", "https://assets.braintreegateway.com", "https://checkoutshopper-live.adyen.com", "https://checkoutshopper-test.adyen.com", "https://cdn.checkout.com"]) {
      expect({ o, ok: isPaymentFrameOrigin(o) }).toEqual({ o, ok: true });
    }
    for (const o of ["http://js.stripe.com", "https://js.stripe.com:8443", "https://evil-js.stripe.com.example", "https://stripe.com", "https://pay.widget-unknown.example", "https://adyen.com.evil.example"]) {
      expect({ o, ok: isPaymentFrameOrigin(o) }).toEqual({ o, ok: false });
    }
  });

  test("probe sees the cardholder in the page and the card fields in both iframes", async () => {
    const p = await open(SHOP, ROUTES);
    const pr = probes(p);
    expect(pr.map((f) => [f.origin, f.kinds])).toEqual([
      ["https://shop.example.com", ["name"]],
      ["https://js.stripe.com", ["number", "exp", "cvc"]],
      ["https://pay.widget-unknown.example", ["number", "exp", "cvc"]],
    ]);
    expect(pr[1]!.ancestorOrigins).toEqual(["https://shop.example.com"]);
  });

  test("user-started fill: the page and the Stripe frame are filled, the unknown frame is skipped", async () => {
    const p = await open(SHOP, ROUTES);
    const plan = planCardFill(probes(p), SHOP, { allowPaymentFrames: true });
    expect(plan).toEqual({
      status: "ok",
      topOrigin: "https://shop.example.com",
      targets: [
        { frameId: 0, origin: "https://shop.example.com", kinds: ["name"], paymentFrame: false },
        { frameId: 1, origin: "https://js.stripe.com", kinds: ["number", "exp", "cvc"], paymentFrame: true },
      ],
      skipped: 1,
    });
    if (plan.status !== "ok") throw new Error("unreachable");
    for (const t of plan.targets) {
      const out = guardedCardFill(p.frames[t.frameId]!, { data: CARD, allowedOrigin: t.origin, topOrigin: plan.topOrigin, paymentFrame: t.paymentFrame });
      expect(out.status).toBe("filled");
    }
    const stripe = p.frames[1]!.document;
    expect((stripe.querySelector('[name="cardnumber"]') as HTMLInputElement).value).toBe("4242 4242 4242 4242");
    expect((stripe.querySelector('[name="exp-date"]') as HTMLInputElement).value).toBe("12 / 34");
    expect(el(p.top, "holder").value).toBe("Jane Q Doe");
    const foreign = p.frames[2]!.document;
    expect((foreign.querySelector('[name="cardnumber"]') as HTMLInputElement).value).toBe("");
  });

  test("the unknown cross-origin frame refuses inside the frame too, whatever it is told", async () => {
    const p = await open(SHOP, ROUTES);
    const foreign = p.frames[2]!;
    const top = "https://shop.example.com";
    const asPayment = guardedCardFill(foreign, { data: CARD, allowedOrigin: "https://pay.widget-unknown.example", topOrigin: top, paymentFrame: true });
    const asPage = guardedCardFill(foreign, { data: CARD, allowedOrigin: "https://pay.widget-unknown.example", topOrigin: top, paymentFrame: false });
    const asTop = guardedCardFill(foreign, { data: CARD, allowedOrigin: top, topOrigin: top, paymentFrame: false });
    for (const r of [asPayment, asPage, asTop]) expect(r.status).toBe("origin_mismatch");
    expect((foreign.document.querySelector('[name="cardnumber"]') as HTMLInputElement).value).toBe("");
    expect(cardFrameAccess({ frameId: 2, ...probeCardFrame(foreign) }, top, true)).toBeNull();
  });

  test("without a user start, the Stripe frame is refused too", async () => {
    const p = await open(SHOP, ROUTES);
    const plan = planCardFill(probes(p), SHOP, { allowPaymentFrames: false });
    expect(plan.status).toBe("origin_mismatch");
    expect((plan as { detail?: string }).detail).toContain("payment provider frame");
    const stripe = p.frames[1]!;
    // A Stripe frame embedded by some other page than the checkout is refused in the frame.
    expect(guardedCardFill(stripe, { data: CARD, allowedOrigin: "https://js.stripe.com", topOrigin: "https://other.example.org", paymentFrame: true }).status).toBe("origin_mismatch");
  });

  test("card fields only in an unknown cross-origin frame: origin_mismatch", async () => {
    const p = await open(SHOP, { [SHOP]: "checkout-foreign-only.html", "https://pay.widget-unknown.example/card": "psp-card-frame.html" });
    expect(planCardFill(probes(p), SHOP, { allowPaymentFrames: true })).toEqual({ status: "origin_mismatch", detail: "the card fields are in a frame from another origin" });
  });

  test("plain http pages are refused, localhost http is allowed", () => {
    const top: CardFrameProbe = { frameId: 0, origin: "http://shop.example.com", ancestorOrigins: [], kinds: ["number"] };
    expect(planCardFill([top], "http://shop.example.com/checkout", { allowPaymentFrames: true }).status).toBe("origin_mismatch");
    const local: CardFrameProbe = { frameId: 0, origin: "http://127.0.0.1:8080", ancestorOrigins: [], kinds: ["number"] };
    expect(planCardFill([local], "http://127.0.0.1:8080/checkout", { allowPaymentFrames: true }).status).toBe("ok");
  });

  test("a Stripe frame nested under another site's frame is refused", () => {
    const f: CardFrameProbe = { frameId: 3, origin: "https://js.stripe.com", ancestorOrigins: ["https://ads.example.net", "https://shop.example.com"], kinds: ["number"] };
    expect(cardFrameAccess(f, "https://shop.example.com", true)).toBeNull();
    expect(cardFrameAccess({ ...f, ancestorOrigins: ["https://js.stripe.com", "https://shop.example.com"] }, "https://shop.example.com", true)).toBe("payment");
    expect(cardFrameAccess({ ...f, ancestorOrigins: null }, "https://shop.example.com", true)).toBeNull();
  });
});

describe("tab choice and chip", () => {
  test("an agent card fill goes to a tab on exactly the requested origin", () => {
    const tabs = [
      { id: 1, url: "https://shop.example.com/cart", active: false, lastAccessed: 5 },
      { id: 2, url: "https://pay.shop.example.com/checkout", active: true },
      { id: 3, url: "https://shop.example.com/checkout", active: true },
      { id: 4, url: "http://shop.example.com/checkout", active: false },
    ];
    expect(pickCardTab(tabs, "https://shop.example.com/checkout")).toEqual({ status: "ok", tabId: 3, url: "https://shop.example.com/checkout" });
    expect(pickCardTab(tabs, "https://other.example.com/checkout").status).toBe("no_tab");
    expect(pickCardTab(tabs, "http://shop.example.com/checkout").status).toBe("origin_mismatch");
  });

  test("the chip shows only in frames a fill may reach", () => {
    expect(chipAllowed(0, "https://shop.example.com", "https://shop.example.com/checkout")).toBe(true);
    expect(chipAllowed(1, "https://js.stripe.com", "https://shop.example.com/checkout")).toBe(true);
    expect(chipAllowed(2, "https://pay.widget-unknown.example", "https://shop.example.com/checkout")).toBe(false);
    expect(chipAllowed(0, "http://shop.example.com", "http://shop.example.com/checkout")).toBe(false);
  });
});
