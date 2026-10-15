# troyco-space
my site that's out there for fun

## Adding images to posts

In the admin editor (`/admin`), under the **Body** box:

- click **Add image**, or drag & drop an image onto the page, or paste a
  screenshot / copied image into the Body box
- big photos are shrunk in your browser first (max 1600px wide, converted to
  WebP), then saved to `public/images/posts/` on `main`
- the Markdown (`![description](/images/posts/name.webp)`) is inserted into the
  post for you at the cursor. Use the **alt text** box under each image to
  describe it for screen readers; it updates the post as you type
- PNG, JPEG, WebP and GIF are supported (GIFs are uploaded as-is so they stay
  animated). 8 MB max per image

Notes:

- Each image is committed right away, so each one triggers its own site
  rebuild. Images you add but never use stay in the repo; delete them from
  `public/images/posts/` if you like.
- Writing a post by hand instead? Put the image in `public/images/posts/` and
  use `![description](/images/posts/your-image.webp)` in the Markdown.

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
