# Live visitor counter

The badge above the main signup button counts browser IDs whose visible page sent a heartbeat within 60 seconds. It updates every 20 seconds. Tabs on the same origin share a localStorage ID; separate devices/browsers count separately. This is an approximate audience count, not a count of registrations or verified people. Automated clients can affect it.

## Activate on Vercel

1. Connect an Upstash Redis database to this Vercel project using Storage / Marketplace.
2. Set server-only Production environment variables:
   - UPSTASH_REDIS_REST_URL
   - UPSTASH_REDIS_REST_TOKEN
3. Redeploy the project after adding the variables. Do not paste the token into HTML or GitHub.
4. Open the landing page: the badge should show at least 1. Open another browser/device and wait up to 20 seconds for the count to increase.
5. Hide/close the second page and wait 60–80 seconds for the count to drop.

The endpoint returns 503 when configuration or Redis is unavailable; the frontend hides the badge instead of displaying a fabricated or stale count. No names, phone numbers or IP addresses are stored by this counter. Random browser IDs expire from the active set after 60 seconds; the entire Redis key expires after 120 seconds without traffic. Clear browser storage to reset its persistent random ID.

At 1,000 concurrent visitors, 20-second polling generates about 3,000 function requests per minute and multiple Redis commands per request. Check provider quotas and costs before a large campaign.

GitHub Pages only serves static files and cannot run this endpoint; use the Vercel deployment.
