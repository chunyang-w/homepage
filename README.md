# homepage

Personal academic homepage. Astro static site, content in Markdown, deployed on Cloudflare Pages.

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
image: /img/spongecore.png
links:
  pdf: https://arxiv.org/abs/...
  code: https://github.com/...
  page: https://...
notes: Spotlight
---
Optional one-line note rendered under the entry.
```

Fields are validated by the schema in `src/content.config.ts`. Entries sort by year, newest first.

### Add a news item

Create `src/content/news/2026-05-neurips.md` with a `date:` in the front matter and the text as the body.

## Deploy (Cloudflare Pages)

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Framework preset **Astro**, build command `npm run build`, output directory `dist`.
4. Add your custom domain under the project's Custom domains tab, then update `site` in `astro.config.mjs` to match.

Every push to `main` deploys; other branches get preview URLs.
