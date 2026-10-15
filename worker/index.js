// Minimal password-gated admin panel for creating blog posts / projects.
//
// Runs in the same Cloudflare Worker that serves the static Astro site.
// Static assets are matched first by Cloudflare's routing; only requests
// that don't match a built file reach this fetch handler, so every route
// below is explicitly listed and everything else falls through to
// env.ASSETS (which also serves the custom 404 page for real misses).
//
// Requires two Worker secrets, set in the Cloudflare dashboard:
//   ADMIN_PASSWORD  — the password for /admin (also used to sign session cookies)
//   GITHUB_TOKEN     — a fine-grained GitHub PAT with Contents: Read & write on this repo

const REPO_OWNER = 'troyco-nerd';
const REPO_NAME = 'troyco-space';
const BRANCH = 'main';
const COOKIE_NAME = 'troyco_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/admin' && request.method === 'GET') {
        return handleAdminRoot(request, env);
      }
      if (url.pathname === '/admin/login' && request.method === 'POST') {
        return handleLogin(request, env);
      }
      if (url.pathname === '/admin/logout' && request.method === 'POST') {
        return handleLogout();
      }
      if (url.pathname === '/admin/editor' && request.method === 'GET') {
        return handleEditorGet(request, env);
      }
      if (url.pathname === '/api/publish' && request.method === 'POST') {
        return handlePublish(request, env);
      }
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        return handleUpload(request, env);
      }
    } catch (err) {
      return new Response(`Internal error: ${err && err.message ? err.message : String(err)}`, { status: 500 });
    }

    // `not_found_handling` is intentionally left unset in wrangler.jsonc:
    // when a Worker (`main`) is configured, Cloudflare's built-in
    // not-found-page behavior intercepts real browser navigations (any
    // request with `Sec-Fetch-Mode: navigate`, which includes every link
    // click and plain HTML form submission) BEFORE this fetch handler runs
    // — which would swallow every /admin route. So we serve real static
    // assets here, and reproduce the custom 404 page ourselves for misses.
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }
    const notFound = await env.ASSETS.fetch(new URL('/404.html', request.url));
    return new Response(notFound.body, { status: 404, headers: notFound.headers });
  },
};

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

async function handleAdminRoot(request, env) {
  if (await isAuthed(request, env)) {
    return redirect('/admin/editor');
  }
  return htmlResponse(renderLogin());
}

async function handleLogin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return htmlResponse(renderLogin('Server not configured (missing ADMIN_PASSWORD secret).'), 500);
  }
  const form = await request.formData();
  const password = (form.get('password') || '').toString();

  if (!timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    return htmlResponse(renderLogin('Incorrect password.'), 401);
  }

  const token = await createSessionToken(env);
  const headers = new Headers({ Location: '/admin/editor' });
  headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  return new Response(null, { status: 303, headers });
}

async function handleLogout() {
  const headers = new Headers({ Location: '/admin' });
  headers.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return new Response(null, { status: 303, headers });
}

async function handleEditorGet(request, env) {
  if (!(await isAuthed(request, env))) {
    return redirect('/admin');
  }
  return htmlResponse(renderEditor());
}

async function handlePublish(request, env) {
  if (!(await isAuthed(request, env))) {
    return redirect('/admin');
  }
  if (!env.GITHUB_TOKEN) {
    return htmlResponse(renderEditor({ error: 'Server not configured (missing GITHUB_TOKEN secret).' }), 500);
  }

  const form = await request.formData();
  const values = {
    type: form.get('type') === 'project' ? 'project' : 'blog',
    title: (form.get('title') || '').toString().trim(),
    description: (form.get('description') || '').toString().trim(),
    date: (form.get('date') || '').toString().trim(),
    tags: (form.get('tags') || '').toString().trim(),
    url: (form.get('url') || '').toString().trim(),
    repo: (form.get('repo') || '').toString().trim(),
    image: (form.get('image') || '').toString().trim(),
    draft: form.get('draft') === 'on',
    // Browsers submit textareas with CRLF line endings; keep the saved file LF-only like the rest of the repo.
    body: (form.get('body') || '').toString().replace(/\r\n?/g, '\n'),
  };

  if (!values.title || !values.description || !values.date || !values.body.trim()) {
    return htmlResponse(renderEditor({ error: 'Title, description, date, and body are all required.', values }), 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    return htmlResponse(renderEditor({ error: 'Date must be in YYYY-MM-DD format.', values }), 400);
  }
  // The featured image can only be one the editor uploaded (the form sets this value itself).
  if (values.image && !/^\/images\/posts\/[a-z0-9][a-z0-9-]*\.(?:jpg|png|webp|gif)$/.test(values.image)) {
    return htmlResponse(
      renderEditor({ error: 'Featured image must be one uploaded with the editor — remove it and choose it again.', values: { ...values, image: '' } }),
      400
    );
  }

  const slug = slugify(values.title);
  if (!slug) {
    return htmlResponse(
      renderEditor({ error: 'Could not derive a URL slug from that title — try adding some letters or numbers.', values }),
      400
    );
  }

  const folder = values.type === 'project' ? 'projects' : 'blog';
  const path = `src/content/${folder}/${slug}.md`;
  const tagsArray = values.tags.split(',').map((t) => t.trim()).filter(Boolean);

  const frontmatter = ['---', `title: ${yamlString(values.title)}`, `description: ${yamlString(values.description)}`];
  frontmatter.push(`${values.type === 'project' ? 'date' : 'pubDate'}: ${values.date}`);
  if (values.type === 'project') {
    if (values.url) frontmatter.push(`url: ${yamlString(values.url)}`);
    if (values.repo) frontmatter.push(`repo: ${yamlString(values.repo)}`);
  }
  if (tagsArray.length) {
    frontmatter.push(`tags: [${tagsArray.map(yamlString).join(', ')}]`);
  }
  if (values.image) frontmatter.push(`image: ${yamlString(values.image)}`);
  if (values.draft) frontmatter.push('draft: true');
  frontmatter.push('---');
  const fileContent = `${frontmatter.join('\n')}\n\n${values.body.trim()}\n`;

  let ghResponse;
  try {
    ghResponse = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'troyco-space-admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Add ${values.type === 'project' ? 'project' : 'post'}: ${values.title}`,
        content: toBase64Utf8(fileContent),
        branch: BRANCH,
      }),
    });
  } catch (err) {
    return htmlResponse(
      renderEditor({ error: `Couldn't reach GitHub — check your connection and try again. (${err.message})`, values }),
      502
    );
  }

  if (!ghResponse.ok) {
    let detail = '';
    try {
      const data = await ghResponse.json();
      detail = data && data.message ? data.message : '';
    } catch {
      // ignore
    }
    const friendly =
      ghResponse.status === 422
        ? `A file already exists at ${path} — pick a different title, or edit the existing one directly on GitHub.`
        : `GitHub API error (${ghResponse.status}): ${detail || 'unknown error'}`;
    return htmlResponse(renderEditor({ error: friendly, values }), 502);
  }

  const liveUrl = `https://troyco.space/${folder}/${slug}/`;
  return htmlResponse(
    renderEditor({
      success: `Published! Committed to <code>${escapeHtml(path)}</code> on <code>main</code> — Cloudflare will build and deploy automatically, live at <a href="${liveUrl}">${liveUrl}</a> in about a minute.`,
    })
  );
}

// ---------------------------------------------------------------------
// Image upload
//
// The editor shrinks each image in the browser, then POSTs it here. We
// check it, commit it to public/images/posts/ on `main` (same GitHub API
// the publish handler uses), and reply with the URL to put in the post.
// ---------------------------------------------------------------------

const IMAGE_DIR = 'public/images/posts';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // safety net; the editor normally sends far less
const IMAGE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

async function handleUpload(request, env) {
  if (!(await isAuthed(request, env))) {
    return jsonResponse(
      { error: 'You are logged out. Log in again in a new tab (so you keep your draft), then retry.' },
      401
    );
  }
  if (!env.GITHUB_TOKEN) {
    return jsonResponse({ error: 'Server not configured (missing GITHUB_TOKEN secret).' }, 500);
  }

  let file = null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    // fall through to the "no image" error below
  }
  if (!file || typeof file === 'string') {
    return jsonResponse({ error: 'No image was received.' }, 400);
  }

  const ext = IMAGE_EXTENSIONS[file.type];
  if (!ext) {
    return jsonResponse({ error: 'Only PNG, JPEG, WebP, or GIF images are supported.' }, 415);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return jsonResponse({ error: 'That image is too large (the limit is 8 MB).' }, 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikeImage(bytes, ext)) {
    return jsonResponse({ error: `That file doesn't look like a real ${ext.toUpperCase()} image.` }, 415);
  }

  // e.g. "Chromecast Board.JPG" -> "chromecast-board-3f9a1c.jpg"
  const baseName = slugify(String(file.name || '').replace(/\.[^.]*$/, '')).slice(0, 40).replace(/-+$/, '');
  const name = `${baseName || 'image'}-${randomHex(3)}.${ext}`;
  const path = `${IMAGE_DIR}/${name}`;

  let ghResponse;
  try {
    ghResponse = await githubPutFile(env, path, bytesToBase64(bytes), `Add image: ${name}`);
  } catch (err) {
    return jsonResponse({ error: `Couldn't reach GitHub — check your connection and try again. (${err.message})` }, 502);
  }
  if (!ghResponse.ok) {
    let detail = '';
    try {
      const data = await ghResponse.json();
      detail = data && data.message ? data.message : '';
    } catch {
      // ignore
    }
    return jsonResponse({ error: `GitHub API error (${ghResponse.status}): ${detail || 'unknown error'}` }, 502);
  }

  return jsonResponse({ ok: true, name, url: `/images/posts/${name}`, size: bytes.length });
}

// Create a new file on BRANCH. GitHub rejects overlapping commits to the
// same branch with a 409, so retry a couple of times before giving up.
async function githubPutFile(env, path, contentBase64, message) {
  const attempts = 3;
  let response;
  for (let i = 0; i < attempts; i++) {
    response = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'troyco-space-admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, content: contentBase64, branch: BRANCH }),
    });
    if (response.status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
  }
  return response;
}

// Check the file's first bytes match what it claims to be, so a renamed
// non-image can't be committed into the repo as one.
function looksLikeImage(b, ext) {
  const startsWith = (...sig) => sig.every((v, i) => b[i] === v);
  if (ext === 'png') return startsWith(0x89, 0x50, 0x4e, 0x47);
  if (ext === 'jpg') return startsWith(0xff, 0xd8, 0xff);
  if (ext === 'gif') return startsWith(0x47, 0x49, 0x46, 0x38);
  if (ext === 'webp') {
    return startsWith(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  }
  return false;
}

// ---------------------------------------------------------------------
// Auth / session helpers
// ---------------------------------------------------------------------

async function isAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const token = getCookie(request, COOKIE_NAME);
  return verifySessionToken(token, env);
}

async function createSessionToken(env) {
  const payloadB64 = btoa(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }));
  const sig = await hmacHex(env.ADMIN_PASSWORD, payloadB64);
  return `${payloadB64}.${sig}`;
}

async function verifySessionToken(token, env) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  const expectedSig = await hmacHex(env.ADMIN_PASSWORD, payloadB64);
  if (!timingSafeEqual(sig, expectedSig)) return false;
  try {
    const payload = JSON.parse(atob(payloadB64));
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

async function hmacHex(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function randomHex(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  // Build the binary string in chunks; one big spread would overflow the call stack.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function yamlString(str) {
  return `"${String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------

const PAGE_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Michroma&family=Exo+2:ital,wght@0,400;0,600;1,400&display=swap');
  :root{color-scheme:dark;--bg:#000;--panel:#0a0b0e;--panel-soft:#101217;--border:#272b33;--text:#f3f4f6;--muted:#9aa1ab;--gold:#ffd60a;--gold-bright:#ffe96b;--gold-deep:#e8a200;--silver:#c5cbd3;--ice:#9fd8ff;--danger:#ff6b6b;--cut:18px;--cut-in:calc(var(--cut) - .586px);}
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;background:radial-gradient(ellipse 60% 38% at 50% -4%,rgba(255,214,10,.16),transparent 70%),radial-gradient(ellipse 70% 28% at 50% 108%,rgba(255,214,10,.1),transparent 70%),var(--bg);background-attachment:fixed;color:var(--text);font-family:'Exo 2',system-ui,sans-serif;font-size:1.05rem;line-height:1.6;display:flex;align-items:flex-start;justify-content:center;padding:3rem 1.25rem;}
  .panel{position:relative;isolation:isolate;max-width:30rem;width:100%;padding:2rem;background:linear-gradient(135deg,rgba(197,203,211,.5),rgba(197,203,211,.12) 45%,rgba(255,214,10,.9));clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));}
  .panel::before{content:'';position:absolute;inset:1px;z-index:-1;background:linear-gradient(160deg,var(--panel-soft),var(--panel));clip-path:polygon(0 0,calc(100% - var(--cut-in)) 0,100% var(--cut-in),100% 100%,var(--cut-in) 100%,0 calc(100% - var(--cut-in)));}
  .panel.wide{max-width:42rem;}
  .logo{display:block;height:3.5rem;width:auto;margin:0 0 1.25rem;mix-blend-mode:screen;}
  h1{font-family:'Michroma',sans-serif;font-weight:400;font-size:1rem;letter-spacing:.02em;color:#fff;margin:0;}
  h1::after{content:'';display:block;width:3rem;height:3px;margin-top:.7rem;background:linear-gradient(90deg,var(--gold-bright),var(--gold-deep));box-shadow:0 0 12px rgba(255,214,10,.7);transform:skewX(-35deg);transform-origin:left;}
  .panel > h1{margin-bottom:1.2rem;}
  label{display:block;font-family:'Michroma',sans-serif;font-size:.58rem;color:var(--silver);margin:1.3rem 0 .4rem;text-transform:uppercase;letter-spacing:.16em;}
  input[type=text],input[type=password],input[type=date],input[type=url],textarea,select{
    width:100%;background:#050608;border:1px solid var(--border);color:var(--text);
    font-family:'Exo 2',system-ui,sans-serif;font-size:1rem;padding:.65rem .75rem;border-radius:2px;
  }
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 1px var(--gold),0 0 14px rgba(255,214,10,.25);}
  textarea{min-height:16rem;resize:vertical;font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;font-size:.95rem;}
  .row{display:flex;gap:1rem;}
  .row > div{flex:1;}
  .checkbox-row{display:flex;align-items:center;gap:.5rem;margin-top:1.3rem;}
  .checkbox-row input{width:auto;accent-color:var(--gold);}
  .checkbox-row label{margin:0;text-transform:none;font-family:'Exo 2',system-ui,sans-serif;font-size:.95rem;letter-spacing:0;color:var(--muted);}
  button{font-family:'Michroma',sans-serif;font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;background:linear-gradient(135deg,var(--gold-bright),var(--gold-deep));color:#000;border:0;padding:.9rem 1.5rem;margin-top:1.6rem;cursor:pointer;clip-path:polygon(0 0,calc(100% - 9px) 0,100% 9px,100% 100%,9px 100%,0 calc(100% - 9px));}
  button:hover{filter:brightness(1.12);}
  button:focus-visible{outline:2px solid var(--gold);outline-offset:3px;}
  .error{color:var(--danger);background:rgba(255,107,107,.08);border:1px solid var(--danger);border-left-width:3px;border-radius:2px;padding:.75rem 1rem;margin-bottom:1rem;font-size:1rem;}
  .success{overflow-wrap:anywhere;color:var(--ice);background:rgba(159,216,255,.08);border:1px solid var(--ice);border-left-width:3px;border-radius:2px;padding:.75rem 1rem;margin-bottom:1rem;font-size:1rem;}
  .success code{background:#050608;padding:.1em .4em;border-radius:2px;}
  .topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;}
  .topbar form{margin:0;}
  .topbar button{margin:0;font-size:.5rem;padding:.6rem 1rem;background:rgba(255,214,10,.1);color:var(--gold);}
  .topbar button:hover{background:var(--gold);color:#000;filter:none;}
  [hidden]{display:none !important;}
  button:disabled{opacity:.5;cursor:wait;filter:none;}
  button.secondary{margin-top:0;font-size:.55rem;padding:.7rem 1.1rem;background:rgba(255,214,10,.1);color:var(--gold);}
  button.secondary:hover:not(:disabled){background:var(--gold);color:#000;filter:none;}
  .images-bar{display:flex;align-items:center;flex-wrap:wrap;gap:.5rem .9rem;margin-top:.75rem;}
  .hint{font-size:.85rem;color:var(--muted);flex:1;min-width:12rem;}
  textarea.dragging{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold),0 0 18px rgba(255,214,10,.35);}
  .image-list{list-style:none;margin:.9rem 0 0;padding:0;display:grid;gap:.6rem;}
  .image-list li{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem .85rem;padding:.55rem .7rem;background:#050608;border:1px solid var(--border);border-radius:2px;}
  .image-list .thumb{width:56px;height:56px;object-fit:cover;border:1px solid var(--border);border-radius:2px;flex:none;}
  .image-list .meta{flex:1 1 10rem;min-width:10rem;}
  .image-list .fname{font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .image-list .state{font-size:.85rem;color:var(--muted);}
  .image-list .state.ok{color:var(--ice);}
  .image-list .state.fail{color:var(--danger);}
  .image-list .alt{margin-top:.4rem;padding:.4rem .6rem;font-size:.9rem;}
  .image-list .actions{display:flex;flex-wrap:wrap;gap:.5rem;}
  .image-list .insert{flex:none;}
  .featured{margin-top:.1rem;}
  #featured-img{display:block;width:100%;max-width:24rem;height:auto;aspect-ratio:1200/630;object-fit:cover;border:1px solid var(--border);border-radius:2px;}
  .featured .state{font-size:.85rem;color:var(--muted);margin:.4rem 0 .2rem;}
  .featured .state.ok{color:var(--ice);}
  .featured .state.fail{color:var(--danger);}
  a{color:var(--gold);}
  a:hover{color:#fff;}
  @media (max-width:560px){.row{flex-direction:column;gap:0;}}
`;

// Browser-side code for the editor's image button / drag-drop / paste.
// Lives in a String.raw template, so it must not contain backticks or "${".
const EDITOR_SCRIPT = String.raw`
(() => {
  const MAX_SIDE = 1600;              // longest side, in pixels, after shrinking
  const KEEP_ORIGINAL_UNDER = 1.5e6;  // small images that are already fine go up untouched
  const textarea = document.getElementById('body');
  const fileInput = document.getElementById('image-input');
  const list = document.getElementById('image-list');
  const publishBtn = document.querySelector('form[action="/api/publish"] button[type="submit"]');
  let queue = Promise.resolve();      // uploads run one at a time: GitHub rejects overlapping commits
  let pending = 0;
  let touched = false;                // has the cursor ever been in the body box?

  textarea.addEventListener('focus', () => { touched = true; });
  document.getElementById('add-image').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  // ---- Featured image: the picture link previews show when the post is shared ----
  const SHARE_W = 1200;
  const SHARE_H = 630;
  const SHARE_MAX_BYTES = 280 * 1024;  // WhatsApp and some other apps skip preview images over ~300 KB
  const featuredInput = document.getElementById('featured-input');
  const featuredUrl = document.getElementById('featured-url');
  const featuredBox = document.getElementById('featured-preview');
  const featuredImg = document.getElementById('featured-img');
  const featuredState = document.getElementById('featured-state');
  const clearFeatured = document.getElementById('clear-featured');
  let featuredToken = 0;              // lets a newer choice (or Remove) win over a slower earlier upload

  document.getElementById('set-featured').addEventListener('click', () => featuredInput.click());
  featuredInput.addEventListener('change', () => {
    const file = featuredInput.files[0];
    featuredInput.value = '';
    if (file) setFeatured(file);
  });
  clearFeatured.addEventListener('click', () => {
    featuredToken++;
    featuredUrl.value = '';
    featuredImg.hidden = true;
    featuredImg.removeAttribute('src');
    featuredBox.hidden = true;
    clearFeatured.hidden = true;
  });

  function setFeatured(file) {
    const token = ++featuredToken;
    featuredUrl.value = '';           // no stale value if this attempt fails
    featuredImg.hidden = true;
    featuredBox.hidden = false;
    clearFeatured.hidden = false;
    featuredState.className = 'state';
    featuredState.textContent = 'Waiting…';
    setPending(1);
    queue = queue
      .then(async () => {
        if (token !== featuredToken) return;
        featuredState.textContent = 'Cropping and uploading…';
        const shot = await makeShareImage(file);
        const data = await upload(shot.file);
        if (token !== featuredToken) return;
        featuredUrl.value = data.url;
        featuredImg.src = URL.createObjectURL(shot.blob);   // show exactly what was cropped
        featuredImg.hidden = false;
        featuredState.className = 'state ok';
        featuredState.textContent = 'Featured image saved (' + formatSize(data.size) + ')' +
          (shot.small ? ' — the original is small, so it may look soft' : '');
      })
      .catch((err) => {
        if (token !== featuredToken) return;
        featuredState.className = 'state fail';
        featuredState.textContent = err && err.message ? err.message : 'Upload failed.';
      })
      .then(() => setPending(-1));
  }

  // Centre-crop to 1200x630 and save as a small JPEG (every app can show JPEG).
  async function makeShareImage(file) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      throw new Error('Only PNG, JPEG, WebP, or GIF images are supported.');
    }
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('Could not read that image.'); }
    const scale = Math.max(SHARE_W / bitmap.width, SHARE_H / bitmap.height);
    const sw = SHARE_W / scale;
    const sh = SHARE_H / scale;
    const canvas = document.createElement('canvas');
    canvas.width = SHARE_W;
    canvas.height = SHARE_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';           // transparent areas become the site's black
    ctx.fillRect(0, 0, SHARE_W, SHARE_H);
    ctx.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, SHARE_W, SHARE_H);
    bitmap.close();
    let blob = null;
    for (const quality of [0.88, 0.78, 0.68, 0.58, 0.48]) {
      blob = await toBlob(canvas, 'image/jpeg', quality);
      if (blob && blob.size <= SHARE_MAX_BYTES) break;
    }
    if (!blob) throw new Error('Could not process that image.');
    const base = (file.name || 'image').replace(/\.[^.]*$/, '');
    return { blob, file: new File([blob], base + '-share.jpg', { type: 'image/jpeg' }), small: scale > 1 };
  }

  // Drop an image anywhere on the page (dropping on the page would otherwise navigate away and lose the draft).
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) { e.preventDefault(); textarea.classList.add('dragging'); }
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) textarea.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    textarea.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });
  // Paste a screenshot / copied image straight into the box (but leave normal text pastes alone).
  textarea.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length && !e.clipboardData.getData('text/plain')) {
      e.preventDefault();
      addFiles(files);
    }
  });

  function addFiles(files) {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const item = makeItem(file);
      setPending(1);
      queue = queue
        .then(async () => {
          item.progress('Uploading…');
          const data = await upload(await prepare(file));
          item.done(data);
        })
        .catch((err) => item.fail(err && err.message ? err.message : 'Upload failed.'))
        .then(() => setPending(-1));
    });
  }

  // Shrink big photos (and convert to WebP) before uploading: faster uploads, faster pages.
  async function prepare(file) {
    if (file.type === 'image/gif') return file;   // re-encoding would flatten the animation
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      throw new Error('Only PNG, JPEG, WebP, or GIF images are supported.');
    }
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('Could not read that image.'); }
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= KEEP_ORIGINAL_UNDER) { bitmap.close(); return file; }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    let blob = await toBlob(canvas, 'image/webp', 0.85);
    if (!blob || blob.type !== 'image/webp') {    // older Safari can't encode WebP: fall back to JPEG
      const flat = document.createElement('canvas');
      flat.width = canvas.width;
      flat.height = canvas.height;
      const ctx = flat.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(canvas, 0, 0);
      blob = await toBlob(flat, 'image/jpeg', 0.88);
    }
    if (!blob) throw new Error('Could not process that image.');
    if (scale === 1 && blob.size >= file.size) return file;   // re-encoding didn't help
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], (file.name || 'image').replace(/\.[^.]*$/, '') + '.' + ext, { type: blob.type });
  }

  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  async function upload(file) {
    const form = new FormData();
    form.append('file', file, file.name);
    let res;
    try {
      res = await fetch('/api/upload', { method: 'POST', body: form, credentials: 'same-origin' });
    } catch {
      throw new Error('Could not reach the server — check your connection.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || 'Upload failed (' + res.status + ').');
    return data;
  }

  // One row in the image list: thumbnail, status, alt-text box, "Insert again".
  function makeItem(file) {
    const li = document.createElement('li');
    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.alt = '';
    thumb.src = URL.createObjectURL(file);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const fname = document.createElement('div');
    fname.className = 'fname';
    fname.textContent = file.name || 'pasted image';
    const state = document.createElement('div');
    state.className = 'state';
    state.textContent = 'Waiting…';
    const alt = document.createElement('input');
    alt.type = 'text';
    alt.className = 'alt';
    alt.hidden = true;
    alt.placeholder = 'Describe the image (alt text)';
    alt.value = altFromName(file.name);
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'secondary insert';
    again.textContent = 'Insert again';
    again.hidden = true;
    const feature = document.createElement('button');
    feature.type = 'button';
    feature.className = 'secondary insert';
    feature.textContent = 'Use as featured';
    feature.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(again, feature);
    meta.append(fname, state, alt);
    li.append(thumb, meta, actions);
    list.append(li);

    let url = '';
    let insertedAlt = '';
    function insert() {
      insertedAlt = cleanAlt(alt.value);
      insertImage(url, insertedAlt);
    }
    // Editing the alt box rewrites the alt text already in the post.
    alt.addEventListener('input', () => {
      const next = cleanAlt(alt.value);
      replaceAll('![' + insertedAlt + '](' + url + ')', '![' + next + '](' + url + ')');
      insertedAlt = next;
    });
    again.addEventListener('click', insert);
    feature.addEventListener('click', () => setFeatured(file));

    return {
      progress(msg) { state.textContent = msg; },
      fail(msg) { state.textContent = msg; state.className = 'state fail'; },
      done(data) {
        url = data.url;
        state.textContent = 'Added to your site (' + formatSize(data.size) + ')';
        state.className = 'state ok';
        alt.hidden = false;
        again.hidden = false;
        feature.hidden = false;
        insert();
      },
    };
  }

  // Put ![alt](url) on its own line at the cursor (or at the end if the cursor was never in the box).
  function insertImage(url, alt) {
    const md = '![' + alt + '](' + url + ')';
    const value = textarea.value;
    const at = touched ? textarea.selectionEnd : value.length;
    const before = value.slice(0, at);
    const after = value.slice(at);
    const lead = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    textarea.value = before + lead + md + trail + after;
    const caret = before.length + lead.length + md.length + trail.length;
    textarea.setSelectionRange(caret, caret);
  }

  function replaceAll(from, to) {
    if (!textarea.value.includes(from)) return;
    const s = textarea.selectionStart;
    const e = textarea.selectionEnd;
    textarea.value = textarea.value.split(from).join(to);
    textarea.setSelectionRange(s, e);
  }

  function setPending(delta) {
    pending += delta;
    if (!publishBtn) return;
    publishBtn.disabled = pending > 0;
    publishBtn.textContent = pending > 0 ? 'Uploading images…' : 'Publish';
  }

  // Brackets/backslashes would break the Markdown, so strip them.
  const cleanAlt = (s) => s.replace(/[\[\]\\]/g, '').replace(/\s+/g, ' ').trim();
  // "chromecast-board.jpg" -> "chromecast board"; camera/screenshot names are left blank.
  function altFromName(name) {
    const base = String(name || '').replace(/\.[^.]*$/, '');
    if (/^(image|img|dsc|pxl|photo|screenshot|screen shot|pasted)/i.test(base)) return '';
    return cleanAlt(base.replace(/[-_]+/g, ' '));
  }
  const formatSize = (n) => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
})();
`;

function renderLogin(error) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Admin Login · Troy Coroles</title>
<style>${PAGE_STYLE}</style>
</head><body>
<div class="panel">
  <img class="logo" src="/logo-lockup.webp" alt="troyco.space" width="760" height="245">
  <h1>Admin Login</h1>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  <form method="POST" action="/admin/login">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required autofocus>
    <button type="submit">Log In</button>
  </form>
</div>
</body></html>`;
}

function renderEditor(opts = {}) {
  const { error, success } = opts;
  const v = Object.assign(
    {
      type: 'blog',
      title: '',
      description: '',
      date: new Date().toISOString().slice(0, 10),
      tags: '',
      url: '',
      repo: '',
      image: '',
      draft: false,
      body: '',
    },
    opts.values
  );

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>New Post · Troy Coroles Admin</title>
<style>${PAGE_STYLE}</style>
</head><body>
<div class="panel wide">
  <div class="topbar">
    <h1>New Post</h1>
    <form method="POST" action="/admin/logout"><button type="submit">Log Out</button></form>
  </div>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  ${success ? `<div class="success">${success}</div>` : ''}
  <form method="POST" action="/api/publish">
    <label for="type">Type</label>
    <select id="type" name="type" onchange="document.querySelectorAll('.project-only').forEach(el => el.style.display = this.value === 'project' ? '' : 'none')">
      <option value="blog" ${v.type === 'blog' ? 'selected' : ''}>Blog post</option>
      <option value="project" ${v.type === 'project' ? 'selected' : ''}>Project</option>
    </select>

    <label for="title">Title</label>
    <input type="text" id="title" name="title" required value="${escapeHtml(v.title)}">

    <label for="description">Description</label>
    <input type="text" id="description" name="description" required value="${escapeHtml(v.description)}">

    <label for="set-featured">Featured image (for sharing)</label>
    <div class="featured">
      <div id="featured-preview" ${v.image ? '' : 'hidden'}>
        <img id="featured-img" alt="Preview of the featured image" width="1200" height="630" ${v.image ? `src="${escapeHtml(v.image)}"` : 'hidden'}>
        <div class="state" id="featured-state">${v.image ? 'Featured image set' : ''}</div>
      </div>
      <div class="images-bar">
        <button type="button" class="secondary" id="set-featured">Choose featured image</button>
        <button type="button" class="secondary" id="clear-featured" ${v.image ? '' : 'hidden'}>Remove</button>
        <span class="hint">The picture shown with your title and description when the post is shared on social media or in a text message. It&rsquo;s cropped to 1200&times;630. Leave it empty to use the site logo.</span>
      </div>
      <input type="hidden" name="image" id="featured-url" value="${escapeHtml(v.image)}">
      <input type="file" id="featured-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
    </div>

    <div class="row">
      <div>
        <label for="date">Date</label>
        <input type="date" id="date" name="date" required value="${escapeHtml(v.date)}">
      </div>
      <div>
        <label for="tags">Tags (comma separated)</label>
        <input type="text" id="tags" name="tags" value="${escapeHtml(v.tags)}">
      </div>
    </div>

    <div class="row project-only" style="display:${v.type === 'project' ? '' : 'none'};">
      <div>
        <label for="url">Live URL (optional)</label>
        <input type="url" id="url" name="url" value="${escapeHtml(v.url)}">
      </div>
      <div>
        <label for="repo">Repo URL (optional)</label>
        <input type="url" id="repo" name="repo" value="${escapeHtml(v.repo)}">
      </div>
    </div>

    <label for="body">Body (Markdown)</label>
    <textarea id="body" name="body" required>${escapeHtml(v.body)}</textarea>

    <div class="images-bar">
      <button type="button" class="secondary" id="add-image">Add image</button>
      <span class="hint">…or drag &amp; drop / paste an image into the box above. It&rsquo;s shrunk and saved to your site right away, and the Markdown is added to your post.</span>
    </div>
    <input type="file" id="image-input" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    <ul class="image-list" id="image-list" aria-live="polite"></ul>

    <div class="checkbox-row">
      <input type="checkbox" id="draft" name="draft" ${v.draft ? 'checked' : ''}>
      <label for="draft">Save as draft (won't appear on the site)</label>
    </div>

    <button type="submit">Publish</button>
  </form>
</div>
<script>${EDITOR_SCRIPT}</script>
</body></html>`;
}
