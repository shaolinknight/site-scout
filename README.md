# Site Scout (Cloudflare version)

Finds independent local businesses with no website, a social-only or free-builder page, a dead site, or an outdated WordPress site. It scores each site's design and SEO and tracks your outreach. It runs on Cloudflare's free Workers plan.

## How it's built

- `public/`: the app. Scanning, website checks and scoring all run in your browser.
- `src/worker.js`: a small relay. Browsers aren't allowed to read other websites directly, so the Worker fetches them and passes them along unread. It also hides your PageSpeed key and checks your passcode.
- `wrangler.jsonc`: tells Cloudflare how to deploy it.

## Deploy (one time)

1. **GitHub:** create a new repository named `site-scout` (private is fine). Upload everything in this folder, keeping the `src` and `public` folders as they are.
2. **Cloudflare:** go to Workers & Pages → Create → **Import a repository**, and pick `site-scout`. Leave the build settings at their defaults; the deploy command is `npx wrangler deploy`. Click Deploy.
   - It must be a **Worker**, not a Pages project, because the relay needs to run code.
3. **Set your passcode:** open the new Worker → Settings → Variables and Secrets → Add.
   - Type **Secret**, name `APP_PASSWORD`, and a value of your choosing. Required.
   - Optional: type **Secret**, name `PSI_KEY`, value = a free Google PageSpeed Insights API key. Without it, PageSpeed often fails on Google's shared quota.
4. Open your `site-scout.<your-subdomain>.workers.dev` link and enter the passcode. On iPhone, Share → Add to Home Screen.

After that, every change pushed to GitHub redeploys on its own.

## Use it

1. Enter a city or ZIP, pick categories, click **Scan area**.
2. Click **Check websites**, about 1–3 seconds per site.
3. Optional: **Run PageSpeed** adds Google's mobile scores and a screenshot, about 20 seconds per site.
4. Sort, filter, open **Details and notes**, and **Export CSV**.

Your scans and notes are saved in the browser you use. **Settings → Backup** downloads them; **Restore** loads them on another device.

## Scores

- **Design and SEO (0–100, higher = better site)**: see `public/scoring.js`.
- **Opportunity (0–100, higher = better lead)**: tune `WEIGHTS` and `opportunityScore()` in `public/scoring.js`.

## Good to know

- Business data comes from OpenStreetMap, which is free but incomplete. Click **Maps** to double-check a lead.
- Chains (anything tagged with a brand) are left out.
- Some sites block automated visits with a "checking your browser" screen. They show a **Bot wall** badge; check those by hand.
- Free-plan limits: 100,000 requests a day, far more than you'll use.
