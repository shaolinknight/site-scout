// Site Scout scoring. Scores are worked out in the browser from the saved scan
// data, so changing anything here takes effect on reload. No rescan needed.
// All scores run 0–100. Design and SEO: higher = better site.
// Opportunity: higher = better lead for you.

const THIS_YEAR = new Date().getFullYear();

// Each check: [label, passed?, weight]. Returns { score, checks }.
function seoScore(a, psi) {
  if (!a || !a.seo) return null;
  const s = a.seo;
  const checks = [
    ['Page title, 10–65 characters', s.titleLen >= 10 && s.titleLen <= 65, 12],
    ['Meta description, 50–170 characters', s.descLen >= 50 && s.descLen <= 170, 12],
    ['Exactly one H1 heading', s.h1Count === 1, 10],
    ['Local business schema markup', s.localSchema, 12],
    ['Any structured data', s.schema, 4],
    ['Sitemap found', s.sitemap, 8],
    ['Canonical tag', s.canonical, 5],
    ['Social share tags (Open Graph)', s.openGraph, 5],
    ['Most images have alt text', s.images === 0 || s.imagesWithAlt / s.images >= 0.8, 8],
    ['Tap-to-call phone link', s.telLink, 8],
    ['Secure (HTTPS)', a.https, 8],
    ['Mobile viewport tag', a.viewport, 8],
    ['Homepage has 300+ words', s.words >= 300, 6],
    ['Not blocked from Google (no noindex)', !s.noindex, 10],
  ];
  const total = checks.reduce((t, c) => t + c[2], 0);
  let score = Math.round(checks.reduce((t, c) => t + (c[1] ? c[2] : 0), 0) / total * 100);
  if (psi) score = Math.round(score * 0.6 + psi.seo * 0.4);
  return { score, checks };
}

// Design can't be judged perfectly by code. These are signals of an aged or
// neglected site; check the PageSpeed screenshot before you pitch.
function designScore(a, psi) {
  if (!a || a.dead || !a.ok) return null;
  const flags = [];
  let score = 100;
  const hit = (pts, label) => { score -= pts; flags.push([label, pts]); };
  if (!a.viewport) hit(30, 'Not built for phones (no viewport tag)');
  if (a.copyrightYear && a.copyrightYear < THIS_YEAR - 1) hit(Math.min(25, (THIS_YEAR - a.copyrightYear) * 4), 'Footer copyright says ' + a.copyrightYear);
  if (a.jquery) {
    const [maj, min] = a.jquery.split('.').map(Number);
    if (maj < 2 && min < 12) hit(15, 'Very old jQuery ' + a.jquery);
    else if (maj < 3) hit(8, 'Old jQuery ' + a.jquery);
  }
  if (a.oldTech && a.oldTech.length) hit(20, 'Dated code: ' + a.oldTech.join(', '));
  if (!a.https) hit(10, 'No HTTPS (browsers show "Not secure")');
  if (a.wp && a.wp.behind != null && a.wp.behind > 0) hit(Math.min(24, a.wp.behind * 3), 'WordPress ' + a.wp.version + ' is ' + a.wp.behind + ' releases behind');
  if (a.builders && a.builders.includes('Revolution Slider')) hit(5, 'Uses an old-style image slider');
  score = Math.max(0, score);
  if (psi) score = Math.round(score * 0.6 + ((psi.performance + psi.accessibility + psi.bestPractices) / 3) * 0.4);
  return { score, flags };
}

// ─────────────────────────────────────────────────────────────────────────
// Opportunity score: how good a lead this business is for you.
// This is your sales judgment in code: tune the numbers to how you sell.
//   b   = the business (presence: 'none' | 'social' | 'weak' | 'site', phone, email)
//   a   = website analysis, or null if not analyzed yet
//   seo = seoScore(...) result, design = designScore(...) result (or null)
// ─────────────────────────────────────────────────────────────────────────
const WEIGHTS = {
  noWebsite: 70,     // no site at all
  socialOnly: 80,    // only Facebook/Instagram/Yelp: busy enough to post, still no site
  freeBuilder: 65,   // Wix/GoDaddy/etc. free subdomain
  deadSite: 85,      // site down, erroring, or parked
  wordpressBonus: 10,// WordPress = easiest for you to take over
  phoneBonus: 5,     // you can actually reach them
};

function opportunityScore(b, a, seo, design) {
  let score;
  if (b.presence === 'none') score = WEIGHTS.noWebsite;
  else if (b.presence === 'social') score = WEIGHTS.socialOnly;
  else if (b.presence === 'weak') score = WEIGHTS.freeBuilder;
  else if (!a) return null; // has a site we haven't checked yet
  else if (a.dead || a.parked || !a.ok) score = WEIGHTS.deadSite;
  else {
    // Worse site = better lead. Design counts a bit more than SEO, since it's
    // what the owner sees and what you're pitching first.
    const d = design ? design.score : 50, s = seo ? seo.score : 50;
    score = 100 - (d * 0.55 + s * 0.45);
    if (a.wp && a.wp.detected) score += WEIGHTS.wordpressBonus;
  }
  if (b.phone) score += WEIGHTS.phoneBonus;
  return Math.max(0, Math.min(100, Math.round(score)));
}

window.Scoring = { seoScore, designScore, opportunityScore, WEIGHTS };
