# homepage

Personal academic homepage. Astro static site, content in Markdown, deployed on Cloudflare Workers.

## Develop

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # outputs dist/
```

## Where things live

| What | Where |
|---|---|
| Name, position, email, sidebar links | `src/data/site.ts` |
| Bio and research interests | `src/content/bio.md` |
| News items (one file each) | `src/content/news/YYYY-MM-slug.md` |
| Publications (one file each) | `src/content/publications/YYYY-slug.md` |
| Avatar, figures, CV | `public/img/`, `public/files/` |
| Page layout and styles | `src/layouts/Base.astro`, `src/styles/global.css` |

### Add a publication

Create `src/content/publications/2026-spongecore.md`:

```md
---
title: "SpongeCore: A Porous Media Benchmark for ..."
authors: "**Chunyang Wang**, Coauthor Name"
venue: "NeurIPS Datasets and Benchmarks Track"
year: 2026
date: 2026-05-15        # optional, orders papers within a year
image: /img/spongecore.webp
links:
  pdf: https://arxiv.org/abs/...
  code: https://github.com/...
  page: https://...
notes: Spotlight
---
Optional one-line note rendered under the entry.
```

Fields are validated by the schema in `src/content.config.ts`. Entries sort by date (or year if no date), newest first. Keep figures around 800px wide in WebP: `cwebp -q 82 -resize 800 0 fig.png -o public/img/pub-name.webp`.

### Add a news item

Create `src/content/news/2026-05-neurips.md` with a `date:` in the front matter and the text as the body.

## Deploy (Cloudflare Workers)

The site is fully static. `wrangler.jsonc` tells Workers to serve `dist/`, and `.node-version` pins Node 22 for the build.

1. Cloudflare dashboard → Workers & Pages → Create → Import a repository → `chunyang-w/homepage`.
2. Build command `npm run build`, deploy command `npx wrangler deploy`, production branch `main`.
3. Add your custom domain under the Worker's Settings → Domains & Routes, then update `site` in `astro.config.mjs` to match.

Every push to `main` deploys. Other branches get preview URLs.

Check a deploy locally without uploading:

```bash
npm run build && npx wrangler deploy --dry-run
```
