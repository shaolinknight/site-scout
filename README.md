# Site Scout

An internal tool that scans an area for independent local businesses and sorts them into leads:

- **No website**, or only a **Facebook/Instagram/Yelp** page, or a **free builder subdomain** (Wix, GoDaddy and so on)
- **Dead or parked sites**
- **Outdated WordPress sites**, with the WordPress version, how many releases behind it is, the theme, plugins, page builder, and design and SEO scores

Everything runs on your computer and costs $0.

## Start it

1. Install **Node.js** (the free "LTS" version) from nodejs.org. You only do this once.
2. Unzip this folder somewhere you'll keep it.
3. Start it:
   - **Mac:** double-click `start.command`. If macOS blocks it, right-click it, choose Open, then Open again.
   - **Windows:** double-click `start.bat`.
   - **Or** in a terminal, inside this folder: `node server.js`
4. Your browser opens **http://localhost:4321**. Keep the small terminal window open while you use it.

## Use it

1. Enter a city or ZIP, pick a radius and categories, then click **Scan area**.
2. Click **Check websites**. It opens each business's homepage and detects WordPress, outdated signals and SEO gaps, about 1–3 seconds per site.
3. Optional: **Run PageSpeed** adds Google's mobile scores and a screenshot of each site (about 20 seconds per site, up to 50 at a time). Add a free key under **Settings** first. The Settings window explains how to get one.
4. Use the tabs, the **WordPress only** filter and sorting to find your best leads. Open **Details and notes** to see every check and log your outreach.
5. **Export CSV** saves the current view to a spreadsheet.

Scans, checks and notes are saved in `data/state.json`. Back up that file if you want to keep your lead notes.

## Scores

- **Design (0–100, higher = better site):** signals of an aged site, such as no mobile layout, an old copyright year, old jQuery, dated code, no HTTPS, an outdated WordPress version and old sliders. These are blended with PageSpeed results when you have them. Code can't judge looks, so glance at the screenshot before you pitch.
- **SEO (0–100):** 14 local-SEO checks, blended with Google's SEO score when you have it.
- **Opportunity (0–100, higher = better lead):** how worth pitching a business is. Tune it in `public/scoring.js` (the `WEIGHTS` and `opportunityScore` section), then reload the page. No rescan needed.

## Good to know

- Data comes from OpenStreetMap. It's free, but it misses some businesses, and a few listings that say "no website" do have one. Click **Maps** on a lead to double-check before you reach out.
- Chains (anything tagged with a brand) are left out on purpose.
- Some WordPress sites hide their version number. They still show as WordPress, and the other signals still count.
- Be polite with scan sizes: the free map servers ask for reasonable use. A 3–5 mile radius is a good default.
