// Privacy-friendly visitor stats.
//
// Pages on this site are static files, so nothing on the server sees a visit.
// Instead every page sends a tiny "beacon" (see src/layouts/Layout.astro) to
// POST /api/hit, which stores one row in a Cloudflare D1 database (binding: DB).
// The admin's Stats page (/admin/stats) reads it back.
//
// What is stored: the page path, the referring site (hostname only), country,
// device type, and a visitor id that is a salted hash which changes every day.
// Never stored: cookies, IP addresses, user-agent strings, or anything that
// follows a person from one day to the next.
//
// What is NOT counted: you (while logged in to /admin), bots, browsers that send
// Do Not Track / Global Privacy Control, repeat views of the same page by the
// same visitor within 30 minutes, and anything on a *.workers.dev preview URL.
//
// If the DB binding doesn't exist yet, everything here quietly does nothing.

const DEDUPE_MINUTES = 30;
const RETENTION_DAYS = 400;
const BOT_PATTERN =
  /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|facebookexternalhit|curl|wget|python-requests|httpclient|go-http|axios|node-fetch/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------
// Dates (everything is UTC, as YYYY-MM-DD strings)
// ---------------------------------------------------------------------

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const shortDay = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

// ---------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------

const schemaPromises = new WeakMap(); // one CREATE-IF-NOT-EXISTS per database object

function ensureSchema(db) {
  let promise = schemaPromises.get(db);
  if (!promise) {
    promise = db
      .batch([
        db.prepare(
          `CREATE TABLE IF NOT EXISTS hits (
             ts INTEGER NOT NULL,
             day TEXT NOT NULL,
             path TEXT NOT NULL,
             referrer TEXT NOT NULL DEFAULT '',
             country TEXT NOT NULL DEFAULT '',
             device TEXT NOT NULL DEFAULT '',
             visitor TEXT NOT NULL
           )`
        ),
        db.prepare('CREATE INDEX IF NOT EXISTS hits_day ON hits (day)'),
        db.prepare('CREATE INDEX IF NOT EXISTS hits_visitor ON hits (visitor, path, ts)'),
      ])
      .catch((err) => {
        schemaPromises.delete(db); // try again next time
        throw err;
      });
    schemaPromises.set(db, promise);
  }
  return promise;
}

// ---------------------------------------------------------------------
// Recording a visit
// ---------------------------------------------------------------------

// Always resolves quietly: counting visits must never get in the way of a page view.
export async function recordHit(request, env, ctx, isOwner) {
  try {
    if (!env.DB || isOwner) return;
    const url = new URL(request.url);
    if (url.hostname.endsWith('.workers.dev')) return; // preview deployments
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return; // only our own pages
    if (request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1') return;
    const ua = request.headers.get('User-Agent') || '';
    if (!ua || BOT_PATTERN.test(ua)) return;
    if (Number(request.headers.get('Content-Length') || 0) > 2048) return;

    let body;
    try {
      body = JSON.parse((await request.text()).slice(0, 2048));
    } catch {
      return;
    }
    const path = cleanPath(body && body.p);
    if (!path || !(await isRealPage(request, env, path))) return;

    const now = Date.now();
    const day = dayOf(now);
    const visitor = await visitorId(env, day, request.headers.get('CF-Connecting-IP') || '', ua);
    await ensureSchema(env.DB);

    const recent = await env.DB
      .prepare('SELECT 1 AS seen FROM hits WHERE visitor = ?1 AND path = ?2 AND ts > ?3 LIMIT 1')
      .bind(visitor, path, now - DEDUPE_MINUTES * 60 * 1000)
      .first();
    if (recent) return;

    await env.DB
      .prepare('INSERT INTO hits (ts, day, path, referrer, country, device, visitor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(now, day, path, referrerHost(body.r, url.hostname), countryOf(request), deviceOf(ua), visitor)
      .run();

    // Now and then, drop rows older than the retention window.
    if (Math.random() < 0.01) {
      const cleanup = env.DB.prepare('DELETE FROM hits WHERE day < ?1').bind(addDays(day, -RETENTION_DAYS)).run();
      if (ctx && ctx.waitUntil) ctx.waitUntil(cleanup);
      else await cleanup;
    }
  } catch {
    // ignore: stats are best-effort
  }
}

// Only real URL-path characters; never the admin or API.
function cleanPath(p) {
  if (typeof p !== 'string' || p.length > 200 || !/^\/[A-Za-z0-9\-._~%/]*$/.test(p)) return null;
  if (p.includes('//') || p.includes('..')) return null;
  if (/^\/(admin|api)(\/|$)/.test(p)) return null;
  return p;
}

// The path must be a page that exists on this site, so nobody can fill the table with junk.
async function isRealPage(request, env, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  const isPage = res.status === 200 && (res.headers.get('content-type') || '').includes('text/html');
  if (res.body) res.body.cancel().catch(() => {}); // only the status was needed
  return isPage;
}

// Hostname of the referring site only ("" for direct visits and for this site itself).
function referrerHost(referrer, siteHostname) {
  if (typeof referrer !== 'string' || !referrer) return '';
  try {
    const strip = (h) => h.toLowerCase().replace(/^www\./, '');
    const host = strip(new URL(referrer).hostname);
    return host && host !== strip(siteHostname) ? host.slice(0, 80) : '';
  } catch {
    return '';
  }
}

function countryOf(request) {
  const code = String((request.cf && request.cf.country) || '').toUpperCase();
  return /^[A-Z0-9]{2}$/.test(code) ? code : '';
}

function deviceOf(ua) {
  if (/ipad|tablet/i.test(ua) || (/android/i.test(ua) && !/mobi/i.test(ua))) return 'tablet';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'mobile';
  return 'desktop';
}

// A salted hash of (day, IP, browser) that changes every day, so unique visitors can be
// counted within a day without storing anything that identifies or follows a person.
async function visitorId(env, day, ip, ua) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(`stats|${env.STATS_SALT || env.ADMIN_PASSWORD || ''}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${day}|${ip}|${ua}`));
  return [...new Uint8Array(sig).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------
// Reading the numbers back
// ---------------------------------------------------------------------

// Returns null when there is no database binding yet.
export async function loadStats(env, days, nowMs = Date.now()) {
  if (!env.DB) return null;
  const db = env.DB;
  await ensureSchema(db);

  const today = dayOf(nowMs);
  const since = addDays(today, -(days - 1));
  const prevSince = addDays(since, -days);
  const top = (column, limit) =>
    db
      .prepare(
        `SELECT ${column} AS name, COUNT(*) AS views, COUNT(DISTINCT day || visitor) AS visitors
         FROM hits WHERE day >= ?1 GROUP BY ${column} ORDER BY views DESC, name LIMIT ${limit}`
      )
      .bind(since);

  const [totals, daily, pages, referrers, countries, devices] = await db.batch([
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN day >= ?1 THEN 1 ELSE 0 END), 0) AS views,
           COUNT(DISTINCT CASE WHEN day >= ?1 THEN day || visitor END) AS visitors,
           COALESCE(SUM(CASE WHEN day < ?1 THEN 1 ELSE 0 END), 0) AS prevViews,
           COUNT(DISTINCT CASE WHEN day < ?1 THEN day || visitor END) AS prevVisitors
         FROM hits WHERE day >= ?2`
      )
      .bind(since, prevSince),
    db
      .prepare(
        `SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM hits WHERE day >= ?1 GROUP BY day`
      )
      .bind(since),
    top('path', 10),
    top('referrer', 8),
    top('country', 8),
    top('device', 4),
  ]);

  const byDay = new Map(daily.results.map((r) => [r.day, r]));
  const series = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(since, i);
    const row = byDay.get(day);
    series.push({ day, views: row ? row.views : 0, visitors: row ? row.visitors : 0 });
  }

  const t = totals.results[0] || {};
  return {
    days,
    since,
    today,
    totals: { views: t.views || 0, visitors: t.visitors || 0 },
    previous: { views: t.prevViews || 0, visitors: t.prevVisitors || 0 },
    todayViews: series[series.length - 1].views,
    series,
    pages: pages.results,
    referrers: referrers.results,
    countries: countries.results,
    devices: devices.results,
  };
}

// ---------------------------------------------------------------------
// The Stats page
// ---------------------------------------------------------------------

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const number = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : n.toLocaleString('en-US'));

// A round maximum for the y-axis (always even, so the middle gridline is a whole number).
function niceMax(max) {
  const pow = 10 ** Math.floor(Math.log10(Math.max(max, 1)));
  for (const step of [1, 2, 4, 6, 8, 10]) {
    const value = Math.max(2, step * pow);
    if (value >= max) return value;
  }
  return 10 * pow;
}

let regionNames = null;
try {
  regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  // fall back to the two-letter codes
}
function countryName(code) {
  if (!code) return 'Unknown';
  try {
    return (regionNames && regionNames.of(code)) || code;
  } catch {
    return code;
  }
}

function delta(current, previous, days) {
  if (!previous) return current ? 'Nothing recorded in the previous period' : '';
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return `▬ Same as the previous ${days} days`;
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs the previous ${days} days`;
}

function tile(label, value, sub) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(number(value))}</div><div class="tile-sub">${esc(sub || ' ')}</div></div>`;
}

function chart(data) {
  const { series, days } = data;
  const max = Math.max(...series.map((d) => d.views));
  if (max === 0) {
    return `<p class="muted">No visits recorded in this period yet.</p>`;
  }
  const top = niceMax(max);
  const peakIndex = series.findIndex((d) => d.views === max);
  const cols = series
    .map((d, i) => {
      const height = (d.views / top) * 100;
      const peak = i === peakIndex ? `<span class="peak" style="bottom:calc(${height.toFixed(2)}% + 4px)">${esc(number(d.views))}</span>` : '';
      return `<div class="col" data-day="${esc(d.day)}" data-views="${d.views}" data-visitors="${d.visitors}">${peak}<div class="bar${d.views ? ' nonzero' : ''}" style="height:${height.toFixed(2)}%"></div></div>`;
    })
    .join('');
  const mid = series[Math.floor((days - 1) / 2)].day;
  const rows = series
    .map((d) => `<tr><td>${esc(shortDay(d.day))}</td><td>${d.views}</td><td>${d.visitors}</td></tr>`)
    .join('');
  return `
    <div class="chart" id="chart" tabindex="0" role="group" aria-label="Page views per day. Use the left and right arrow keys to read each day.">
      <div class="y-axis"><span style="bottom:100%">${esc(number(top))}</span><span style="bottom:50%">${esc(number(top / 2))}</span><span style="bottom:0">0</span></div>
      <div class="plot">
        <div class="grid"><i style="bottom:50%"></i><i style="bottom:100%"></i></div>
        <div class="cols">${cols}</div>
      </div>
      <div class="x-axis"><span>${esc(shortDay(series[0].day))}</span><span>${esc(shortDay(mid))}</span><span>${esc(shortDay(series[days - 1].day))}</span></div>
      <div class="tip" id="tip" role="status" hidden></div>
    </div>
    <details class="table-view">
      <summary>Show as table</summary>
      <table>
        <thead><tr><th>Day</th><th>Views</th><th>Visitors</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

function barList(title, rows, label) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  const items = rows
    .map((r) => {
      const name = label(r.name);
      return `<li><div class="line"><span class="name" title="${esc(name)}">${esc(name)}</span><span class="val">${esc(number(r.views))}</span></div><div class="bar-track"><span class="bar-fill" style="width:${((r.views / max) * 100).toFixed(1)}%"></span></div></li>`;
    })
    .join('');
  return `<section class="card"><h2 class="card-title">${esc(title)}</h2>${
    rows.length ? `<ul class="blist">${items}</ul>` : '<p class="muted">Nothing yet.</p>'
  }</section>`;
}

const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : 'Unknown');

// `data` is null when the database isn't connected yet.
export function renderStatsBody(data, days) {
  if (!data) {
    return `<div class="notice">
      <strong>Stats aren&rsquo;t switched on yet.</strong>
      <p>Visits are counted in a small Cloudflare database, and this site isn&rsquo;t connected to one yet, so nothing is being recorded.
      Once it&rsquo;s connected, this page fills in by itself.</p>
    </div>`;
  }
  const range = [7, 30, 90]
    .map((n) => `<a href="/admin/stats?days=${n}"${n === days ? ' aria-current="true"' : ''}>Last ${n} days</a>`)
    .join('');
  return `
    <div class="stats">
      <div class="range" role="group" aria-label="Date range">${range}</div>
      <div class="tiles">
        ${tile('Page views', data.totals.views, delta(data.totals.views, data.previous.views, days))}
        ${tile('Visitors', data.totals.visitors, 'Counted once per day each')}
        ${tile('Views today', data.todayViews, 'Today so far (UTC)')}
      </div>
      <section class="card">
        <h2 class="card-title">Page views per day</h2>
        ${chart(data)}
      </section>
      <div class="lists">
        ${barList('Top pages', data.pages, (n) => n)}
        ${barList('Where visitors come from', data.referrers, (n) => n || 'Direct or unknown')}
        ${barList('Countries', data.countries, countryName)}
        ${barList('Devices', data.devices, titleCase)}
      </div>
      <p class="fineprint">
        Cookie-free and anonymous: no IP addresses are stored. Your own visits (while you&rsquo;re logged in), bots, and
        browsers that ask not to be tracked aren&rsquo;t counted. Days are UTC. Reloading a page doesn&rsquo;t count again
        for 30 minutes.
      </p>
    </div>`;
}

export const STATS_STYLE = `
  .panel.wide{max-width:50rem;}
  .muted{color:var(--muted);margin:.25rem 0 0;}
  .notice{background:#050608;border:1px solid var(--border);border-left:3px solid var(--gold);padding:1rem 1.2rem;margin-top:.5rem;}
  .notice p{margin:.4rem 0 0;color:var(--muted);}
  .range{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1.1rem;}
  .range a{font-family:'Michroma',sans-serif;font-size:.55rem;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;color:var(--muted);padding:.6rem .9rem;background:#050608;border:1px solid var(--border);border-radius:2px;}
  .range a:hover{color:#fff;}
  .range a[aria-current="true"]{color:#fff;border-color:var(--gold);background:rgba(255,214,10,.08);}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.75rem;margin-bottom:1rem;}
  .tile{background:#050608;border:1px solid var(--border);border-radius:2px;padding:.9rem 1rem;}
  .tile-label{font-size:.85rem;color:var(--muted);}
  .tile-value{font-size:2rem;font-weight:600;line-height:1.25;color:var(--text);}
  .tile-sub{font-size:.8rem;color:var(--muted);min-height:1.2em;}
  .card{background:#050608;border:1px solid var(--border);border-radius:2px;padding:1rem 1.1rem 1.1rem;margin-bottom:1rem;}
  .card-title{font-family:'Exo 2',system-ui,sans-serif;font-size:.95rem;font-weight:600;color:var(--text);margin:0 0 .75rem;}
  .chart{position:relative;padding-top:2.6rem;outline:none;}
  .chart:focus-visible{outline:2px solid var(--gold);outline-offset:4px;}
  .y-axis{position:absolute;left:0;top:2.6rem;height:11rem;width:2.2rem;}
  .y-axis span{position:absolute;right:0;transform:translateY(50%);font-size:.75rem;line-height:1;color:var(--muted);font-variant-numeric:tabular-nums;}
  .plot{position:relative;height:11rem;margin-left:2.6rem;border-bottom:1px solid #2a2e36;}
  .grid i{position:absolute;left:0;right:0;height:1px;background:#161920;}
  .cols{position:absolute;inset:0;display:flex;}
  .col{flex:1 1 0;min-width:0;position:relative;display:flex;align-items:flex-end;justify-content:center;}
  .bar{width:100%;max-width:24px;margin:0 1px;background:var(--gold);border-radius:4px 4px 0 0;}
  .bar.nonzero{min-height:2px;}
  .col:hover .bar,.col.on .bar{background:var(--gold-bright);}
  .peak{position:absolute;left:50%;transform:translateX(-50%);font-size:.75rem;line-height:1;font-weight:600;color:var(--text);white-space:nowrap;}
  .x-axis{display:flex;justify-content:space-between;margin:.55rem 0 0 2.6rem;font-size:.75rem;color:var(--muted);}
  .tip{position:absolute;top:0;pointer-events:none;background:#101217;border:1px solid #3a3f49;border-radius:2px;padding:.3rem .6rem;font-size:.8rem;line-height:1.35;white-space:nowrap;z-index:2;}
  .tip strong{display:block;color:#fff;font-size:.95rem;}
  .tip span{color:var(--muted);}
  .lists{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:1rem;}
  .lists .card{margin:0;}
  .blist{list-style:none;margin:0;padding:0;display:grid;gap:.7rem;}
  .blist .line{display:flex;justify-content:space-between;gap:1rem;font-size:.9rem;}
  .blist .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);}
  .blist .val{font-variant-numeric:tabular-nums;color:var(--muted);}
  .bar-track{height:4px;margin-top:.3rem;background:#14161b;border-radius:2px;}
  .bar-fill{display:block;height:100%;background:var(--gold);border-radius:0 2px 2px 0;}
  details.table-view{margin-top:.9rem;font-size:.85rem;color:var(--muted);}
  details.table-view summary{cursor:pointer;}
  .table-view table{width:100%;margin-top:.5rem;border-collapse:collapse;font-variant-numeric:tabular-nums;}
  .table-view th,.table-view td{text-align:right;padding:.25rem .5rem;border-bottom:1px solid #161920;}
  .table-view th:first-child,.table-view td:first-child{text-align:left;}
  .table-view th{font-weight:600;color:var(--text);}
  .fineprint{margin:1.1rem 0 0;font-size:.8rem;color:var(--muted);}
`;

// Hover / keyboard / touch readout for the daily chart. It lives in a String.raw
// template, so it must not contain backticks or "${".
export const STATS_SCRIPT = String.raw`
(() => {
  const chart = document.getElementById('chart');
  if (!chart) return;
  const tip = document.getElementById('tip');
  const cols = Array.from(chart.querySelectorAll('.col'));
  const count = (n, word) => n.toLocaleString('en-US') + ' ' + word + (n === 1 ? '' : 's');
  const fmtDate = (day) =>
    new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

  function show(i) {
    if (i < 0 || i >= cols.length) return hide();
    cols.forEach((c, k) => c.classList.toggle('on', k === i));
    const col = cols[i];
    const views = document.createElement('strong');
    views.textContent = count(Number(col.dataset.views), 'view');
    const detail = document.createElement('span');
    detail.textContent = count(Number(col.dataset.visitors), 'visitor') + ' · ' + fmtDate(col.dataset.day);
    tip.replaceChildren(views, detail);
    tip.hidden = false;
    const box = chart.getBoundingClientRect();
    const c = col.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const centre = c.left - box.left + c.width / 2;
    tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, centre - half)) + 'px';
    chart.dataset.index = String(i);
  }

  function hide() {
    tip.hidden = true;
    cols.forEach((c) => c.classList.remove('on'));
    delete chart.dataset.index;
  }

  const current = () => (chart.dataset.index === undefined ? -1 : Number(chart.dataset.index));
  const pointed = (e) => {
    const col = e.target.closest ? e.target.closest('.col') : null;
    if (col) show(cols.indexOf(col));
  };
  chart.addEventListener('pointermove', pointed);
  chart.addEventListener('pointerdown', pointed);
  chart.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hide(); });
  document.addEventListener('pointerdown', (e) => { if (!chart.contains(e.target)) hide(); });
  chart.addEventListener('focus', () => { if (current() < 0) show(cols.length - 1); });
  chart.addEventListener('blur', hide);
  chart.addEventListener('keydown', (e) => {
    const i = current();
    const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: cols.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    show(Math.max(0, Math.min(cols.length - 1, next)));
  });
})();
`;
