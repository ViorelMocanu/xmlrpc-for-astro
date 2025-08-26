# XML-RPC Pinger for Astro (Cloudflare Worker)

> A tiny Worker that recreates “WordPress Update Services” for your **Astro** site.  
> It pings a list of XML-RPC endpoints whenever you deploy — **at most once per hour** — and ships with a pretty `/health` page, a dry-run mode, and CSV/NDJSON exports for pruning dead endpoints.

---

## Features

- 🛰️ **Decoupled** from your site repo (lives as its own Worker)
- ⏱️ **Rate-limited** to ≤ 1 ping/hour (KV-backed)
- 🧭 **Auto-detect deploys**: GitHub branch _or_ Cloudflare Pages project
- 🧪 **Dry-run** & **verbose** mode to test endpoints without touching rate-limit
- 📤 **CSV / NDJSON** exports of results (perfect for cleaning your list)
- ❤️ **/health** dashboard with dark-mode, auto-refresh, and a **failures-only** view
- 🪣 Simple KV storage for the endpoint list (`xmlrpc:endpoints`)

---

## Table of contents

- [XML-RPC Pinger for Astro (Cloudflare Worker)](#xml-rpc-pinger-for-astro-cloudflare-worker)
  - [Features](#features)
  - [Table of contents](#table-of-contents)
  - [How it works](#how-it-works)
  - [Prerequisites](#prerequisites)
  - [Install \& setup](#install--setup)
    - [1) **Create a KV namespace** (once):](#1-create-a-kv-namespace-once)
    - [2) **Set secrets** (never commit these):](#2-set-secrets-never-commit-these)
    - [3) **Generate types** (binding types go into `worker-configuration.d.ts`):](#3-generate-types-binding-types-go-into-worker-configurationdts)
    - [4) **Seed endpoints (optional now, can do later)**](#4-seed-endpoints-optional-now-can-do-later)
  - [Configuration](#configuration)
    - [Bindings \& secrets used by the Worker](#bindings--secrets-used-by-the-worker)
  - [Local development](#local-development)
  - [Manual trigger (curl / PowerShell)](#manual-trigger-curl--powershell)
    - [curl](#curl)
    - [PowerShell](#powershell)
  - [Dry-run, verbose, CSV \& NDJSON](#dry-run-verbose-csv--ndjson)
    - [Examples](#examples)
      - [Failures → CSV (great for pruning)](#failures--csv-great-for-pruning)
      - [Failures → NDJSON](#failures--ndjson)
  - [/health dashboard](#health-dashboard)
  - [Seeding/Editing the endpoints list](#seedingediting-the-endpoints-list)
  - [CI deploy (GitHub Actions)](#ci-deploy-github-actions)
    - [Notifying from your Astro site](#notifying-from-your-astro-site)
  - [Scripts (package.json)](#scripts-packagejson)
  - [FAQ / Tips](#faq--tips)
    - [“/health shows nothing!”](#health-shows-nothing)
    - [“Why am I rate-limited?”](#why-am-i-rate-limited)
    - [“Some endpoints return 301/302/530/timeout.”](#some-endpoints-return-301302530timeout)
    - [Security](#security)
  - [License](#license)
    - [Bonus: Minimal endpoint fallback](#bonus-minimal-endpoint-fallback)

---

## How it works

- The Worker keeps two KV keys:
  - `xmlrpc:last-ping` — enforces ≤ 1 ping/hour
  - `xmlrpc:last-seen` — last deploy/commit ID we already processed
- On a schedule (default: every 15 minutes) it asks either:
  - **GitHub**: latest commit on a branch, or
  - **Cloudflare Pages**: latest successful deployment
- If something **new** is found _and_ we’re outside the rate-limit window, we POST the correct XML-RPC call to every endpoint in your list:
  - `weblogUpdates.ping(siteName, siteUrl)` **or**
  - `weblogUpdates.extendedPing(siteName, siteUrl, feedUrl)`
- Results are summarized and shown on `/health`.  
  Dry-runs are also visible (labeled) so you can test safely.

---

## Prerequisites

- **Node 20+** (LTS) and **pnpm 9+**  
- A **Cloudflare account** with:
  - A **Workers KV namespace** (we’ll create one)
  - An **API Token** (store it in your CI as `CLOUDFLARE_API_TOKEN`) with scopes:
    - _Workers Scripts: Edit_
    - _Workers KV Storage: Edit_
    - _Workers Tail: Read_
    - _User Details: Read_  ← this avoids “/memberships” auth errors
    - _Cloudflare Pages: Edit_ (only if you use the “cloudflare” detector)
- (Optional) A **GitHub token** with repo read access if your branch is private

---

## Install & setup

```bash
pnpm install
wrangler login
```

### 1) **Create a KV namespace** (once):

```bash
# create
npx wrangler kv namespace create XMLRPC_PING_KV

# note the "id" returned, then paste it into wrangler.toml under [[kv_namespaces]]
```

### 2) **Set secrets** (never commit these):

```bash
# required: secret used for manual POST trigger
npx wrangler secret put XMLRPC_PING_SECRET
# paste a strong random string

# optional (choose one detector)
# -- for GitHub detector
npx wrangler secret put GITHUB_TOKEN

# -- for Cloudflare Pages detector (if not set via [vars])
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

### 3) **Generate types** (binding types go into `worker-configuration.d.ts`):

```bash
npx wrangler types
```

### 4) **Seed endpoints (optional now, can do later)**

```bash
# If you have endpoints.json
npx wrangler kv key put xmlrpc:endpoints --binding=XMLRPC_PING_KV --path ./endpoints.json
```

---

## Configuration

`wrangler.toml` (simplified example):

```toml
name = "xmlrpc-for-astro"
main = "src/index.ts"
compatibility_date = "2025-08-26"

[[kv_namespaces]]
binding = "XMLRPC_PING_KV"
id = "<your kv id>"

[triggers]
crons = ["*/15 * * * *"]   # every 15 minutes

[vars]
# detector: "github" (default) or "cloudflare"
DETECTOR = "github"

# site defaults (can be overridden in POST body)
SITE_NAME = "Your Name"
SITE_URL  = "https://example.com"
FEED_URL  = "https://example.com/feed.xml"

# only needed when using the Cloudflare detector:
CLOUDFLARE_PAGES_PROJECT = "your-pages-project-slug"
CLOUDFLARE_ACCOUNT_ID    = "<your account id>"
```

### Bindings & secrets used by the Worker

| Name                      | Where       | Required | Notes |
|---------------------------|-------------|---------:|-------|
| `XMLRPC_PING_KV`          | KV binding  | ✅ | Stores rate-limit, last seen, endpoint list, last results |
| `XMLRPC_PING_SECRET`      | secret      | ✅ | Bearer token for manual POST trigger |
| `DETECTOR`                | var         | ✅ | `"github"` (default) or `"cloudflare"` |
| `SITE_NAME/SITE_URL`      | vars        | ✅ | Defaults for XML-RPC ping |
| `FEED_URL`                | var         | ➖ | If set → uses `extendedPing` |
| `PING_ENDPOINTS`          | var         | ➖ | JSON array string as fallback when KV not seeded |
| `GITHUB_REPO/BRANCH`      | vars        | ➖ | e.g. `owner/repo` and `main` |
| `GITHUB_TOKEN`            | secret      | ➖ | Needed for private repos |
| `CLOUDFLARE_*`            | vars/secrets| ➖ | If using the Cloudflare detector |

---

## Local development

```bash
# local Miniflare (ephemeral KV)
npx wrangler dev

# or hit real Cloudflare (uses live KV & bindings)
npx wrangler dev --remote
```

Open your browser at `http://127.0.0.1:8787/health?refresh=60&view=fail`.

---

## Manual trigger (curl / PowerShell)

The Worker’s **root** path (`/`) accepts **POST** with a Bearer token:

### curl

```bash
curl -sS -X POST "http://127.0.0.1:8787/?dry=0" \
  -H "Authorization: Bearer $XMLRPC_PING_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "siteName": "Viorel Mocanu",
    "siteUrl":  "https://www.viorelmocanu.ro",
    "feedUrl":  "https://www.viorelmocanu.ro/feed.xml"
  }' | jq .
```

### PowerShell

```powershell
$URL = "http://127.0.0.1:8787/"
$SEC = "<YOUR_SECRET>"

Invoke-RestMethod -Method POST -Uri $URL `
  -Headers @{ Authorization = "Bearer $SEC"; "Content-Type" = "application/json" } `
  -Body '{"siteName":"Viorel Mocanu","siteUrl":"https://www.viorelmocanu.ro","feedUrl":"https://www.viorelmocanu.ro/feed.xml"}'
```

> Manual POSTs respect the 1-hour rate-limit **unless** you add `?dry=1` (see below).

---

## Dry-run, verbose, CSV & NDJSON

**Query params** you can append to the POST URL:

| Param        | Values             | Purpose |
|--------------|--------------------|---------|
| `dry`        | `1` or `0`         | Skip 1-hour lock and **don’t** persist “last-result” (safe testing) |
| `verbose`    | `1`                | Include `ms` (latency) and a small `bodySnippet` for failures |
| `only`       | `fail` \| `all`    | Filter the response to failures or show everything |
| `limit`      | integer            | Only ping the first N endpoints (quick sampling) |
| `format`     | `csv` \| `ndjson`  | Export results for spreadsheets/CLI tools |

### Examples

#### Failures → CSV (great for pruning)

```bash
curl -sS -X POST "http://127.0.0.1:8787/?dry=1&verbose=1&only=fail&format=csv" \
  -H "Authorization: Bearer $XMLRPC_PING_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"siteName":"Test","siteUrl":"https://example.com","feedUrl":"https://example.com/feed.xml"}' \
  -o dry-failures.csv
```

#### Failures → NDJSON

```bash
curl -sS -X POST "http://127.0.0.1:8787/?dry=1&verbose=1&only=fail&format=ndjson" \
  -H "Authorization: Bearer $XMLRPC_PING_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"siteName":"Test","siteUrl":"https://example.com","feedUrl":"https://example.com/feed.xml"}' \
  > dry-failures.ndjson
```

> Dry-runs also save a snapshot to `xmlrpc:last-dry` so `/health` has something to show during testing.

---

## /health dashboard

Open:

```bash
/health?refresh=60&view=fail
```

- `refresh` — auto-refresh every N seconds  
- `view` — `all` or `fail` (the table is filtered; the badges show totals)  
- `format=json` — JSON version of the same data

The page shows:

- Site defaults in use
- Endpoint count
- Last ping (+ next allowed time)
- Latest processed ID (commit/deploy)
- Last result (OK/FAIL counts)
- Last manual request time (if present)
- A **recent sample** table (max 20 rows), filterable to failures only

---

## Seeding/Editing the endpoints list

Prefer KV over hardcoding:

```bash
# put/update the list from a file
npx wrangler kv key put xmlrpc:endpoints --binding=XMLRPC_PING_KV --path ./endpoints.json

# read it back
npx wrangler kv key get xmlrpc:endpoints --binding=XMLRPC_PING_KV

# delete it (the Worker will then fall back to minimal defaults)
npx wrangler kv key delete xmlrpc:endpoints --binding=XMLRPC_PING_KV
```

A **good workflow** is:

1. Seed with a big list.
2. Run a **dry** verbose POST with `only=fail&format=csv`.  
3. Remove the failing URLs from your JSON.  
4. Re-seed KV with the cleaned list.

---

## CI deploy (GitHub Actions)

`.github/workflows/deploy.yml` (simplified):

```yaml
name: Deploy Worker
on:
  push: { branches: [ main ] }

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
      - name: Generate Types
        run: npx wrangler types
      - name: Deploy
        run: npx wrangler deploy
```

**Secrets to add in the repo:**

- `CLOUDFLARE_API_TOKEN` — with the scopes listed in **Prerequisites**  
- `PING_ENDPOINT` — Worker URL (e.g. `https://<zone>.<name>.workers.dev/`)  
- `PING_SECRET` — same value used when you ran `wrangler secret put XMLRPC_PING_SECRET`  
- `PING_SITE_NAME`, `PING_SITE_URL`, `PING_FEED_URL` — (optional) site info defaults

### Notifying from your Astro site

In the **Astro** repo, add a final step after the site deploy:

```yaml
- name: Notify XML-RPC pinger
  if: ${{ success() }}
  env:
    PING_ENDPOINT: ${{ secrets.PING_ENDPOINT }}
    PING_SECRET:   ${{ secrets.PING_SECRET }}
    PING_SITE_NAME: ${{ secrets.PING_SITE_NAME || 'Your Name' }}
    PING_SITE_URL:  ${{ secrets.PING_SITE_URL  || 'https://example.com' }}
    PING_FEED_URL:  ${{ secrets.PING_FEED_URL  || 'https://example.com/feed.xml' }}
  run: |
    curl -sS -X POST "$PING_ENDPOINT" \
      -H "Authorization: Bearer $PING_SECRET" \
      -H "Content-Type: application/json" \
      -d @- <<JSON
    { "siteName":"${PING_SITE_NAME}", "siteUrl":"${PING_SITE_URL}", "feedUrl":"${PING_FEED_URL}" }
    JSON
```

The Worker will still enforce the ≤1/hour lock, so multiple deploys won’t spam the endpoints.

---

## Scripts (package.json)

If you’re using **pnpm**, these are handy aliases (adjust to your taste):

```jsonc
{
  "scripts": {
    "dev": "wrangler dev",
    "dev:remote": "wrangler dev --remote",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail xmlrpc-for-astro",
    "types": "wrangler types",
    "kv:put:endpoints": "wrangler kv key put xmlrpc:endpoints --binding=XMLRPC_PING_KV --path ./endpoints.json",
    "kv:get:endpoints": "wrangler kv key get xmlrpc:endpoints --binding=XMLRPC_PING_KV",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  }
}
```

No scripts? You can always run the same commands with `npx wrangler …`.

---

## FAQ / Tips

### “/health shows nothing!”

Dry-runs don’t write “last-result”, but we do snapshot to `xmlrpc:last-dry`. Use `wrangler dev --remote` if you want to see live KV from your browser during dev.

### “Why am I rate-limited?”

A non-dry run sets a 1-hour lock (`xmlrpc:last-ping`). Dry-run (`?dry=1`) bypasses that lock.

### “Some endpoints return 301/302/530/timeout.”

That’s the point of dry-run + verbose: export CSV, open it in a spreadsheet, prune with extreme prejudice.

### Security

- Never commit secrets. Use `wrangler secret put …` and GitHub Secrets.
- You can restrict `/health` with Cloudflare Access or a simple header check if you prefer.

---

## License

MIT — Do what you like. If it helps your blog get a little more love from the pingiverse, even better. ✨

---

### Bonus: Minimal endpoint fallback

If KV is empty and `PING_ENDPOINTS` var isn’t set, we use a small baked-in list so you can test instantly. But for real results, seed KV with your curated set.
