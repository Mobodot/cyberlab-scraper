# CyberAB Marketplace Scraper (Apify)

Production-oriented scraper for CyberAB marketplace profiles.

## What it extracts

- Organization name
- Role code from profile URL (for example `RPO`, `C3PAO`)
- CyberAB listing id from profile URL
- Profile URL and path
- Meta description (when present)
- Contact emails found on page HTML
- Contact phones found on page HTML
- External websites linked from the profile page
- Scrape timestamp

## Reliability design

- Uses `PlaywrightCrawler` to handle JS-rendered pages.
- Uses request queue and retries (`maxRequestRetries: 4`) for transient failures.
- Captures API/XHR responses and extracts `/Member/` URLs from JSON payloads.
- Persists discovered endpoint inventory to key-value store (`ENDPOINT_DISCOVERY`).
- Optional Wayback CDX seed loading to reduce dependence on current UI structure.
- Max request ceiling (`maxRequestsPerCrawl`) to constrain blast radius.

## Files

- `src/main.mjs`: actor entrypoint
- `input_schema.json`: Apify input contract
- `actor.json`: actor metadata

## Deploy to Apify

1. Create a new actor from source code.
2. Upload the `apify-actor/` directory content.
3. Ensure `npm install` runs in build phase (project already depends on `apify`).
4. Set entrypoint to `src/main.mjs`.
5. Run with default input first, then tune `maxRequestsPerCrawl`.

## Output

- Dataset items: one row per profile (or failure row if request exhausted retries).
- Key-value store record: `ENDPOINT_DISCOVERY` with discovered API endpoints and profile count.

## Notes

- Respect target site terms and policies before high-scale runs.
- Keep crawler frequency aligned with source volatility (daily or weekly schedule).