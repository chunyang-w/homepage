import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// One markdown file per publication in src/content/publications/.
// The body (optional) is rendered as a note under the entry.
const publications = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/publications' }),
  schema: z.object({
    title: z.string(),
    authors: z.string(), // markdown; wrap yourself in ** to bold
    venue: z.string(),
    year: z.number(),
    date: z.coerce.date().optional(), // sorts entries newest first
    image: z.string().optional(),
    links: z
      .object({
        pdf: z.string().optional(),
        link: z.string().optional(),
        code: z.string().optional(),
        page: z.string().optional(),
        bibtex: z.string().optional(),
      })
      .default({}),
    notes: z.string().optional(), // e.g. "Oral", "Spotlight"
  }),
});

// One markdown file per news item in src/content/news/. The body is the item text.
const news = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/news' }),
  schema: z.object({ date: z.coerce.date() }),
});

export const collections = { publications, news };
