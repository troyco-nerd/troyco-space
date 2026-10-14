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
    draft: form.get('draft') === 'on',
    body: (form.get('body') || '').toString(),
  };

  if (!values.title || !values.description || !values.date || !values.body.trim()) {
    return htmlResponse(renderEditor({ error: 'Title, description, date, and body are all required.', values }), 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    return htmlResponse(renderEditor({ error: 'Date must be in YYYY-MM-DD format.', values }), 400);
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
  @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap');
  :root{--bg:#0b0221;--panel:#170a3b;--border:#4a3591;--border-bright:#7c5cff;--text:#f2eaff;--muted:#a996d6;--pink:#ff3ec8;--cyan:#2ef7ff;}
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;background:linear-gradient(180deg,#17023f,#0b0221 45%,#05010f);color:var(--text);font-family:'VT323',monospace;font-size:1.25rem;display:flex;align-items:flex-start;justify-content:center;padding:3rem 1.25rem;}
  .panel{max-width:30rem;width:100%;background:var(--panel);border:1px solid var(--border-bright);box-shadow:0 0 24px rgba(124,92,255,.35);border-radius:.5rem;padding:2rem;}
  .panel.wide{max-width:42rem;}
  h1{font-family:'Press Start 2P',monospace;font-size:1.1rem;color:var(--cyan);text-shadow:0 0 6px rgba(46,247,255,.5);margin:0;}
  label{display:block;font-size:1rem;color:var(--muted);margin:1.1rem 0 .3rem;text-transform:uppercase;letter-spacing:.03em;}
  input[type=text],input[type=password],input[type=date],input[type=url],textarea,select{
    width:100%;background:#05010f;border:1px solid var(--border);color:var(--text);
    font-family:'VT323',monospace;font-size:1.15rem;padding:.6rem .7rem;border-radius:.3rem;
  }
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--cyan);box-shadow:0 0 8px rgba(46,247,255,.4);}
  textarea{min-height:16rem;resize:vertical;font-family:ui-monospace,'VT323',monospace;font-size:1.05rem;}
  .row{display:flex;gap:1rem;}
  .row > div{flex:1;}
  .checkbox-row{display:flex;align-items:center;gap:.5rem;margin-top:1.1rem;}
  .checkbox-row input{width:auto;}
  .checkbox-row label{margin:0;text-transform:none;}
  button{font-family:'Press Start 2P',monospace;font-size:.7rem;background:transparent;color:var(--pink);border:1px solid var(--pink);border-radius:.3rem;padding:.8rem 1.2rem;margin-top:1.6rem;cursor:pointer;text-transform:uppercase;}
  button:hover{color:#05010f;background:var(--pink);box-shadow:0 0 16px rgba(255,62,200,.6);}
  .error{color:var(--pink);background:rgba(255,62,200,.08);border:1px solid var(--pink);border-radius:.3rem;padding:.75rem 1rem;margin-bottom:1rem;font-size:1.05rem;}
  .success{color:var(--cyan);background:rgba(46,247,255,.08);border:1px solid var(--cyan);border-radius:.3rem;padding:.75rem 1rem;margin-bottom:1rem;font-size:1.05rem;}
  .success code{background:#05010f;padding:.1em .4em;border-radius:.2rem;}
  .topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;}
  .topbar form{margin:0;}
  .topbar button{margin:0;font-size:.55rem;padding:.5rem .8rem;}
  a{color:var(--cyan);}
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

    <div class="checkbox-row">
      <input type="checkbox" id="draft" name="draft" ${v.draft ? 'checked' : ''}>
      <label for="draft">Save as draft (won't appear on the site)</label>
    </div>

    <button type="submit">Publish</button>
  </form>
</div>
</body></html>`;
}
