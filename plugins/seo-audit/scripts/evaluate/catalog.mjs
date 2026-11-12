/**
 * Every rule the audit can raise. The id prefix is the check group; severity is the default and
 * a rule may raise it for key pages. Summaries are the plain statement of the problem.
 */
export const RULES = {
  // Reachability
  'reach.home-unreachable': { severity: 'critical', summary: 'The home page does not return 200' },
  'reach.http-not-redirected': { severity: 'high', summary: 'http:// does not redirect to https://' },
  'reach.host-variant-not-redirected': {
    severity: 'medium',
    summary: 'The www / non-www twin of the host does not redirect to the main host',
  },
  'reach.host-redirect-chain': {
    severity: 'low',
    summary: 'A host variant needs more than one redirect to reach the main host',
  },
  'reach.tls-invalid': { severity: 'critical', summary: 'The TLS certificate is not trusted' },
  'reach.tls-expiring': { severity: 'high', summary: 'The TLS certificate expires soon' },
  'reach.hsts-missing': { severity: 'low', summary: 'No Strict-Transport-Security header on the home page' },
  'reach.robots-unavailable': {
    severity: 'critical',
    summary: 'robots.txt fails or returns 5xx; crawlers treat the whole site as disallowed',
  },
  'reach.robots-missing': { severity: 'info', summary: 'There is no robots.txt' },
  'reach.robots-not-text': {
    severity: 'medium',
    summary: 'The robots.txt URL returns an HTML page instead of a robots file',
  },
  'reach.robots-blocks-key-page': {
    severity: 'critical',
    summary: 'robots.txt disallows a key page for Googlebot',
  },
  'reach.sitemap-missing': { severity: 'medium', summary: 'No sitemap could be fetched' },
  'reach.sitemap-invalid': { severity: 'high', summary: 'A sitemap file is empty or not valid sitemap XML' },
  'reach.sitemap-not-in-robots': { severity: 'low', summary: 'The sitemap is not declared in robots.txt' },
  'reach.sitemap-url-not-200': {
    severity: 'high',
    summary: 'A URL listed in the sitemap redirects or does not return 200',
  },
  'reach.sitemap-url-blocked': {
    severity: 'medium',
    summary: 'A URL listed in the sitemap is disallowed in robots.txt',
  },
  'reach.sitemap-url-noindex': { severity: 'medium', summary: 'A URL listed in the sitemap is noindex' },
  'reach.sitemap-url-not-canonical': {
    severity: 'medium',
    summary: 'A URL listed in the sitemap declares a different canonical URL',
  },
  'reach.soft-404': {
    severity: 'high',
    summary: 'A URL that does not exist returns 200 instead of 404',
  },
  'reach.page-error': { severity: 'high', summary: 'A page returns 5xx or fails to load' },
  'reach.redirect-chain': { severity: 'low', summary: 'A URL redirects through more than one hop' },

  // Indexability
  'index.noindex': {
    severity: 'high',
    summary: 'A page is noindex and is not listed under expect.noindex in the config',
  },
  'index.canonical-missing': { severity: 'medium', summary: 'A page has no usable canonical link' },
  'index.canonical-multiple': { severity: 'high', summary: 'A page has more than one canonical link' },
  'index.canonical-other-host': { severity: 'high', summary: 'The canonical points to another host' },
  'index.canonical-not-self': { severity: 'low', summary: 'The canonical points to a different URL of the site' },
  'index.canonical-target-not-200': {
    severity: 'high',
    summary: 'The canonical points to a URL that redirects or does not return 200',
  },
  'index.duplicate-title': { severity: 'medium', summary: 'Several indexable pages share the same title' },
  'index.duplicate-description': {
    severity: 'low',
    summary: 'Several indexable pages share the same meta description',
  },
  'index.hreflang-invalid': { severity: 'medium', summary: 'hreflang uses an invalid language code' },
  'index.hreflang-no-return-link': {
    severity: 'medium',
    summary: 'An hreflang alternate does not link back to this page',
  },

  // On-page
  'onpage.title-missing': { severity: 'high', summary: 'A page has no title' },
  'onpage.title-length': { severity: 'low', summary: 'The title is too short or too long' },
  'onpage.description-missing': { severity: 'medium', summary: 'A page has no meta description' },
  'onpage.description-length': { severity: 'low', summary: 'The meta description is too short or too long' },
  'onpage.h1-missing': { severity: 'medium', summary: 'A page has no h1' },
  'onpage.h1-multiple': { severity: 'low', summary: 'A page has more than one h1' },
  'onpage.lang-missing': { severity: 'medium', summary: 'The html element has no lang attribute' },
  'onpage.viewport-missing': { severity: 'high', summary: 'A page has no viewport meta tag' },
  'onpage.image-alt-missing': { severity: 'low', summary: 'Images without an alt attribute' },
  'onpage.og-incomplete': { severity: 'low', summary: 'Open Graph title, description or image is missing' },
  'onpage.broken-internal-link': { severity: 'high', summary: 'An internal link leads to a 4xx page' },
  'onpage.link-to-redirect': { severity: 'low', summary: 'An internal link leads to a URL that redirects' },
  'onpage.orphan-page': {
    severity: 'low',
    summary: 'A page is in the sitemap but cannot be reached by links from the home page',
  },
  'onpage.anchor-without-href': {
    severity: 'info',
    summary: 'Anchors without href: crawlers do not follow them',
  },

  // Structured data
  'schema.jsonld-invalid': { severity: 'medium', summary: 'A JSON-LD block is not valid JSON' },
  // Low: the page is indexed as before, it only stays ineligible for the rich result.
  'schema.missing-required': {
    severity: 'low',
    summary: 'Structured data lacks a property Google requires for the rich result',
  },
  'schema.no-rich-result': {
    severity: 'info',
    summary: 'Structured data of a type that no longer earns a rich result in Google',
  },

  // Rendering in a browser
  'render.load-failed': { severity: 'high', summary: 'A page fails to load in a browser' },
  'render.blank-page': { severity: 'high', summary: 'A page renders almost no text in a browser' },
  'render.selector-missing': {
    severity: 'high',
    summary: 'The element named in browser.expectSelector is not on the rendered page',
  },
  'render.js-error': {
    severity: 'medium',
    summary: 'An uncaught JavaScript error is thrown while the page loads',
  },
  'render.request-failed': {
    severity: 'medium',
    summary: 'A request the page makes while loading fails',
  },
  'render.head-changed-by-js': {
    severity: 'high',
    summary: 'JavaScript changes the title, canonical or robots directive that the HTML declares',
  },
  'render.head-added-by-js': {
    severity: 'medium',
    summary: 'The title, description or canonical exists only after JavaScript runs',
  },
  'render.content-needs-js': {
    severity: 'medium',
    summary: 'Most of the page text appears only after JavaScript runs',
  },
  'render.links-need-js': { severity: 'medium', summary: 'Most links appear only after JavaScript runs' },
  'render.never-idle': { severity: 'info', summary: 'The page never stops making network requests' },

  // Accessibility (one finding per axe-core rule; the summary is replaced by that rule's text)
  'a11y.violation': { severity: 'medium', summary: 'An accessibility rule is violated' },

  // Performance
  'perf.lab-failed': { severity: 'info', summary: 'Lighthouse could not measure a page' },
  'perf.lab-score': { severity: 'medium', summary: 'The Lighthouse performance score is low' },
  'perf.lab-lcp': { severity: 'medium', summary: 'Largest Contentful Paint is slow in the lab' },
  'perf.lab-tbt': { severity: 'medium', summary: 'Total Blocking Time is high in the lab' },
  'perf.lab-cls': { severity: 'medium', summary: 'Cumulative Layout Shift is high in the lab' },
  'perf.field-lcp': { severity: 'medium', summary: 'Real users get a slow Largest Contentful Paint' },
  'perf.field-inp': { severity: 'medium', summary: 'Real users get a slow Interaction to Next Paint' },
  'perf.field-cls': { severity: 'medium', summary: 'Real users get a high Cumulative Layout Shift' },
  'perf.field-ttfb': { severity: 'low', summary: 'Real users get a slow server response' },

  // Search Console
  'search.clicks-drop': {
    severity: 'high',
    summary: 'Clicks from Google Search fell sharply against the previous week',
  },
  'search.page-clicks-drop': {
    severity: 'medium',
    summary: 'A page lost most of its clicks from Google Search against the previous week',
  },
  'search.not-indexed': { severity: 'high', summary: 'Google reports a key page as not indexed' },
  'search.google-canonical-differs': {
    severity: 'medium',
    summary: 'Google chose a different canonical URL from the one the page declares',
  },
  'search.sitemap-errors': { severity: 'medium', summary: 'Search Console reports errors in a submitted sitemap' },

  // LLM access
  'llm.robots-policy-mismatch': {
    severity: 'high',
    summary: 'robots.txt treats an AI crawler differently from the policy in the config',
  },
  'llm.bot-blocked-by-server': {
    severity: 'medium',
    summary: 'The server answers an AI crawler user agent differently from a browser, though robots.txt allows it',
  },
  'llm.raw-html-thin': {
    severity: 'medium',
    summary: 'The HTML has almost no text before JavaScript runs; crawlers that do not render see an empty page',
  },
  'llm.llms-txt-missing': { severity: 'info', summary: 'There is no llms.txt' },
  'llm.llms-txt-invalid': { severity: 'low', summary: 'llms.txt does not start with a "# Title" line' },
  'llm.llms-txt-broken-link': { severity: 'low', summary: 'llms.txt links to URLs that redirect or fail' },
};

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
