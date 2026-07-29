import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Static output, deployed via Cloudflare Pages (connect the repo in the
// Cloudflare dashboard — no build config needed there beyond the defaults
// Cloudflare Pages infers for Astro).
export default defineConfig({
  site: 'https://troyco.space',
  output: 'static',
  integrations: [sitemap()],
});
