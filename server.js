// Site Scout — local lead finder. No dependencies: needs Node 18 or newer.
// Run: node server.js   then open http://localhost:4321
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4321;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const UA = 'SiteScout/1.0 (internal lead research tool)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// ---------- saved state (one JSON file on your computer) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { config: {}, scans: [], analyses: {}, psi: {}, leads: {} }; }
}
let state = loadState();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  }, 300);
}

// ---------- business categories → OpenStreetMap tags ----------
const CATEGORIES = {
  food: { label: 'Restaurants & cafes', tags: [['amenity', 'restaurant|cafe|fast_food|bar|pub|ice_cream'], ['shop', 'bakery|deli|butcher|confectionery']] },
  beauty: { label: 'Salons & beauty', tags: [['shop', 'hairdresser|beauty|nails|tattoo|massage|cosmetics']] },
  auto: { label: 'Auto services', tags: [['shop', 'car_repair|tyres|car|car_parts|motorcycle'], ['amenity', 'car_wash']] },
  trades: { label: 'Trades & contractors', tags: [['craft', 'plumber|electrician|hvac|roofer|carpenter|painter|builder|gardener|stonemason|tiler|glaziery|locksmith|window_construction|flooring'], ['shop', 'trade|doityourself']] },
  health: { label: 'Health & wellness', tags: [['amenity', 'dentist|clinic|doctors|veterinary'], ['leisure', 'fitness_centre|sports_centre'], ['healthcare', 'physiotherapist|chiropractor|optometrist|psychotherapist']] },
  retail: { label: 'Local retail', tags: [['shop', 'florist|clothes|gift|jewelry|furniture|hardware|pet|bicycle|garden_centre|books|music|sports|shoes|boutique|antiques|art|frame|second_hand']] },
  pro: { label: 'Professional services', tags: [['office', 'lawyer|accountant|estate_agent|insurance|financial|tax_advisor|architect|consulting|financial_advisor']] },
  home: { label: 'Home & personal services', tags: [['shop', 'dry_cleaning|laundry|tailor|interior_decoration|kitchen|bathroom_furnishing'], ['amenity', 'childcare|driving_school']] },
};

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('Request too large'); }
  return s ? JSON.parse(s) : {};
}
function normalizeUrl(u) {
  if (!u) return null;
  u = String(u).trim().split(/[;\s]/)[0];
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { return new URL(u).href; } catch { return null; }
}

// Websites that aren't really "their own site"
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|instagram\.com|linktr\.ee|tiktok\.com|twitter\.com|x\.com|yelp\.com|nextdoor\.com|google\.com|business\.site|g\.page|linkedin\.com|booksy\.com|vagaro\.com|doordash\.com|grubhub\.com|ubereats\.com|toasttab\.com|square\.site|thumbtack\.com|angi\.com|homeadvisor\.com)$/i;
const FREE_BUILDER = /(^|\.)(wixsite\.com|weebly\.com|godaddysites\.com|wordpress\.com|blogspot\.com|webflow\.io|carrd\.co|squarespace\.com|site123\.me|jimdosite\.com|mystrikingly\.com)$/i;

function classifyWeb(tags) {
  const site = normalizeUrl(tags.website || tags['contact:website'] || tags.url);
  const social = tags['contact:facebook'] || tags['contact:instagram'] || tags.facebook || tags.instagram;
  if (!site) return social ? { presence: 'social', url: normalizeUrl(social) } : { presence: 'none', url: null };
  const host = new URL(site).hostname.replace(/^www\./, '');
  if (SOCIAL.test(host)) return { presence: 'social', url: site };
  if (FREE_BUILDER.test(host)) return { presence: 'weak', url: site };
  return { presence: 'site', url: site };
}

// ---------- step 1: geocode + Overpass scan ----------
async function geocode(q) {
  const r = await fetchWithTimeout('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('Location lookup failed (' + r.status + ')');
  const j = await r.json();
  if (!j.length) throw new Error('Could not find "' + q + '". Try a city and state, like "West Jordan, UT", or a ZIP code.');
  return { lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name };
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function overpass(query) {
  let lastErr;
  for (const ep of OVERPASS) {
    try {
      const r = await fetchWithTimeout(ep, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query) }, 90000);
      if (r.ok) return await r.json();
      lastErr = new Error('Map data server busy (' + r.status + ')');
    } catch (e) { lastErr = e; }
    await sleep(1000);
  }
  throw lastErr;
}

async function scan({ location, radiusMiles = 3, categories = [] }) {
  if (!location) throw new Error('Enter a city or ZIP code.');
  const cats = categories.filter(c => CATEGORIES[c]);
  if (!cats.length) throw new Error('Pick at least one category.');
  const center = await geocode(location);
  const meters = Math.round(Math.min(Math.max(+radiusMiles || 3, 0.5), 25) * 1609);
  const parts = [];
  for (const c of cats) for (const [k, v] of CATEGORIES[c].tags)
    parts.push(`nwr["${k}"~"^(${v})$"]["name"](around:${meters},${center.lat},${center.lon});`);
  const q = `[out:json][timeout:80];(${parts.join('')});out center tags;`;
  const data = await overpass(q);

  const businesses = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    if (t.brand || t['brand:wikidata']) continue; // chains aren't prospects
    let cat = null;
    for (const c of cats) if (CATEGORIES[c].tags.some(([k, v]) => t[k] && new RegExp('^(' + v + ')$').test(t[k]))) { cat = c; break; }
    const web = classifyWeb(t);
    const addr = [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:city']].filter(Boolean).join(', ');
    businesses.push({
      id: el.type + '/' + el.id,
      name: t.name,
      category: cat,
      kind: (t.amenity || t.shop || t.craft || t.office || t.leisure || t.healthcare || '').replace(/_/g, ' '),
      address: addr,
      phone: t.phone || t['contact:phone'] || '',
      email: t.email || t['contact:email'] || '',
      lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon,
      presence: web.presence, url: web.url,
      osm: 'https://www.openstreetmap.org/' + el.type + '/' + el.id,
    });
  }
  const result = { id: Date.now().toString(36), at: new Date().toISOString(), location, label: center.label, center, radiusMiles: +radiusMiles, categories: cats, businesses };
  state.scans = [result, ...state.scans.filter(s => s.location !== location || s.categories.join() !== cats.join())].slice(0, 15);
  save();
  return result;
}

// ---------- step 2: analyze a website (WordPress, outdated signals, SEO) ----------
let latestWp = { version: null, at: 0 };
async function latestWordPress() {
  if (latestWp.version && Date.now() - latestWp.at < 864e5) return latestWp.version;
  try {
    const r = await fetchWithTimeout('https://api.wordpress.org/core/version-check/1.7/', { headers: { 'User-Agent': UA } }, 10000);
    const j = await r.json();
    latestWp = { version: j.offers?.[0]?.current || null, at: Date.now() };
  } catch { /* offline: leave null */ }
  return latestWp.version;
}
function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
// Releases behind, counting minor versions: 6.2 vs 6.8 = 6, 5.9 vs 6.8 = 9
function releasesBehind(v, latest) {
  if (!v || !latest) return null;
  const [a1, a2 = 0] = v.split('.').map(Number), [b1, b2 = 0] = latest.split('.').map(Number);
  return Math.max(0, (b1 * 10 + b2) - (a1 * 10 + a2));
}
function mostCommon(arr) {
  const m = {}; let best = null;
  for (const x of arr) { m[x] = (m[x] || 0) + 1; if (!best || m[x] > m[best]) best = x; }
  return best;
}
function uniq(arr) { return [...new Set(arr)]; }

async function analyze(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error('Bad website address');
  const out = { url, checkedAt: new Date().toISOString(), ok: false };
  let res, html = '';
  try {
    res = await fetchWithTimeout(url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } }, 20000);
    html = (await res.text()).slice(0, 3e6);
  } catch (e) {
    out.error = e.name === 'TimeoutError' ? 'Site timed out' : 'Site did not load (' + (e.cause?.code || e.message) + ')';
    out.dead = true;
    state.analyses[url] = out; save();
    return out;
  }
  out.status = res.status;
  out.finalUrl = res.url;
  out.https = res.url.startsWith('https://');
  out.ok = res.ok;
  if (!res.ok) { out.error = 'Site returned an error (' + res.status + ')'; out.dead = res.status >= 404; }
  const h = html.toLowerCase();
  const hdr = n => res.headers.get(n) || '';

  // Parked / for-sale domains
  out.parked = /domain (is )?for sale|buy this domain|parked (free|domain)|this domain may be for sale|sedoparking|godaddy\.com\/park/i.test(html.slice(0, 20000)) && html.length < 60000;

  // WordPress detection
  const gen = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i);
  out.generator = gen ? gen[1] : '';
  const signals = [];
  if (h.includes('/wp-content/')) signals.push('wp-content');
  if (h.includes('/wp-includes/')) signals.push('wp-includes');
  if (/wordpress/i.test(out.generator)) signals.push('generator tag');
  if (h.includes('api.w.org') || hdr('link').includes('api.w.org') || h.includes('/wp-json/')) signals.push('REST API');
  if (hdr('x-pingback')) signals.push('x-pingback');
  if (h.includes('wp-block-') || h.includes('wp-emoji')) signals.push('block/emoji');
  out.wp = { detected: signals.length >= 2 || /wordpress/i.test(out.generator), signals };

  if (out.wp.detected) {
    let v = (out.generator.match(/WordPress\s+(\d+\.\d+(?:\.\d+)?)/i) || [])[1];
    let source = v ? 'generator tag' : null;
    if (!v) {
      const vers = [...html.matchAll(/\/wp-includes\/[^"'\s>]+?\?ver=(\d+\.\d+(?:\.\d+)?)/gi)].map(m => m[1]);
      v = mostCommon(vers);
      if (v) source = 'core file versions';
    }
    if (!v) {
      try {
        const f = await fetchWithTimeout(new URL('/feed/', res.url).href, { headers: { 'User-Agent': BROWSER_UA } }, 8000);
        const fv = ((await f.text()).match(/wordpress\.org\/\?v=(\d+\.\d+(?:\.\d+)?)/i) || [])[1];
        if (fv) { v = fv; source = 'RSS feed'; }
      } catch { /* ignore */ }
    }
    const latest = await latestWordPress();
    out.wp.version = v || null;
    out.wp.versionSource = source;
    out.wp.latest = latest;
    out.wp.behind = releasesBehind(v, latest);
    out.wp.outdated = out.wp.behind != null ? out.wp.behind > 0 : null; // patch-only gaps don't count: WP auto-installs those
    out.wp.theme = (html.match(/\/wp-content\/themes\/([a-z0-9_.-]+)\//i) || [])[1] || null;
    out.wp.plugins = uniq([...html.matchAll(/\/wp-content\/plugins\/([a-z0-9_.-]+)\//gi)].map(m => m[1].toLowerCase())).slice(0, 40);
  }

  // Page builders and dated tech
  const builders = [];
  if (/elementor/i.test(html)) builders.push('Elementor');
  if (/js_composer|wpbakery|vc_row/i.test(html)) builders.push('WPBakery');
  if (/\/themes\/divi\/|et-core|et_pb_/i.test(html)) builders.push('Divi');
  if (/bb-plugin|fl-builder/i.test(html)) builders.push('Beaver Builder');
  if (/revslider|rev_slider/i.test(html)) builders.push('Revolution Slider');
  if (/wix\.com|wixstatic/i.test(html)) builders.push('Wix');
  if (/squarespace/i.test(html)) builders.push('Squarespace');
  if (/godaddy|img1\.wsimg\.com/i.test(html)) builders.push('GoDaddy Builder');
  out.builders = builders;

  const jq = html.match(/jquery(?:\.min)?\.js\?ver=(\d+\.\d+\.\d+)/i) || html.match(/jquery[-.](\d+\.\d+\.\d+)(?:\.min)?\.js/i);
  out.jquery = jq ? jq[1] : null;

  const years = [...html.matchAll(/(?:©|&copy;|&#169;|copyright)\s*(?:\d{4}\s*(?:-|–|&ndash;|&#8211;)\s*)?((?:19|20)\d{2})/gi)].map(m => +m[1]);
  out.copyrightYear = years.length ? Math.max(...years) : null;

  out.viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  out.oldTech = [];
  if ((h.match(/<table/g) || []).length >= 4 && !out.viewport) out.oldTech.push('table layout');
  if (/<font[\s>]/i.test(html)) out.oldTech.push('<font> tags');
  if (/<marquee|<blink/i.test(html)) out.oldTech.push('marquee/blink');
  if (/\.swf["'?]|shockwave-flash/i.test(html)) out.oldTech.push('Flash');
  if (/<frameset|<frame\s/i.test(html)) out.oldTech.push('frames');

  // SEO checks
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [])[1] || '';
  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  const ldjson = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join(' ');
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const withAlt = imgs.filter(t => /\balt=["'][^"']+["']/i.test(t)).length;
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ');
  const words = (text.match(/[A-Za-z]{2,}/g) || []).length;

  let sitemap = false;
  for (const p of ['/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap.xml']) {
    try {
      const s = await fetchWithTimeout(new URL(p, res.url).href, { headers: { 'User-Agent': BROWSER_UA } }, 8000);
      const body = s.ok ? (await s.text()).slice(0, 300) : '';
      if (s.ok && /<\?xml|<urlset|<sitemapindex/i.test(body)) { sitemap = true; break; }
    } catch { /* ignore */ }
  }

  out.seo = {
    title, titleLen: title.length, description: desc, descLen: desc.length, h1Count: h1s,
    schema: !!ldjson, localSchema: /LocalBusiness|Restaurant|Store|Dentist|Plumber|Electrician|HVACBusiness|HomeAndConstructionBusiness|AutoRepair|BeautySalon|HairSalon|LegalService|AccountingService|MedicalBusiness|ProfessionalService|FoodEstablishment|HealthAndBeautyBusiness/i.test(ldjson),
    canonical: /<link[^>]+rel=["']canonical["']/i.test(html),
    openGraph: /<meta[^>]+property=["']og:title["']/i.test(html),
    images: imgs.length, imagesWithAlt: withAlt,
    telLink: /href=["']tel:/i.test(html),
    noindex: /<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html) || /noindex/i.test(hdr('x-robots-tag')),
    sitemap, words,
  };
  state.analyses[url] = out; save();
  return out;
}

// ---------- step 3 (optional): Google PageSpeed Insights, free key ----------
async function pagespeed(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const key = state.config.psiKey;
  const qs = new URLSearchParams({ url, strategy: 'mobile' });
  for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) qs.append('category', c);
  if (key) qs.set('key', key);
  const r = await fetchWithTimeout('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + qs, {}, 120000);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'PageSpeed failed (' + r.status + ')');
  const lh = j.lighthouseResult || {};
  const cat = lh.categories || {};
  const a = lh.audits || {};
  const out = {
    url, checkedAt: new Date().toISOString(),
    performance: Math.round((cat.performance?.score ?? 0) * 100),
    seo: Math.round((cat.seo?.score ?? 0) * 100),
    accessibility: Math.round((cat.accessibility?.score ?? 0) * 100),
    bestPractices: Math.round((cat['best-practices']?.score ?? 0) * 100),
    lcp: a['largest-contentful-paint']?.displayValue || '',
    cls: a['cumulative-layout-shift']?.displayValue || '',
    screenshot: a['final-screenshot']?.details?.data || null,
    stack: (lh.stackPacks || []).map(s => s.title),
  };
  state.psi[url] = out; save();
  return out;
}

// ---------- web server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      switch (u.pathname) {
        case '/api/state':
          return send(res, 200, { categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])), hasPsiKey: !!state.config.psiKey, scans: state.scans, analyses: state.analyses, psi: state.psi, leads: state.leads });
        case '/api/scan': return send(res, 200, await scan(body));
        case '/api/analyze': return send(res, 200, await analyze(body.url));
        case '/api/pagespeed': return send(res, 200, await pagespeed(body.url));
        case '/api/lead':
          state.leads[body.id] = { status: body.status || 'new', note: String(body.note || '').slice(0, 5000), at: new Date().toISOString() };
          save(); return send(res, 200, { ok: true });
        case '/api/config':
          if (typeof body.psiKey === 'string') state.config.psiKey = body.psiKey.trim();
          save(); return send(res, 200, { hasPsiKey: !!state.config.psiKey });
        case '/api/scan/delete':
          state.scans = state.scans.filter(s => s.id !== body.id); save(); return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    }
    const file = path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream'));
  } catch (e) {
    send(res, 500, { error: e.message || String(e) });
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => console.log(`\n  Site Scout is running → http://localhost:${PORT}\n  (Leave this window open. Press Ctrl+C to stop.)\n`));
}
module.exports = { analyze, classifyWeb, releasesBehind, server, state };
