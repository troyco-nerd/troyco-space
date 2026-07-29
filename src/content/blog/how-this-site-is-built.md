---
title: "How this site is built"
description: "A quick look at the stack behind troyco.space: Astro, Markdown, and Cloudflare Pages."
pubDate: 2026-07-29
tags: ["meta", "astro"]
---

A few notes on the setup, mostly for future-me:

- **Framework:** [Astro](https://astro.build), outputting a fully static
  site. No server to babysit.
- **Content:** Blog posts and projects are just Markdown files with
  frontmatter, stored in `src/content/blog/` and `src/content/projects/`.
  Astro's content collections pick them up automatically.
- **Styling:** Plain hand-written CSS in `src/styles/global.css` — no build
  step, no framework to fight with.
- **Hosting:** [Cloudflare Pages](https://pages.cloudflare.com/), connected
  directly to the GitHub repo. Every push to `main` triggers a build and
  deploy; other branches get their own preview URL automatically.
- **Domain:** `troyco.space`, registered at Namecheap, DNS managed in
  Cloudflare.

The whole write → commit → push → live loop takes about a minute.
