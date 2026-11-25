// Site Scout: Cloudflare Worker relay.
// The browser does all the scanning and scoring. This Worker only forwards
// requests the browser isn't allowed to make itself (other sites block that),
// so it stays inside the free plan's 10 ms CPU limit: it passes response
// bodies straight through without reading them.
//
// Secrets (Cloudflare dashboard → your Worker → Settings → Variables and Secrets):
//   APP_PASSWORD  required: the passcode you type into the app
//   PSI_KEY       optional: free Google PageSpeed Insights API key

const UA = 'SiteScout/1.0 (internal lead research tool)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Only public http(s) sites: never let the relay reach private addresses.
function publicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(':')) return null;
  return u;
}

function timeout(ms) { return AbortSignal.timeout(ms); }

// Constant-time compare so the passcode can't be guessed by timing.
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function route(req, env, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/ping') return json({ ok: true, hasPsiKey: !!env.PSI_KEY });

  if (p === '/api/geocode') {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q.get('q') || ''), { headers: { 'User-Agent': UA }, signal: timeout(15000) });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  }

  if (p === '/api/overpass' && req.method === 'POST') {
    const query = await req.text();
    if (query.length > 20000 || !query.startsWith('[out:json]')) return json({ error: 'Bad map query' }, 400);
    let last = 'Map data server unavailable';
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query), signal: timeout(90000) });
        if (r.ok) return new Response(r.body, { headers: { 'content-type': 'application/json' } });
        last = 'Map data server busy (' + r.status + ')';
      } catch (e) { last = String(e.message || e); }
    }
    return json({ error: last }, 502);
  }

  if (p === '/api/page') {
    const target = publicUrl(q.get('url'));
    if (!target) return json({ error: 'Bad website address' }, 400);
    try {
      const r = await fetch(target.href, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*' }, signal: timeout(20000) });
      const h = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      h.set('x-status', String(r.status));
      h.set('x-final-url', r.url || target.href);
      for (const n of ['link', 'x-pingback', 'x-robots-tag', 'server', 'x-powered-by']) if (r.headers.get(n)) h.set('x-h-' + n, r.headers.get(n).slice(0, 2000));
      return new Response(r.body, { headers: h });
    } catch (e) {
      return json({ error: e.name === 'TimeoutError' ? 'Site timed out' : 'Site did not load', dead: true }, 502);
    }
  }

  if (p === '/api/sitemap') {
    const base = publicUrl(q.get('url'));
    if (!base) return json({ found: false });
    for (const path of ['/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap.xml']) {
      try {
        const r = await fetch(new URL(path, base).href, { headers: { 'User-Agent': BROWSER_UA }, signal: timeout(8000) });
        const type = r.headers.get('content-type') || '';
        r.body?.cancel();
        if (r.ok && /xml/i.test(type)) return json({ found: true, path });
      } catch { /* try next */ }
    }
    return json({ found: false });
  }

  if (p === '/api/wplatest') {
    const r = await fetch('https://api.wordpress.org/core/version-check/1.7/', { headers: { 'User-Agent': UA }, signal: timeout(10000) });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } });
  }

  if (p === '/api/psi') {
    const target = publicUrl(q.get('url'));
    if (!target) return json({ error: 'Bad website address' }, 400);
    const qs = new URLSearchParams({ url: target.href, strategy: 'mobile' });
    for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) qs.append('category', c);
    if (env.PSI_KEY) qs.set('key', env.PSI_KEY);
    const r = await fetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + qs, { signal: timeout(120000) });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (!env.APP_PASSWORD) return json({ error: 'Set the APP_PASSWORD secret in Cloudflare (Settings → Variables and Secrets), then reload.' }, 503);
    if (!sameText(req.headers.get('x-pass') || '', env.APP_PASSWORD)) return json({ error: 'Wrong passcode' }, 401);
    try { return await route(req, env, url); }
    catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
};
