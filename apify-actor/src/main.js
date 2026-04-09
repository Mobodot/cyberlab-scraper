import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const DEFAULT_START_URLS = [
  'https://cyberab.org/Catalog',
  'https://cyberab.org/SCF-Ecosystem/SCF-Marketplace',
  'https://cyberab.org/SCA-Ecosystem/SCA-Marketplace',
];

const MEMBER_URL_RE = /https?:\/\/cyberab\.org\/Member\/[A-Za-z0-9-]+/gi;

function safeLower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function extractMemberUrlsFromUnknownJson(payload) {
  const urls = new Set();
  const stack = [payload];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (typeof node === 'string') {
      const matches = node.match(MEMBER_URL_RE);
      if (matches) matches.forEach((url) => urls.add(url));
      continue;
    }

    if (Array.isArray(node)) {
      node.forEach((item) => stack.push(item));
      continue;
    }

    if (typeof node === 'object') {
      Object.values(node).forEach((value) => stack.push(value));
    }
  }

  return [...urls];
}

async function fetchWaybackMemberUrls(limit = 3000) {
  const waybackUrl = [
    'https://web.archive.org/cdx/search/cdx',
    '?url=cyberab.org/Member/*',
    '&output=json',
    '&fl=original',
    '&filter=statuscode:200',
    '&collapse=urlkey',
  ].join('');

  const response = await fetch(waybackUrl, {
    headers: {
      'user-agent': 'apify-cyberab-marketplace-scraper/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Wayback lookup failed with status ${response.status}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length <= 1) return [];

  const urls = rows
    .slice(1)
    .map((row) => (Array.isArray(row) ? row[0] : null))
    .filter((value) => typeof value === 'string')
    .map((value) => (value.startsWith('http') ? value : `https://${value}`))
    .filter((value) => value.includes('/Member/'))
    .slice(0, limit);

  return urls;
}

async function extractProfile(page, url) {
  const title = await page.title();
  const html = await page.content();
  const profilePath = new URL(url).pathname;

  const roleMatch = profilePath.match(/\/Member\/([A-Za-z0-9]+)-/);
  const idMatch = profilePath.match(/\/Member\/[A-Za-z0-9]+-(\d+)-/);

  const emails = [...new Set(html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])];
  const phones = [
    ...new Set(html.match(/(?:\+1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) ?? []),
  ];

  const websites = await page.$$eval('a[href]', (anchors) => {
    return anchors
      .map((anchor) => anchor.getAttribute('href') || '')
      .filter((href) => href.startsWith('http'));
  });

  const externalWebsites = [...new Set(websites.filter((href) => !safeLower(href).includes('cyberab.org')))].slice(
    0,
    5,
  );

  const description = await page
    .$eval('meta[name="description"]', (el) => el.getAttribute('content') || '')
    .catch(() => '');

  return {
    source: 'cyberab.org',
    sourceUrl: url,
    scrapedAt: new Date().toISOString(),
    organizationName: title.replace(/\s*\|\s*CyberAB\s*$/i, '').trim(),
    roleCode: roleMatch?.[1] || null,
    cyberAbListingId: idMatch?.[1] || null,
    profilePath,
    description: description.trim() || null,
    contactEmails: emails,
    contactPhones: phones,
    externalWebsites,
  };
}

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const startUrls = (input.startUrls ?? DEFAULT_START_URLS).filter(Boolean);
const includeWaybackSeeds = input.includeWaybackSeeds ?? true;
const waybackSeedLimit = Number(input.waybackSeedLimit ?? 2000);
const maxRequestsPerCrawl = Number(input.maxRequestsPerCrawl ?? 5000);

const requestQueue = await Actor.openRequestQueue();
const discoveredProfileUrls = new Set();
const discoveredApiEndpoints = new Set();

for (const url of startUrls) {
  await requestQueue.addRequest({ url, userData: { label: 'CATALOG' } });
}

if (includeWaybackSeeds) {
  try {
    const waybackUrls = await fetchWaybackMemberUrls(waybackSeedLimit);
    for (const url of waybackUrls) {
      if (discoveredProfileUrls.has(url)) continue;
      discoveredProfileUrls.add(url);
      await requestQueue.addRequest({ url, userData: { label: 'PROFILE', discovery: 'wayback' } });
    }
    log.info(`Loaded ${waybackUrls.length} profile seeds from Wayback.`);
  } catch (error) {
    log.warning(`Wayback seed loading failed: ${error.message}`);
  }
}

const crawler = new PlaywrightCrawler({
  requestQueue,
  maxRequestsPerCrawl,
  maxRequestRetries: 4,
  requestHandlerTimeoutSecs: 120,
  navigationTimeoutSecs: 120,
  preNavigationHooks: [
    async ({ page }) => {
      page.on('response', async (response) => {
        const responseUrl = response.url();
        const contentType = safeLower(response.headers()['content-type']);

        if (!safeLower(responseUrl).includes('cyberab.org')) return;

        if (safeLower(responseUrl).includes('/api/') || safeLower(responseUrl).includes('catalog')) {
          discoveredApiEndpoints.add(responseUrl.split('?')[0]);
        }

        if (!contentType.includes('json')) return;

        try {
          const json = await response.json();
          const memberUrls = extractMemberUrlsFromUnknownJson(json);
          for (const memberUrl of memberUrls) {
            if (discoveredProfileUrls.has(memberUrl)) continue;
            discoveredProfileUrls.add(memberUrl);
            await requestQueue.addRequest({
              url: memberUrl,
              userData: { label: 'PROFILE', discovery: 'network_json' },
            });
          }
        } catch {
          // Ignore noisy JSON parse failures from non-JSON endpoints.
        }
      });
    },
  ],
  requestHandler: async ({ request, page, enqueueLinks }) => {
    const label = request.userData.label ?? 'CATALOG';

    if (label === 'CATALOG') {
      await page.waitForLoadState('networkidle');

      await enqueueLinks({
        selector: 'a[href*="/Member/"]',
        label: 'PROFILE',
        transformRequestFunction: (req) => {
          req.userData.discovery = 'catalog_link';
          return req;
        },
      });

      const links = await page.$$eval('a[href*="/Member/"]', (nodes) =>
        nodes.map((node) => new URL(node.getAttribute('href') || '', window.location.origin).href),
      );
      for (const url of links) discoveredProfileUrls.add(url);
      return;
    }

    await page.waitForLoadState('domcontentloaded');
    const profile = await extractProfile(page, request.loadedUrl ?? request.url);
    await Actor.pushData(profile);
  },
  failedRequestHandler: async ({ request }) => {
    await Actor.pushData({
      source: 'cyberab.org',
      sourceUrl: request.url,
      scrapeStatus: 'failed',
      retries: request.retryCount,
      scrapedAt: new Date().toISOString(),
    });
  },
});

await crawler.run();

await Actor.setValue('ENDPOINT_DISCOVERY', {
  discoveredApiEndpoints: [...discoveredApiEndpoints].sort(),
  discoveredProfileCount: discoveredProfileUrls.size,
  finishedAt: new Date().toISOString(),
});

log.info('Scrape finished', {
  discoveredProfileCount: discoveredProfileUrls.size,
  discoveredApiEndpointCount: discoveredApiEndpoints.size,
});

await Actor.exit();
