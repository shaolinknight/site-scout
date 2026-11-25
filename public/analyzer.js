// Site Scout: scanning and website analysis, run in your browser.
// The Worker (src/worker.js) only relays requests; all the logic lives here.

// ---------- talking to the relay ----------
const Relay = {
  pass: '',
  async raw(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), 'x-pass': this.pass } });
    if (r.status === 401) { const e = new Error('Wrong passcode'); e.code = 401; throw e; }
    return r;
  },
  async json(path, opts) {
    const r = await this.raw(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((typeof j.error === 'string' ? j.error : j.error?.message) || 'Request failed (' + r.status + ')');
    return j;
  },
};

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

// ---------- step 1: find businesses ----------
// The free map-data (Overpass) servers allow browser requests directly, and
// they can be slow when busy: often 30–90 seconds. So the browser asks them
// itself, waits up to 3 minutes per server, and reports the wait as it goes.
// (Going through the Worker relay added a second timeout that cut it short.)
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function overpassQuery(query, onProgress = () => {}) {
  let lastErr = 'The free map-data servers are busy right now.';
  for (let i = 0; i < OVERPASS.length; i++) {
    const host = new URL(OVERPASS[i]).hostname, start = Date.now();
    const tick = setInterval(() => onProgress(`Waiting for map data${i ? ' (backup server ' + i + ')' : ''}… ${Math.round((Date.now() - start) / 1000)}s. Busy times can take 1–2 minutes.`), 1000);
    try {
      const r = await fetch(OVERPASS[i], { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(180000) });
      if (r.ok) return await r.json();
      lastErr = r.status === 429 ? 'The map-data server says too many requests. Wait a minute, then scan again.' : `Map server ${host} answered ${r.status}.`;
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? 'The free map-data servers are overloaded right now. Try again in a few minutes, or use a smaller radius.' : `Could not reach ${host}.`;
    } finally { clearInterval(tick); }
  }
  throw new Error(lastErr);
}

async function scanArea({ location, radiusMiles = 3, categories = [] }, onProgress) {
  if (!location) throw new Error('Enter a city or ZIP code.');
  const cats = categories.filter(c => CATEGORIES[c]);
  if (!cats.length) throw new Error('Pick at least one category.');
  const geo = await Relay.json('/api/geocode?q=' + encodeURIComponent(location));
  if (!geo.length) throw new Error('Could not find "' + location + '". Try a city and state, like "West Jordan, UT", or a ZIP code.');
  const center = { lat: +geo[0].lat, lon: +geo[0].lon };
  const meters = Math.round(Math.min(Math.max(+radiusMiles || 3, 0.5), 25) * 1609);
  const parts = [];
  for (const c of cats) for (const [k, v] of CATEGORIES[c].tags)
    parts.push(`nwr["${k}"~"^(${v})$"]["name"](around:${meters},${center.lat},${center.lon});`);
  const data = await overpassQuery(`[out:json][timeout:170];(${parts.join('')});out center tags;`, onProgress);

  const businesses = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    if (t.brand || t['brand:wikidata']) continue; // chains aren't prospects
    let cat = null;
    for (const c of cats) if (CATEGORIES[c].tags.some(([k, v]) => t[k] && new RegExp('^(' + v + ')$').test(t[k]))) { cat = c; break; }
    const web = classifyWeb(t);
    businesses.push({
      id: el.type + '/' + el.id,
      name: t.name, category: cat,
      kind: (t.amenity || t.shop || t.craft || t.office || t.leisure || t.healthcare || '').replace(/_/g, ' '),
      address: [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:city']].filter(Boolean).join(', '),
      phone: t.phone || t['contact:phone'] || '',
      email: t.email || t['contact:email'] || '',
      presence: web.presence, url: web.url,
    });
  }
  return { id: Date.now().toString(36), at: new Date().toISOString(), location, label: geo[0].display_name, radiusMiles: +radiusMiles, categories: cats, businesses };
}

// ---------- step 1b: find websites the map data is missing ----------
// OpenStreetMap often has no website listed even when the business has one.
// Many small businesses own the obvious domain for their name, so we guess
// likely domains, check which exist (free DNS lookup), and count a site only
// if its page shows the business's phone number, or its name plus its city.
const FILLER = new Set(['the', 'llc', 'inc', 'co', 'corp', 'ltd', 'pllc', 'pc', 'company', 'and', 'of']);
const GENERIC = new Set(['auto', 'repair', 'service', 'services', 'salon', 'spa', 'shop', 'store', 'cafe', 'restaurant', 'grill', 'bar', 'plumbing', 'electric', 'heating', 'cooling', 'air', 'construction', 'landscaping', 'dental', 'family', 'center', 'studio', 'nails', 'hair', 'barber', 'barbershop', 'care', 'clinic', 'body', 'tire', 'tires', 'and', 'utah', 'home']);
const slugWords = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

function domainCandidates(name, city) {
  const words = slugWords(name).filter(w => !['llc', 'inc', 'corp', 'ltd', 'pllc', 'pc'].includes(w));
  const core = words.filter(w => w !== 'the');
  const noAnd = core.filter(w => w !== 'and');
  const c = slugWords(city || '').join('');
  const bases = new Set([core.join(''), noAnd.join(''), core.join('-')]);
  if (words[0] === 'the') bases.add(words.join('')); // "The Hair Lounge" → thehairlounge
  if (noAnd.length > 2 && GENERIC.has(noAnd[noAnd.length - 1])) bases.add(noAnd.slice(0, -1).join('')); // "major league auto repair" → majorleagueauto
  if (c) bases.add(noAnd.join('') + c);
  const out = [];
  const ok = b => b.replace(/-/g, '').length >= 5;
  for (const b of bases) if (ok(b)) for (const tld of ['.com', '.net']) out.push(b + tld);
  if (ok(core.join(''))) for (const tld of ['.co', '.biz', '.us']) out.push(core.join('') + tld);
  return [...new Set(out)].slice(0, 12);
}

async function domainExists(d) {
  try {
    const j = await fetch('https://cloudflare-dns.com/dns-query?type=A&name=' + d, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) }).then(r => r.json());
    return j.Status === 0 && (j.Answer || []).length > 0;
  } catch { return false; }
}

// Does this page belong to this business? Returns 'phone', 'name', or null.
function pageMatches(html, b, city) {
  const head = html.slice(0, 400000);
  if (/domain (is )?for sale|buy this domain|parked (free|domain)|this domain may be for sale/i.test(head.slice(0, 20000))) return null;
  const digits = (b.phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length === 10) {
    const re = new RegExp(digits.slice(0, 3) + '\\D{0,3}' + digits.slice(3, 6) + '\\D{0,3}' + digits.slice(6));
    if (re.test(head)) return 'phone';
  }
  const text = head.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').toLowerCase();
  const key = slugWords(b.name).filter(w => !FILLER.has(w) && w.length > 2);
  const distinctive = key.filter(w => !GENERIC.has(w));
  const need = distinctive.length ? distinctive : key;
  const nameHit = need.length && need.every(w => text.includes(w));
  const cityHit = city && text.includes(city.toLowerCase());
  const streetNo = (b.address.match(/^\d+/) || [])[0];
  const addrHit = streetNo && b.address && text.includes(streetNo);
  return nameHit && (cityHit || addrHit) ? 'name' : null;
}

async function findWebsite(b, cityHint) {
  const city = (b.address.split(',').pop() || '').trim() || cityHint;
  const tried = [];
  for (const d of domainCandidates(b.name, city)) {
    if (!(await domainExists(d))) continue;
    tried.push(d);
    const page = await getPage('http://' + d + '/');
    if (page.error || !page.html) continue;
    const how = pageMatches(page.html, b, city);
    if (how) return { url: page.finalUrl || 'http://' + d + '/', how, tried };
  }
  return { url: null, tried };
}

// ---------- step 2: analyze a website ----------
async function getPage(url) {
  const r = await Relay.raw('/api/page?url=' + encodeURIComponent(url));
  if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: j.error || 'Site did not load', dead: !!j.dead || r.status === 502 }; }
  const hdr = {};
  for (const [k, v] of r.headers) if (k.startsWith('x-h-')) hdr[k.slice(4)] = v;
  return { status: +r.headers.get('x-status'), finalUrl: r.headers.get('x-final-url'), headers: hdr, html: (await r.text()).slice(0, 3e6) };
}

let latestWp = null;
async function latestWordPress() {
  if (latestWp) return latestWp;
  try { latestWp = (await Relay.json('/api/wplatest')).offers?.[0]?.current || null; } catch { /* leave null */ }
  return latestWp;
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
const uniq = arr => [...new Set(arr)];

async function analyzeSite(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const out = { url, checkedAt: new Date().toISOString(), ok: false };
  const page = await getPage(url);
  if (page.error) return { ...out, error: page.error, dead: page.dead };
  const { html } = page, h = html.toLowerCase(), hdr = n => page.headers[n] || '';
  out.status = page.status; out.finalUrl = page.finalUrl;
  out.https = page.finalUrl.startsWith('https://');
  out.ok = page.status >= 200 && page.status < 400;
  if (!out.ok) { out.error = 'Site returned an error (' + page.status + ')'; out.dead = page.status >= 404; }

  // Cloudflare/Sucuri "checking your browser" pages hide the real site
  out.blocked = /cf-browser-verification|challenge-platform|just a moment\.\.\.|sucuri website firewall|attention required/i.test(html.slice(0, 20000)) && html.length < 80000;
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
      v = mostCommon([...html.matchAll(/\/wp-includes\/[^"'\s>]+?\?ver=(\d+\.\d+(?:\.\d+)?)/gi)].map(m => m[1]));
      if (v) source = 'core file versions';
    }
    if (!v) {
      const feed = await getPage(new URL('/feed/', page.finalUrl).href).catch(() => ({}));
      const fv = ((feed.html || '').match(/wordpress\.org\/\?v=(\d+\.\d+(?:\.\d+)?)/i) || [])[1];
      if (fv) { v = fv; source = 'RSS feed'; }
    }
    const latest = await latestWordPress();
    Object.assign(out.wp, {
      version: v || null, versionSource: source, latest,
      behind: releasesBehind(v, latest),
      theme: (html.match(/\/wp-content\/themes\/([a-z0-9_.-]+)\//i) || [])[1] || null,
      plugins: uniq([...html.matchAll(/\/wp-content\/plugins\/([a-z0-9_.-]+)\//gi)].map(m => m[1].toLowerCase())).slice(0, 40),
    });
    // Patch-only gaps don't count: WordPress installs those by itself
    out.wp.outdated = out.wp.behind != null ? out.wp.behind > 0 : null;
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
  if (/img1\.wsimg\.com/i.test(html)) builders.push('GoDaddy Builder');
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

  // SEO
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [])[1] || '';
  const ldjson = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join(' ');
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ');
  let sitemap = false;
  try { sitemap = (await Relay.json('/api/sitemap?url=' + encodeURIComponent(page.finalUrl))).found; } catch { /* ignore */ }
  out.seo = {
    title, titleLen: title.length, description: desc, descLen: desc.length,
    h1Count: (html.match(/<h1[\s>]/gi) || []).length,
    schema: !!ldjson,
    localSchema: /LocalBusiness|Restaurant|Store|Dentist|Plumber|Electrician|HVACBusiness|HomeAndConstructionBusiness|AutoRepair|BeautySalon|HairSalon|LegalService|AccountingService|MedicalBusiness|ProfessionalService|FoodEstablishment|HealthAndBeautyBusiness/i.test(ldjson),
    canonical: /<link[^>]+rel=["']canonical["']/i.test(html),
    openGraph: /<meta[^>]+property=["']og:title["']/i.test(html),
    images: imgs.length, imagesWithAlt: imgs.filter(t => /\balt=["'][^"']+["']/i.test(t)).length,
    telLink: /href=["']tel:/i.test(html),
    noindex: /<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html) || /noindex/i.test(hdr('x-robots-tag')),
    sitemap, words: (text.match(/[A-Za-z]{2,}/g) || []).length,
  };
  return out;
}

// ---------- step 3 (optional): PageSpeed ----------
async function pageSpeed(url) {
  const j = await Relay.json('/api/psi?url=' + encodeURIComponent(url));
  const lh = j.lighthouseResult || {}, cat = lh.categories || {}, a = lh.audits || {};
  const pct = c => Math.round((c?.score ?? 0) * 100);
  return {
    url, checkedAt: new Date().toISOString(),
    performance: pct(cat.performance), seo: pct(cat.seo), accessibility: pct(cat.accessibility), bestPractices: pct(cat['best-practices']),
    lcp: a['largest-contentful-paint']?.displayValue || '',
    screenshot: a['final-screenshot']?.details?.data || null,
  };
}

window.Scout = { Relay, CATEGORIES, scanArea, analyzeSite, pageSpeed, classifyWeb, releasesBehind, findWebsite, domainCandidates, pageMatches };
