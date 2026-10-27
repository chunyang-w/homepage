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
| Name, position, tagline, email, profile links | `src/data/site.ts` |
| About and research text | `src/content/bio.md`, `src/content/research.md` |
| News items (one file each) | `src/content/news/YYYY-MM-slug.md` |
| Publications (one file each) | `src/content/publications/YYYY-slug.md` |
| Avatar, figures, CV | `public/img/`, `public/files/` |
| Header and core-sample strip (invasion simulation, click to replay) | `src/components/Header.astro`, `src/components/CoreSample.astro` |
| Design tokens (colours, fonts) and layout | `src/styles/global.css` |

### Add a publication

Each paper renders through `src/components/Paper.astro` as three lines: title, authors (your name in bold), then the venue followed by links. Create `src/content/publications/2026-spongecore.md`:

```md
---
title: "SpongeCore: A Porous Media Benchmark for ..."
url: https://arxiv.org/abs/xxxx.xxxxx   # intro page; title, figure and venue link here
authors: [Chunyang Wang, Coauthor Name*]   # "*" marks equal contribution
venue: NeurIPS 2026                      # short, well-known name + year
venueUrl: https://...                    # optional, defaults to url
date: 2026-05-15                         # sorts newest first
image: /img/pub-spongecore.webp
highlight: Spotlight Presentation        # optional
links:
  - { label: Paper, url: "https://arxiv.org/pdf/xxxx.xxxxx" }
  - { label: Code, url: "https://github.com/..." }
  - { label: Hugging Face, url: "https://huggingface.co/..." }
---
```

Fields are validated by `src/content.config.ts`. The component takes plain props, so other pages can use it directly with `<Paper title="..." url="..." authors={[...]} venue="..." />`. Keep figures around 800px wide in WebP: `cwebp -q 82 -resize 800 0 fig.png -o public/img/pub-name.webp`.

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
