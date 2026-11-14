// The in-page "Save to ClawBox Vault?" / "Update password?" bar. Rendered in a
// closed shadow root so page CSS cannot restyle it and page scripts cannot
// reach into it. It never holds the password: the background worker keeps the
// captured login and only receives the chosen entry name.

export interface SaveBarOptions {
  kind: "new" | "update";
  name: string;
  login: string;
  host: string;
  onSave: (name: string) => Promise<{ ok: boolean; error?: string }>;
  onDismiss: () => void;
}

const CSS = `
:host { all: initial; }
.bar {
  position: fixed; top: 14px; right: 14px; z-index: 2147483647;
  width: min(380px, calc(100vw - 28px)); box-sizing: border-box;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e7ecf3; background: #141821; border: 1px solid #2a3140; border-radius: 14px;
  box-shadow: 0 18px 50px rgba(0,0,0,.45); padding: 14px 14px 12px;
}
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.logo { width: 26px; height: 26px; border-radius: 8px; flex: none;
  background: linear-gradient(135deg, #ff8a3d, #ff4f5e); display: grid; place-items: center;
  color: #141821; font-weight: 800; font-size: 14px; }
.title { font-weight: 650; font-size: 14px; flex: 1; }
.x { all: unset; cursor: pointer; color: #8b95a7; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
.x:hover { background: #222938; color: #e7ecf3; }
.sub { color: #9aa4b5; margin: 0 0 10px; overflow-wrap: anywhere; }
label { display: block; color: #9aa4b5; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
input { all: unset; box-sizing: border-box; width: 100%; background: #0d1017; border: 1px solid #2a3140;
  border-radius: 9px; padding: 8px 10px; color: #e7ecf3; font: inherit; }
input:focus { border-color: #ff8a3d; }
.row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
button.b { all: unset; cursor: pointer; padding: 7px 14px; border-radius: 9px; font-weight: 600; }
.primary { background: #ff8a3d; color: #141821; }
.primary:hover { background: #ff9d5c; }
.ghost { color: #c5cddb; }
.ghost:hover { background: #222938; }
.err { color: #ff7b86; margin-top: 8px; display: none; }
`;

export function showSaveBar(doc: Document, opts: SaveBarOptions): () => void {
  const existing = doc.querySelector("clawbox-vault-bar");
  existing?.remove();
  const host = doc.createElement("clawbox-vault-bar");
  const root = host.attachShadow({ mode: "closed" });
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  try {
    const sheet = new (win?.CSSStyleSheet ?? CSSStyleSheet)();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = doc.createElement("style");
    style.textContent = CSS;
    root.append(style);
  }

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  const bar = el("div", "bar");
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", "ClawBox Vault");
  const head = el("div", "head");
  head.append(el("div", "logo", "V"), el("div", "title", opts.kind === "new" ? "Save to ClawBox Vault?" : "Update password?"));
  const close = el("button", "x", "×");
  close.setAttribute("aria-label", "Close");
  head.append(close);
  bar.append(head);

  const who = opts.login ? `${opts.login} on ${opts.host}` : opts.host;
  bar.append(el("p", "sub", opts.kind === "new" ? `Remember the login ${who}.` : `Store the new password for ${who} in ${opts.name}.`));

  let nameInput: HTMLInputElement | null = null;
  if (opts.kind === "new") {
    const label = el("label", undefined, "Entry name");
    nameInput = el("input");
    nameInput.value = opts.name;
    nameInput.spellcheck = false;
    nameInput.setAttribute("autocomplete", "off");
    // Keep page-level key handlers (shortcuts, form logic) out of the bar.
    nameInput.addEventListener("keydown", (e) => e.stopPropagation());
    bar.append(label, nameInput);
  }

  const err = el("div", "err");
  const row = el("div", "row");
  const later = el("button", "b ghost", "Not now");
  const save = el("button", "b primary", opts.kind === "new" ? "Save" : "Update");
  row.append(later, save);
  bar.append(err, row);
  root.append(bar);
  (doc.body ?? doc.documentElement).append(host);

  const remove = () => host.remove();
  const dismiss = () => {
    remove();
    opts.onDismiss();
  };
  close.addEventListener("click", dismiss);
  later.addEventListener("click", dismiss);
  save.addEventListener("click", async () => {
    save.textContent = "Saving…";
    const result = await opts.onSave(nameInput ? nameInput.value.trim() : opts.name);
    if (result.ok) {
      save.textContent = "Saved";
      setTimeout(remove, 900);
    } else {
      save.textContent = opts.kind === "new" ? "Save" : "Update";
      err.textContent = result.error ?? "Could not save.";
      err.style.display = "block";
    }
  });
  return remove;
}
