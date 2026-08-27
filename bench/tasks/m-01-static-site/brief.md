Build a static marketing site for **Tidepool Analytics**, a (fictional) fleet
telemetry product, in this folder. No build step, no frameworks, no network
access from the pages — everything ships in these files and nothing else:

```
index.html
features.html
pricing.html
faq.html
contact.html
css/style.css
js/main.js
js/data.js
```

Requirements:

1. Every page carries the same top navigation linking to all five pages, and
   marks the current page with `aria-current="page"`.
2. Every page declares a `<meta name="viewport">` and links only local assets.
   No CDN scripts, no web fonts, no external images — nothing that makes a
   network request off the box.
3. `js/data.js` defines a `PLANS` array with exactly three plans —
   Starter at $9/mo, Team at $29/mo, Fleet at $99/mo, each with a feature
   list — and `js/main.js` renders the pricing table on `pricing.html` from
   it. The prices must live only in `js/data.js`, not in the HTML.
4. `faq.html` answers at least six questions, each collapsible, using native
   `<details>`/`<summary>` (no framework).
5. `contact.html` has a form (name, email, message) validated client-side in
   `js/main.js`: require all fields and a plausible email before "sending"
   (on success just show a confirmation message — there is no backend).
6. Real copy throughout — no lorem ipsum, no TODO placeholders.
