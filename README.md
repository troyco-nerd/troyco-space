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

## Featured image (link previews)

When a post or project is shared in a text message or on social media, the
preview shows its title, description and a picture.

- In the editor, under **Description**, click **Choose featured image**, or
  click **Use as featured** next to an image you already added to the post. It's
  cropped to 1200×630 (the shape previews use) and saved as a small JPEG. The
  preview in the editor shows exactly what will be shared.
- The featured image is also shown across the top of that post's card on the
  home, blog, projects and tag pages.
- Leave it empty and the site logo card (`public/og-default.jpg`) is used.
- Writing by hand? Add `image: "/images/posts/your-image.jpg"` to the post's
  front matter. Best: a 1200×630 JPEG under 300 KB (WhatsApp and some other
  apps skip bigger preview images).
- Apps cache previews. To see a changed image, test the link in Facebook's
  Sharing Debugger or LinkedIn's Post Inspector; iMessage may need a fresh
  message. Plain SMS (not iMessage/RCS) never shows previews, only the link.

## Tags

Every tag on a post or project is a link to `/tags/<tag>/`, a page listing all
the posts and projects with that tag (drafts never appear). `/tags/` lists every
tag, and the blog page has a "browse by tag" row. "AI", "ai" and "Ai" are the
same tag. Nothing to set up: add tags when you publish.

## Visitor stats (private)

`/admin/stats` (log in first) shows page views, visitors, a daily chart, top
pages, where visitors come from, countries and devices. Visitors never see any
of it. The Editor and Stats links are at the top of the admin.

- **How it works:** every public page sends a tiny anonymous beacon to
  `/api/hit` (in `src/layouts/Layout.astro`); `worker/stats.js` stores one row per
  visit in a Cloudflare D1 database.
- **Privacy:** no cookies, and no IP addresses or browser strings are stored. A
  "visitor" is a salted hash that changes every day. Not counted: you while
  logged in to `/admin`, bots, browsers sending Do Not Track / Global Privacy
  Control, reloads of the same page within 30 minutes, and `*.workers.dev`
  preview addresses. Days are UTC.
- **Turning it on (one time):** the stats need a D1 database bound as `DB`. Add
  this to `wrangler.jsonc` and Cloudflare creates the database on the next deploy:

  ```jsonc
  "d1_databases": [{ "binding": "DB", "database_name": "troyco-stats" }]
  ```

  Until then the Stats page says it isn't switched on, and nothing is recorded.
- **Housekeeping:** rows older than about 13 months are deleted automatically,
  and the free D1 allowance (100,000 writes a day) is far more than a personal
  site needs. `npm run dev` doesn't run the worker, so there are no stats locally.

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
  - `og-default.jpg` — 1200×630 card shown when a link is shared (used when a
    post has no featured image)
- The password-protected admin panel (`worker/index.js`) has its own copy of
  the theme in `PAGE_STYLE`, so change colors there too if you re-theme.
