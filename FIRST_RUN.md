# Cursor + xmlrpc-for-astro — First Run Guide

This bundle gives you a ready-to-go setup to work on the **XML‑RPC Pinger for Astro** Worker with **Cursor**.

---

## 0) Prereqs

- Node **20+**, pnpm **9+**
- Cloudflare account
- Wrangler: `pnpm dlx wrangler --version` (or install globally)

---

## 1) Authenticate & Create KV

```bash
# Login (opens browser)
pnpm dlx wrangler login

# Create KV namespace and copy the id
pnpm dlx wrangler kv namespace create XMLRPC_PING_KV
# Put the returned id into [[kv_namespaces]] in wrangler.toml
```

---

## 2) Secrets

```bash
# Required for POST auth
pnpm dlx wrangler secret put XMLRPC_PING_SECRET

# Optional:
# If using GitHub detector for scheduled checks against a private repo
pnpm dlx wrangler secret put GITHUB_TOKEN

# If using Cloudflare Pages detector (instead of GitHub)
pnpm dlx wrangler secret put CLOUDFLARE_API_TOKEN
```

Set `DETECTOR` to `github` (default) or `cloudflare` in `wrangler.toml`.

---

## 3) Generate Types

```bash
pnpm dlx wrangler types
# Generates worker-configuration.d.ts
```

---

## 4) Seed Endpoints (optional now)

```bash
# If you have endpoints.json
pnpm dlx wrangler kv key put xmlrpc:endpoints --binding=XMLRPC_PING_KV --path ./endpoints.json
```

---

## 5) Dev

```bash
# Local (ephemeral KV)
pnpm dlx wrangler dev

# Remote (uses real KV)
pnpm dlx wrangler dev --remote

# Open health:
#   http://127.0.0.1:8787/health?view=fail&refresh=60
```

---

## 6) Manual POSTs

### curl

```bash
SEC="<YOUR_SECRET>"
URL="http://127.0.0.1:8787/?dry=1&verbose=1&only=fail&format=csv"

curl -sS -X POST "$URL" \
  -H "Authorization: Bearer $SEC" \
  -H "Content-Type: application/json" \
  -d '{"siteName":"Your Site","siteUrl":"https://example.com","feedUrl":"https://example.com/feed.xml"}' \
  -o dry-failures.csv
```

### PowerShell

```powershell
$URL = "http://127.0.0.1:8787/?dry=1&verbose=1&only=fail&format=csv"
$SEC = "<YOUR_SECRET>"
Invoke-RestMethod -Method POST -Uri $URL `
  -Headers @{ Authorization = "Bearer $SEC"; "Content-Type" = "application/json" } `
  -Body '{"siteName":"Your Site","siteUrl":"https://example.com","feedUrl":"https://example.com/feed.xml"}' `
  -OutFile .\dry-failures.csv
```

**Batching:** the Worker obeys subrequest limits. For big lists, iterate with `cursor`:

```bash
SEC="..."; URL="https://<your-worker>.workers.dev"
CURSOR=0
while :; do
  RESP=$(curl -sS -X POST "$URL?dry=1&cursor=$CURSOR" \
    -H "Authorization: Bearer $SEC" -H "Content-Type: application/json" \
    --data '{"siteName":"X","siteUrl":"https://x.com"}')
  NEXT=$(echo "$RESP" | jq -r '.nextCursor // empty')
  echo "$RESP" | jq '.totals'
  [ -z "$NEXT" ] && break
  CURSOR=$NEXT
done
```

---

## 7) /health

```
/health?view=all|fail|ok&refresh=60
/health?format=json
```

- Tabs show All / Failures / Successes
- Fixed-height, scrollable table
- Shows last real run; falls back to last dry run snapshot

---

## 8) Deploy

```bash
pnpm dlx wrangler deploy
```

---

## 9) CI (GitHub Actions)

Minimal:

```yaml
name: Deploy Worker
on: { push: { branches: [main] } }
jobs:
    deploy:
        runs-on: ubuntu-latest
        env:
            CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        steps:
            - uses: actions/checkout@v4
            - uses: pnpm/action-setup@v3
              with: { version: 9 }
            - uses: actions/setup-node@v4
              with: { node-version: 20 }
            - run: pnpm install --frozen-lockfile
            - run: pnpm dlx wrangler types
            - run: pnpm dlx wrangler deploy
```

Nice-to-have extras:

- Concurrency guard
- Seed `endpoints.json` to KV when changed
- GitHub Deployment status + smoke test
- `WORKER_URL` repo variable for sidebar link

---

## 10) Ping from your Astro repo

Add a **post-deploy** step:

```yaml
- name: Notify XML-RPC pinger
  if: ${{ success() }}
  env:
      PING_ENDPOINT: ${{ secrets.PING_ENDPOINT }} # https://<slug>.workers.dev
      PING_SECRET: ${{ secrets.PING_SECRET }} # same as XMLRPC_PING_SECRET
      PING_SITE_NAME: ${{ vars.PING_SITE_NAME || 'Your Name' }}
      PING_SITE_URL: ${{ vars.PING_SITE_URL  || 'https://example.com' }}
      PING_FEED_URL: ${{ vars.PING_FEED_URL  || 'https://example.com/feed.xml' }}
  run: |
      curl -sS -X POST "$PING_ENDPOINT" \
        -H "Authorization: Bearer $PING_SECRET" \
        -H "Content-Type: application/json" \
        --data "{\"siteName\":\"$PING_SITE_NAME\",\"siteUrl\":\"$PING_SITE_URL\",\"feedUrl\":\"$PING_FEED_URL\"}"
```

---

## Notes for Cursor

- Follow `.cursorrules` in the repo root.
- When generating new code, default to **tabs** (TS/JS) and **4 spaces in Markdown**.
- Avoid extra dependencies; prefer standard APIs.
- Find additional details and insights on this repo in its [README.md](./README.md) and [copilot-instructions.md](./.github/copilot-instructions.md).
