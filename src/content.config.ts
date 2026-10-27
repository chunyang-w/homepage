import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// One markdown file per paper in src/content/publications/. Fields map 1:1 to <Paper /> props.
const publications = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/publications' }),
  schema: z.object({
    title: z.string(),
    url: z.string().url(), // intro page the title and figure link to
    authors: z.array(z.string()),
    venue: z.string(), // short form: "NeurIPS 2024", "arXiv 2026"
    venueUrl: z.string().url().optional(),
    date: z.coerce.date(), // sorts newest first
    image: z.string().optional(),
    links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
    highlight: z.string().optional(),
  }),
});

// One markdown file per news item in src/content/news/. The body is the item text.
const news = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/news' }),
  schema: z.object({ date: z.coerce.date() }),
});

export const collections = { publications, news };
