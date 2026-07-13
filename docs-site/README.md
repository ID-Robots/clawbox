# ClawBox Docs

Public documentation site for ClawBox, built with [Mintlify](https://mintlify.com) —
the same docs engine used by [docs.openclaw.ai](https://docs.openclaw.ai).

Content is authored in MDX. Edit a `.mdx` file, push, and the site rebuilds.

## Structure

```
docs-site/
├── docs.json              # site config: nav, theme, colors, logo
├── index.mdx              # landing page
├── quickstart.mdx
├── setup/                 # first boot, network, AI provider
├── hardware/              # ClawBox Connect, ClawBox Workstation
├── guides/                # messaging channels, subscriptions
├── support/               # troubleshooting, FAQ
├── logo/                  # light.png / dark.png
├── images/
└── favicon.png
```

Navigation is controlled by `docs.json` → `navigation.tabs[].groups[].pages`.
Each page is referenced by its path without the `.mdx` extension.

## Run locally

```bash
# one-time: install the Mintlify CLI
npm i -g mint

# from the docs-site/ directory
cd docs-site
mint dev
```

Opens a live-reloading preview at `http://localhost:3000`.

To validate links before publishing:

```bash
mint broken-links
```

## Publishing

The intended public URL is **docs.clawbox.com**.

Two ways to publish:

1. **Mintlify hosting (matches docs.openclaw.ai).** Install the Mintlify GitHub App on
   the `ID-Robots/clawbox` repo, point it at this `docs-site/` directory, and set the
   custom domain to `docs.clawbox.com` in the Mintlify dashboard. Pushes to the docs
   branch auto-deploy. (Custom domain / removing Mintlify branding may require a paid
   plan — confirm current Mintlify pricing.)

2. **Self-host the static build.** Run `mint build` and deploy the output to Vercel (the
   same place clawbox.com lives) behind a `docs.clawbox.com` subdomain. No SaaS fee.

> Decision pending: which hosting path. The content/config is identical either way.

## Adding a page

1. Create `section/your-page.mdx` with frontmatter (`title`, `summary`).
2. Add `"section/your-page"` to the right group in `docs.json`.
3. `mint dev` to preview, then push.

## Brand

- Primary color: `#F26B21` (ClawBox orange)
- Logo + favicon copied from the device app's `public/` assets.
