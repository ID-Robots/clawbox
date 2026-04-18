# ClawBox Integration Guide

_This file is seeded by ClawBox's `gateway-pre-start.sh` into `~/.openclaw/workspace/CLAWBOX.md`. It documents how to work with the ClawBox device so you don't have to guess or rely on defaults from the base OpenClaw install._

---

## Skills

**Where user-installed skills live:** `~/.openclaw/workspace/skills/<skill-id>/`

That is the **only** directory to check when someone asks "do I have skill X installed?" or "what skills are available?". Each skill directory contains `SKILL.md` (the manifest), and optionally `scripts/`, `hooks/`, `assets/`, `references/`.

**Where skills do NOT live:** `/home/clawbox/.npm-global/lib/node_modules/openclaw/skills/` — that's the built-in skills bundled with the OpenClaw npm package, not what the ClawBox App Store writes to. **Do not check there when asked about user-installed skills** — it will falsely report the skill as missing.

### Installing and uninstalling skills

When the user asks you to install a skill, **use the ClawBox MCP server's `app_install` tool** (it goes through the ClawBox App Store, which registers the skill in the UI and triggers a gateway reload so it's actually usable). Do not copy files into the skills directory manually — the user wouldn't be able to see or uninstall it from the UI.

Likewise, use `app_uninstall` to remove a skill — don't `rm -rf` the skill directory.

The App Store is also available as a desktop app (`ui_open_app("store")`) if the user wants to browse/install interactively.

---

## Browser (real Chromium on the device)

ClawBox ships a dedicated desktop Chromium that you can control via the `browser_*` tools from the `clawbox` MCP server:

| Tool | Purpose |
|---|---|
| `browser_launch` / `browser_open` | Start a browsing session (opens the desktop Chromium if needed) |
| `browser_navigate` | Go to a URL |
| `browser_screenshot` | See the current page (returns a PNG) |
| `browser_click` | Click at x,y coordinates visible in the screenshot |
| `browser_type` | Type text into the focused field |
| `browser_keypress` | Send special keys (Enter, Tab, Escape, etc.) |
| `browser_scroll` | Scroll the page |
| `browser_close` | End the browsing session (Chromium stays running) |

**Standard workflow:** `browser_launch` → `browser_screenshot` → `browser_click` / `browser_type` → `browser_screenshot` → … repeat until the task is done.

### Important

**Do NOT use `ui_open_app("browser")` for actual web browsing.** That opens ClawBox's Browser *Setup* panel, which configures the integration — it does not start a browsing session.

The Chromium window is visible on the ClawBox desktop (accessible via the VNC viewer), so the user can see what you're doing. That's a feature, not a problem — if you're unsure about a click, the screenshot is authoritative and the user can spot the bug visually.

---

## Apps and UI

| Tool | Purpose |
|---|---|
| `ui_open_app` | Open a built-in ClawBox desktop app (chat, files, settings, store, vnc, terminal, browser-setup) |
| `ui_list_apps` | Enumerate installed desktop apps |
| `ui_notify` | Show a toast notification on the ClawBox desktop |
| `app_search` | Search the ClawBox App Store |
| `app_install` | Install a skill or webapp from the Store (see Skills section above) |
| `app_uninstall` | Uninstall a skill or webapp |
| `webapp_create` / `webapp_update` | Build and register a custom webapp on the desktop |

---

## File-system and network

- The ClawBox project dir is `/home/clawbox/clawbox/`. User data is in `data/`. Skills are in the OpenClaw workspace (see Skills above).
- The gateway's own config is `~/.openclaw/openclaw.json`. Don't edit it directly — use the `openclaw config set` CLI or let ClawBox's setup routes manage it.
- The device exposes itself at `http://clawbox.local` / `http://<LAN-IP>` / `http://10.42.0.1` (AP mode).
