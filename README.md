# troyco-space
my site that's out there for fun

## Branding

The look is built around the logo: pure black, glowing gold, silver and
icy-blue edge light, with angular chamfered shapes.

- **Colors / fonts / shapes** — all in `src/styles/global.css` (palette is the
  `:root` block at the top). Headings use Michroma, body text uses Exo 2.
- **Site name + tagline text** — `src/consts.ts`.
- **Logo files** (in `public/`):
  - `logo.webp` — full logo with tagline, shown on the home page
  - `logo-lockup.webp` — wordmark + emblem, shown in the header
  - `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` — browser/phone icons
  - `og-default.png` — 1200×630 card shown when a link is shared
- The password-protected admin panel (`worker/index.js`) has its own copy of
  the theme in `PAGE_STYLE`, so change colors there too if you re-theme.
