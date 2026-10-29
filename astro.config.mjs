// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://home.chunyang-wang.workers.dev',
  integrations: [sitemap()],
});
