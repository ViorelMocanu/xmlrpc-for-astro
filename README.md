# XML-RPC for Astro

A simple XML-RPC ping service for my personal Astro website.

It notifies XML-RPC endpoints and services when my site is updated, either via GitHub deployments or manual triggers.

## Create KV and wire it:

pnpx wrangler kv:namespace create XMLRPC_PING_KV

# paste the id into wrangler.toml

Set secrets:

npx wrangler secret put PING_SECRET

# if using GitHub polling:

npx wrangler secret put GH_TOKEN

# if using Cloudflare Pages polling:

npx wrangler secret put CF_API_TOKEN

Set vars (either in wrangler.toml or via dashboard):

SITE_NAME, SITE_URL, FEED_URL

PING_ENDPOINTS (JSON array string), optional

Detector:

GitHub: set DETECTOR=github, GH_REPO=owner/repo, GH_BRANCH=main

Cloudflare: set DETECTOR=cloudflare, CF_ACCOUNT_ID, CF_PAGES_PROJECT

Deploy the Worker:

pnpm deploy

(Optional) Manual trigger from anywhere (CI, terminal):

curl -X POST "https://<your-subdomain>.workers.dev" \
 -H "Authorization: Bearer <PING_SECRET>" \
 -H "Content-Type: application/json" \
 -d '{"siteName":"Viorel Mocanu","siteUrl":"https://www.viorelmocanu.ro","feedUrl":"https://www.viorelmocanu.ro/feed.xml"}'
