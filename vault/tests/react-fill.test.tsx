// A real React 19 controlled form in the DOM test environment: the fill must
// reach React's state (onChange), not only the DOM value. The negative control
// shows that a plain `input.value = …` does not, so the test really exercises
// React's value tracking.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { fillCardFields } from "../src/extension/cardforms";
import { fillInput, fillLogin } from "../src/extension/forms";
import { openPage, type DomPage } from "./helpers/dom";

const LOGIN = "ops@example.com";
const PASSWORD = "Rk9$react-Test-pw";

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Node", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
const saved: Record<string, unknown> = {};
let page: DomPage;
// react-dom decides at import time whether it runs in a DOM, so it is loaded
// only after the DOM globals are in place.
let createRoot: typeof import("react-dom/client").createRoot;

beforeAll(async () => {
  page = await openPage("https://app.example.com/login", { "https://app.example.com/login": "no-form.html" });
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = g[k];
  const w = page.top as unknown as Record<string, unknown>;
  for (const k of GLOBALS) if (k !== "IS_REACT_ACT_ENVIRONMENT") g[k] = k === "window" ? w : w[k];
  g.IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
});

afterAll(async () => {
  const g = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
  await page.close();
});

interface Submitted {
  email: string;
  password: string;
}

function LoginForm({ onSubmit }: { onSubmit: (s: Submitted) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      id="react-login"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ email, password });
      }}
    >
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Sign in</button>
    </form>
  );
}

async function mount(onSubmit: (s: Submitted) => void): Promise<{ root: Root; container: HTMLElement }> {
  const doc = page.top.document;
  doc.body.replaceChildren();
  const container = doc.createElement("div");
  doc.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<LoginForm onSubmit={onSubmit} />));
  return { root, container };
}

describe("React-controlled inputs", () => {
  test("native setter + input/change/blur reaches React state and the submit handler", async () => {
    const submissions: Submitted[] = [];
    const { root } = await mount((s) => submissions.push(s));
    await act(async () => {
      const out = await fillLogin(page.top.document, { login: LOGIN, password: PASSWORD, submit: true });
      expect(out.status).toBe("filled");
    });
    expect(submissions).toEqual([{ email: LOGIN, password: PASSWORD }]);
    // After React re-rendered from state, the inputs still show the values.
    expect((page.top.document.getElementById("email") as HTMLInputElement).value).toBe(LOGIN);
    expect((page.top.document.getElementById("password") as HTMLInputElement).value).toBe(PASSWORD);
    await act(async () => root.unmount());
  });

  test("negative control: assigning .value directly is lost by React", async () => {
    const submissions: Submitted[] = [];
    const { root } = await mount((s) => submissions.push(s));
    const doc = page.top.document;
    const win = page.top as Window & typeof globalThis;
    await act(async () => {
      const email = doc.getElementById("email") as HTMLInputElement;
      email.value = LOGIN; // goes through React's instance tracker
      email.dispatchEvent(new win.Event("input", { bubbles: true }));
      (doc.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });
    expect(submissions).toEqual([{ email: "", password: "" }]);
    // fillInput on the same field reaches React, even though the DOM already
    // shows that value from the plain assignment above.
    await act(async () => {
      fillInput(doc.getElementById("email") as HTMLInputElement, LOGIN);
      (doc.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });
    expect(submissions[1]).toEqual({ email: LOGIN, password: "" });
    await act(async () => root.unmount());
  });
});

// ---- a React checkout: controlled inputs, a masked number, split expiry selects ----

interface CardSubmitted {
  name: string;
  number: string;
  month: string;
  year: string;
  cvc: string;
}

function CheckoutForm({ onSubmit }: { onSubmit: (s: CardSubmitted) => void }) {
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [cvc, setCvc] = useState("");
  // The usual React mask: digits only, regrouped in fours, at most 16 digits.
  const mask = (v: string) => v.replace(/\D/g, "").slice(0, 16).replace(/(\d{4})(?=\d)/g, "$1 ");
  return (
    <form
      id="react-checkout"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, number, month, year, cvc });
      }}
    >
      <label htmlFor="cc-name">Name on card</label>
      <input id="cc-name" autoComplete="cc-name" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="cc-number">Card number</label>
      <input id="cc-number" autoComplete="cc-number" inputMode="numeric" value={number} onChange={(e) => setNumber(mask(e.target.value))} />
      <select id="cc-month" autoComplete="cc-exp-month" value={month} onChange={(e) => setMonth(e.target.value)}>
        <option value="">MM</option>
        {Array.from({ length: 12 }, (_, i) => (
          <option key={i} value={String(i + 1).padStart(2, "0")}>
            {String(i + 1).padStart(2, "0")}
          </option>
        ))}
      </select>
      <select id="cc-year" autoComplete="cc-exp-year" value={year} onChange={(e) => setYear(e.target.value)}>
        <option value="">YY</option>
        {Array.from({ length: 15 }, (_, i) => (
          <option key={i} value={String(26 + i)}>
            {String(2026 + i)}
          </option>
        ))}
      </select>
      <input id="cc-csc" autoComplete="cc-csc" value={cvc} onChange={(e) => setCvc(e.target.value.replace(/\D/g, ""))} />
      <button type="submit">Pay</button>
    </form>
  );
}

describe("React-controlled checkout", () => {
  test("card fill reaches React state through the mask and the selects", async () => {
    const doc = page.top.document;
    doc.body.replaceChildren();
    const container = doc.createElement("div");
    doc.body.append(container);
    const root = createRoot(container);
    const submissions: CardSubmitted[] = [];
    await act(async () => root.render(<CheckoutForm onSubmit={(s) => submissions.push(s)} />));
    await act(async () => {
      const out = fillCardFields(doc, { number: "4242424242424242", cardholder: "Jane Q Doe", exp: "12/34", cvv: "123", brand: "visa" });
      expect(new Set(out.filled)).toEqual(new Set(["number", "name", "expMonth", "expYear", "cvc"]));
    });
    await act(async () => (doc.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    expect(submissions).toEqual([{ name: "Jane Q Doe", number: "4242 4242 4242 4242", month: "12", year: "34", cvc: "123" }]);
    expect((doc.getElementById("cc-number") as HTMLInputElement).value).toBe("4242 4242 4242 4242");
    await act(async () => root.unmount());
  });
});
