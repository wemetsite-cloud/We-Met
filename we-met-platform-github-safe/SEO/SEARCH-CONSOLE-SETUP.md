# We Met SEO implementation — 12 October 2026

Official site: https://wemetchat.com/

## What changed

- Unique homepage meta title, description, Open Graph and WebApplication structured data for We Met / WeMetChat, Malayalam voice chat and browser calling.
- Five **substantial, unique, indexable** information pages with self-canonical URLs and descriptive navigation. No thin keyword-stuffed doorway pages.
- Homepage content, explainer and five searchable frequently asked questions.
- 1,000 **research keywords** in `SEO/we-met-1000-keywords.csv`, clustered by intent with destination URL. They are **not** all injected into meta keywords or page body; Google ignores `meta keywords`, and forced repetition can harm search visibility.
- Refreshed sitemap with updated pages, canonical links, internal navigation and crawlable HTML.
- Publisher/developer citation corrected, founder identified as Sabith Salah Kp without homepage prominence.
- Calling information is truthful: modern desktop and mobile browsers, microphone access and wallet talk-time are required. We Met is not a dating, matchmaking, FRND or Omegle service.
- Refreshed service-worker asset cache version. The existing calling/payment/backend routes were deliberately preserved.

## After deployment

1. Deploy the project with the unchanged folder layout. Make sure `customer-site/` is the published Cloudflare Pages root and the `shared/` asset URLs are mapped as in your existing deployment.
2. Visit `https://wemetchat.com/sitemap.xml` and each of the five new pages. Confirm they return **HTTP 200**, not your SPA shell.
3. In Google Search Console for `wemetchat.com`, submit `https://wemetchat.com/sitemap.xml` under Sitemaps.
4. Use URL Inspection and Request Indexing for the homepage and top search guides. Check that Google-selected canonical matches the declared canonical, pages are indexed and rendered content is visible.
5. In Search Console Performance, monitor real queries and refine content from conversions and traffic. Don't make 1,000 duplicate URLs or promise a ranking.
6. Test an actual voice call using Chrome/Edge on desktop and an up-to-date mobile browser with microphone allowed; live successful calling requires running backend, a signed-in account, wallet credits, an available listener and healthy WebRTC signalling. SEO edits do **not** guarantee connectivity.
7. Update page copy if your platform, pricing or listening service changes; keep your legal policies accurate.

## Search strategy

Primary clusters: branded We Met and WeMetChat; Malayalam/Malayali language voice chat; private conversation and friendly listener calls; no app needed, desktop browser calling; India/Kerala queries; relevant category comparisons (clearly disclosing no affiliation or dating service). All founder references point to the official personal profile.

Relevant Google resources:
- https://developers.google.com/search/docs/fundamentals/seo-starter-guide
- https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
