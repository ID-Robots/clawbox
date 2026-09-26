# ClawBox Docs

Public documentation site for ClawBox, built with [Mintlify](https://mintlify.com) —
the same docs engine used by [docs.openclaw.ai](https://docs.openclaw.ai).

Content is authored in MDX. Changes merge to `beta` first for review and validation;
the published stable docs follow the normal ClawBox promotion to `main`.

## Structure

```
docs-site/
├── docs.json              # site config: nav, theme, colors, logo
├── index.mdx              # landing page
├── quickstart.mdx
├── setup/                 # first boot, network, AI provider
├── hardware/              # ClawBox, ClawBox Workstation
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

The public site is **https://docs.clawbox.com**. Documentation changes follow the same
beta-first release flow as the rest of ClawBox: feature branch → pull request to `beta`
→ validation → promotion to `main`. Never push documentation directly to `main`.

## Adding a page

1. Create `section/your-page.mdx` with frontmatter (`title`, `summary`).
2. Add `"section/your-page"` to the right group in `docs.json`.
3. `mint dev` to preview, then push.

## Brand

- Primary documentation color: `#C44F00` (accessible ClawBox orange on white)
- Accent orange: `#F26B21`
- Logo + favicon copied from the device app's `public/` assets.
