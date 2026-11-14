// Form detection and filling against HTML fixtures in a DOM test environment.
import { afterEach, describe, expect, test } from "bun:test";
import { fillLogin, findLoginForm, guardedFill, probeFrame, readTypedCredentials } from "../src/extension/forms";
import { chooseFillFrame, pickTab, type FrameProbe } from "../src/extension/frames";
import { openPage, type DomPage } from "./helpers/dom";

const LOGIN = "ops@example.com";
const PASSWORD = "Fx7#kq2-Test!pw";

let page: DomPage | null = null;
afterEach(async () => {
  await page?.close();
  page = null;
});

async function open(url: string, routes: Record<string, string>): Promise<DomPage> {
  page = await openPage(url, routes);
  return page;
}

function input(win: Window, id: string): HTMLInputElement {
  return win.document.getElementById(id) as HTMLInputElement;
}

function probes(p: DomPage): FrameProbe[] {
  return p.frames.map((w, frameId) => ({ frameId, ...probeFrame(w) }));
}

describe("plain login form", () => {
  test("finds password + nearest username, skips search box, hidden decoy and hidden inputs", async () => {
    const p = await open("https://bank.example.com/login", { "https://bank.example.com/login": "plain-login.html" });
    const found = findLoginForm(p.top.document)!;
    expect(found.step).toBe("full");
    expect(found.username?.id).toBe("email");
    expect(found.passwords.map((x) => x.id)).toEqual(["pw"]);
    expect(found.submit?.id).toBe("submit");
  });

  test("fills with input/change/blur events and submits", async () => {
    const p = await open("https://bank.example.com/login", { "https://bank.example.com/login": "plain-login.html" });
    const doc = p.top.document;
    const events: string[] = [];
    for (const type of ["input", "change", "blur"]) {
      input(p.top, "pw").addEventListener(type, () => events.push(type));
    }
    let submitted: { email: string; password: string } | null = null;
    doc.getElementById("login")!.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = { email: input(p.top, "email").value, password: input(p.top, "pw").value };
    });
    const out = await fillLogin(doc, { login: LOGIN, password: PASSWORD, submit: true });
    expect(out).toEqual({ status: "filled", step: "full", submitted: true });
    expect(events).toEqual(["input", "change", "blur"]);
    expect(submitted!).toEqual({ email: LOGIN, password: PASSWORD });
    expect((doc.querySelector('input[name="decoy"]') as HTMLInputElement).value).toBe("");
    expect((doc.querySelector('input[name="q"]') as HTMLInputElement).value).toBe("");
  });

  test("captures what the user typed for the save prompt", async () => {
    const p = await open("https://bank.example.com/login", { "https://bank.example.com/login": "plain-login.html" });
    input(p.top, "email").value = "typed@example.com";
    input(p.top, "pw").value = "typed-pass";
    expect(readTypedCredentials(p.top.document.getElementById("login")!)).toEqual({ login: "typed@example.com", password: "typed-pass" });
  });

  test("no login form on a content page", async () => {
    const p = await open("https://bank.example.com/invoices", { "https://bank.example.com/invoices": "no-form.html" });
    expect(findLoginForm(p.top.document)).toBeNull();
    expect(await fillLogin(p.top.document, { login: LOGIN, password: PASSWORD })).toEqual({ status: "no_form" });
  });

  test("form-less SPA: username by hint, role=button submit", async () => {
    const p = await open("https://app.example.com/", { "https://app.example.com/": "formless-spa.html" });
    let clicked = false;
    p.top.document.getElementById("go")!.addEventListener("click", () => (clicked = true));
    const found = findLoginForm(p.top.document)!;
    expect(found.username?.id).toBe("login");
    const out = await fillLogin(p.top.document, { login: LOGIN, password: PASSWORD, submit: true });
    expect(out.status).toBe("filled");
    expect(clicked).toBe(true);
    expect(input(p.top, "first").value).toBe("");
    expect(input(p.top, "login").value).toBe(LOGIN);
  });

  test("sign-up form gets the password in both new-password fields", async () => {
    const p = await open("https://example.com/join", { "https://example.com/join": "signup.html" });
    await fillLogin(p.top.document, { login: LOGIN, password: PASSWORD });
    expect(input(p.top, "pw1").value).toBe(PASSWORD);
    expect(input(p.top, "pw2").value).toBe(PASSWORD);
  });
});

describe("two-step login", () => {
  test("username page first: fills only the username", async () => {
    const p = await open("https://login.example.com/", { "https://login.example.com/": "two-step-username.html" });
    const found = findLoginForm(p.top.document)!;
    expect(found.step).toBe("username");
    expect(found.submit?.id).toBe("next");
    let sent: string | null = null;
    p.top.document.getElementById("step1")!.addEventListener("submit", (e) => {
      e.preventDefault();
      sent = input(p.top, "identifier").value;
    });
    const out = await fillLogin(p.top.document, { login: LOGIN, password: PASSWORD, submit: true });
    expect(out).toEqual({ status: "filled", step: "username", submitted: true });
    expect(sent!).toBe(LOGIN);
    expect(p.top.document.querySelectorAll('input[type="password"]').length).toBe(0);
  });

  test("password page next: fills the password, leaves the hidden username alone", async () => {
    const p = await open("https://login.example.com/challenge", { "https://login.example.com/challenge": "two-step-password.html" });
    const found = findLoginForm(p.top.document)!;
    expect(found.step).toBe("password");
    expect(found.username).toBeNull();
    await fillLogin(p.top.document, { login: LOGIN, password: PASSWORD });
    expect(input(p.top, "pw").value).toBe(PASSWORD);
  });

  test("a newsletter email box is not a username step", async () => {
    const p = await open("https://example.com/pricing", { "https://example.com/pricing": "newsletter.html" });
    expect(findLoginForm(p.top.document)).toBeNull();
    expect(await fillLogin(p.top.document, { login: LOGIN, password: PASSWORD, submit: true })).toEqual({ status: "no_form" });
    expect(input(p.top, "nl-email").value).toBe("");
  });

  test("next to a newsletter box, the real username step is chosen", async () => {
    const p = await open("https://login.example.com/", { "https://login.example.com/": "two-step-with-newsletter.html" });
    const found = findLoginForm(p.top.document)!;
    expect(found.step).toBe("username");
    expect(found.username?.id).toBe("identifier");
    expect(found.submit?.id).toBe("next");
  });

  test("username step is reported for the save prompt without a password", async () => {
    const p = await open("https://login.example.com/", { "https://login.example.com/": "two-step-username.html" });
    input(p.top, "identifier").value = "typed@example.com";
    expect(readTypedCredentials(p.top.document)).toEqual({ login: "typed@example.com", password: "" });
  });
});

describe("frames", () => {
  const routes = {
    "https://bank.example.com/portal": "iframe-host.html",
    "https://bank.example.com/embedded-login": "embedded-login.html",
    "https://widget.example.net/login": "cross-origin-login.html",
  };

  test("a same-origin iframe matching the entry is filled", async () => {
    const p = await open("https://bank.example.com/portal", routes);
    expect(p.frames).toHaveLength(3);
    const choice = chooseFillFrame(probes(p), "https://bank.example.com/portal", "https://bank.example.com");
    expect(choice).toEqual({ status: "ok", frameId: 1, origin: "https://bank.example.com" });
    const out = await guardedFill(p.frames[1]!, { login: LOGIN, password: PASSWORD, allowedOrigin: "https://bank.example.com" });
    expect(out.status).toBe("filled");
    expect(input(p.frames[1]!, "user").value).toBe(LOGIN);
    expect(input(p.frames[1]!, "pw").value).toBe(PASSWORD);
    // The cross-origin frame next to it stays untouched.
    expect(input(p.frames[2]!, "pw").value).toBe("");
  });

  test("a cross-origin iframe is refused", async () => {
    const p = await open("https://bank.example.com/portal", {
      "https://bank.example.com/portal": "iframe-host-foreign-only.html",
      "https://widget.example.net/login": "cross-origin-login.html",
    });
    const frames = probes(p);
    expect(frames[1]).toMatchObject({ origin: "https://widget.example.net", ancestorsSameOrigin: false, hasForm: true });
    expect(chooseFillFrame(frames, "https://bank.example.com/portal", "https://bank.example.com")).toMatchObject({
      status: "origin_mismatch",
    });
    // Even if asked directly, the frame refuses an origin other than its own...
    const direct = await guardedFill(p.frames[1]!, { login: LOGIN, password: PASSWORD, allowedOrigin: "https://bank.example.com" });
    expect(direct.status).toBe("origin_mismatch");
    // ...and refuses its own origin too, because it is embedded by another origin.
    const own = await guardedFill(p.frames[1]!, { login: LOGIN, password: PASSWORD, allowedOrigin: "https://widget.example.net" });
    expect(own.status).toBe("origin_mismatch");
    expect(input(p.frames[1]!, "pw").value).toBe("");
  });

  test("the top frame refuses an entry for another site", async () => {
    const p = await open("https://bank.example.com/login", { "https://bank.example.com/login": "plain-login.html" });
    const out = await guardedFill(p.top, { login: LOGIN, password: PASSWORD, allowedOrigin: "https://evil.example.org" });
    expect(out.status).toBe("origin_mismatch");
    expect(input(p.top, "pw").value).toBe("");
    expect(chooseFillFrame(probes(p), "https://bank.example.com/login", "https://evil.example.org")).toMatchObject({ status: "origin_mismatch" });
  });

  test("plain http pages are refused", async () => {
    const p = await open("http://bank.example.com/login", { "http://bank.example.com/login": "plain-login.html" });
    expect(chooseFillFrame(probes(p), "http://bank.example.com/login", "https://bank.example.com")).toMatchObject({ status: "origin_mismatch" });
    const out = await guardedFill(p.top, { login: LOGIN, password: PASSWORD, allowedOrigin: "http://bank.example.com" });
    expect(out.status).toBe("origin_mismatch");
  });

  test("localhost over http is allowed", async () => {
    const p = await open("http://localhost:3000/login", { "http://localhost:3000/login": "plain-login.html" });
    const choice = chooseFillFrame(probes(p), "http://localhost:3000/login", "http://localhost:3000");
    expect(choice).toEqual({ status: "ok", frameId: 0, origin: "http://localhost:3000" });
    expect((await guardedFill(p.top, { login: LOGIN, password: PASSWORD, allowedOrigin: "http://localhost:3000" })).status).toBe("filled");
  });
});

describe("tab choice", () => {
  test("prefers the requested origin, then the active tab", () => {
    const tabs = [
      { id: 1, url: "https://example.com/home", active: true },
      { id: 2, url: "https://billing.example.com/login", active: false },
      { id: 3, url: "https://other.test/", active: false },
    ];
    expect(pickTab(tabs, "https://example.com", "https://billing.example.com/login")).toEqual({ status: "ok", tabId: 2, url: "https://billing.example.com/login" });
    expect(pickTab(tabs, "https://example.com", "https://example.com/")).toEqual({ status: "ok", tabId: 1, url: "https://example.com/home" });
  });
  test("no_tab when nothing matches, origin_mismatch for an http tab", () => {
    expect(pickTab([{ id: 1, url: "https://other.test/" }], "https://example.com", "https://example.com")).toEqual({ status: "no_tab" });
    expect(pickTab([{ id: 1, url: "http://example.com/login" }], "https://example.com", "https://example.com").status).toBe("origin_mismatch");
  });
});
