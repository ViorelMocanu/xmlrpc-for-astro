# XML-RPC Pinger for Astro (Cloudflare Worker)

> A tiny Worker that recreates “WordPress Update Services” for your **Astro** site.  
> It pings a list of XML-RPC endpoints whenever you deploy — **at most once per hour** — and ships with a pretty `/health` page, a dry-run mode, and CSV/NDJSON exports for pruning dead endpoints, and Cloudflare‑safe batching.

---

## Features

- 🛰️ **Decoupled** from your site (a standalone Worker)
- ⏱️ **KV‑backed rate limit**: ≤ 1 non‑dry ping per hour
- 🧭 **Deploy detectors**: GitHub branch _or_ Cloudflare Pages
- 🧪 **Dry‑run & verbose**: test safely, capture latency + snippets
- 🗂️ **Batching with cursor**: stays under Cloudflare subrequest caps
- 📤 **CSV / NDJSON** exports: prune dead endpoints quickly
- ❤️ **/health** dashboard: dark‑mode, auto‑refresh, tabs (All / Failures / Successes), scrollable table
- 🪣 **KV list** of endpoints (`xmlrpc:endpoints`) + minimal baked‑in fallback
- ⚙️ **Tunable**: `SUBREQ_BUDGET` and `PING_CONCURRENCY` env knobs

---

## How it works

- The Worker keeps two KV keys:
    - `xmlrpc:last-ping` — enforces the **≤ 1/hour** lock for real runs
    - `xmlrpc:last-seen` — last deploy/commit ID already processed
- On schedule (default: every 15 minutes) it checks for a **new** deploy via:
    - **GitHub**: latest commit on a branch, or
    - **Cloudflare Pages**: most recent deployment
- If new + not rate‑limited, it POSTs one of:
    - `weblogUpdates.ping(siteName, siteUrl)`
    - `weblogUpdates.extendedPing(siteName, siteUrl, feedUrl)`
- **Batching & cursor**: to avoid Cloudflare “Too many subrequests”, each invocation only hits up to `SUBREQ_BUDGET` endpoints (default 45 for Free). Pass `cursor` to resume the next slice.  
  Example: 425 endpoints with budget 45 → 10 slices (0,45,90,…).

---

## Prerequisites

- **Node 20+** (LTS) and **pnpm 10+**
- A **Cloudflare account** with:
    - A **Workers KV namespace** (we’ll create one)
    - An **API Token** (store it in your CI as `CLOUDFLARE_API_TOKEN`) with scopes:
        - _Workers Scripts: Edit_
        - _Workers KV Storage: Edit_
        - _Workers Tail: Read_
        - _User Details: Read_ ← (prevents `/memberships` auth warnings)
        - _Cloudflare Pages: Edit_ (only if you use the `cloudflare` detector)
- (Optional) A **GitHub token** with repo read access if your branch is private

---

## Install & setup

```bash
pnpm install
pnpm wrangler login
```

### 1) **Create a KV namespace** (once)

```bash
pnpm wrangler kv namespace create XMLRPC_PING_KV
# copy the returned "id" into wrangler.toml -> [[kv_namespaces]]
```

### 2) **Set secrets** (never commit these)

```bash
# required: secret used for manual POST trigger
pnpm wrangler secret put XMLRPC_PING_SECRET
# paste a strong random string

# optional (choose one detector)
# -- for GitHub detector
pnpm wrangler secret put GITHUB_TOKEN
# -- for Cloudflare Pages detector (if not set via [vars])
pnpm wrangler secret put CLOUDFLARE_API_TOKEN

# required: secret used for manual POST trigger
pnpm wrangler secret put XMLRPC_PING_SECRET
# paste a strong random string
```

### 3) **Generate binding types**

```bash
pnpm wrangler types # emits worker-configuration.d.ts
```

### 4) **Seed endpoints (optional now, can do later)**

```bash
# If you have endpoints.json
pnpm wrangler kv key put xmlrpc:endpoints --binding=XMLRPC_PING_KV --path ./endpoints.json
```

The current repo has an `endpoints.json` [in the root directory](./endpoints.json). It's quite extensive, but it's _old_, and should be pruned to a minimal set of active endpoints. I will update it in the future, but if you can do it sooner, [open a PR](https://github.com/ViorelMocanu/xmlrpc-for-astro/pulls) please!

---

## Configuration

`wrangler.toml` (simplified example):

```toml
name = "xmlrpc-for-astro"
main = "src/index.ts"
compatibility_date = "2025-08-26"

[[kv_namespaces]]
binding = "XMLRPC_PING_KV"
id = "<your-kv-id>"

[triggers]
crons = ["*/15 * * * *"]  # schedule ping checks

[vars]
# detector: "github" (default) or "cloudflare"
DETECTOR = "github"

# sensible defaults (override in POST body if you like)
SITE_NAME = "Your Name"
SITE_URL  = "https://example.com"
FEED_URL  = "https://example.com/feed.xml"

# Cloudflare detector needs these:
CLOUDFLARE_PAGES_PROJECT = "<pages-project-slug>"
CLOUDFLARE_ACCOUNT_ID    = "<account-id>"

# Batching / concurrency (strings; parsed at runtime)
SUBREQ_BUDGET    = "45"  # 45 is safe for Free Workers; use 900 for Unbound/Paid
PING_CONCURRENCY = "6"   # keep modest; 4–6 is gentle
```

> Tip: Add a custom domain/route to your Worker so the endpoint is stable (instead of versioned preview URLs).

---

## Local development

```bash
# local Miniflare (ephemeral KV)
pnpm dev

# or use live Cloudflare bindings/KV
pnpm dev:remote
```

Open [`http://127.0.0.1:8787/health?refresh=60&view=fail`](http://127.0.0.1:8787/health?refresh=60&view=fail) while testing.

---

## Manual trigger (curl / PowerShell)

The root path (`/`) accepts **POST** with `Authorization: Bearer <XMLRPC_PING_SECRET>`.

### curl

```bash
SEC="<your secret>"
URL="http://127.0.0.1:8787/"

curl -sS -X POST "${URL}?dry=0" \
  -H "Authorization: Bearer ${SEC}" \
  -H "Content-Type: application/json" \
  -d '{
    "siteName": "Example Site",
    "siteUrl":  "https://www.example.com",
    "feedUrl":  "https://www.example.com/feed.xml"
  }' | jq .
```

### PowerShell

```powershell
$URL = "http://127.0.0.1:8787/"
$SEC = "<YOUR_SECRET>"

Invoke-RestMethod -Method POST -Uri $URL `
  -Headers @{ Authorization = "Bearer $SEC"; "Content-Type" = "application/json" } `
  -Body '{"siteName":"Example Site","siteUrl":"https://www.example.com","feedUrl":"https://www.example.com/feed.xml"}'
```

> **Rate‑limit** applies to real runs. Add `?dry=1` to bypass the 1‑hour lock for testing. Dry-runs also save a snapshot to `xmlrpc:last-dry` so `/health` has something to show during testing.

> **PRO TIP**: PowerShell doesn't like `$` characters inside "double quotes". If your secret uses `$`, try using 'single quotes' instead.

---

### Bindings & secrets used by the Worker

| Name                 | Where        | Required | Notes                                                     |
| -------------------- | ------------ | -------: | --------------------------------------------------------- |
| `XMLRPC_PING_KV`     | KV binding   |       ✅ | Stores rate-limit, last seen, endpoint list, last results |
| `XMLRPC_PING_SECRET` | secret       |       ✅ | Bearer token for manual POST trigger                      |
| `DETECTOR`           | var          |       ✅ | `"github"` (default) or `"cloudflare"`                    |
| `SITE_NAME/SITE_URL` | vars         |       ✅ | Defaults for XML-RPC ping                                 |
| `FEED_URL`           | var          |       ➖ | If set → uses `extendedPing`                              |
| `PING_ENDPOINTS`     | var          |       ➖ | JSON array string as fallback when KV not seeded          |
| `GITHUB_REPO/BRANCH` | vars         |       ➖ | e.g. `owner/repo` and `main`                              |
| `GITHUB_TOKEN`       | secret       |       ➖ | Needed for private repos                                  |
| `CLOUDFLARE_*`       | vars/secrets |       ➖ | If using the Cloudflare detector                          |

---

## **Options & exports**: Dry-run, verbose, CSV & NDJSON

**Query params** you can append to the POST URL:

Append these **query params** to the POST URL:

| Param     | Values                       | Purpose                                                        |
| --------- | ---------------------------- | -------------------------------------------------------------- |
| `dry`     | `1` or `0`                   | Skip 1‑hour lock and don’t persist “last‑result”               |
| `verbose` | `1`                          | Include latency `ms` and a small `bodySnippet` for failures    |
| `only`    | `fail` \| `success` \| `all` | Filter response rows                                           |
| `limit`   | integer                      | Only ping the first N endpoints (quick sample)                 |
| `cursor`  | integer (0‑based)            | Start slice index for batching (e.g. `0,45,90…` for budget 45) |
| `format`  | `csv` \| `ndjson`            | Export results for spreadsheets/CLI tools                      |

### Examples

#### Failures → CSV (great for pruning):

```bash
curl -sS -X POST "$URL?dry=1&verbose=1&only=fail&format=csv" \
  -H "Authorization: Bearer $SEC" \
  -H "Content-Type: application/json" \
  -d '{"siteName":"Test","siteUrl":"https://example.com","feedUrl":"https://example.com/feed.xml"}' \
  -o dry-failures.csv
```

#### Loop through all batches (Free plan; budget 45; 425 endpoints → 10 slices):

```bash
BUDGET=45
TOTAL=425
for CUR in $(seq 0 $BUDGET $TOTAL); do
  curl -sS -X POST "$URL?dry=1&cursor=$CUR&verbose=1&only=fail&format=ndjson" \
    -H "Authorization: Bearer $SEC" \
    -H "Content-Type: application/json" \
    -d '{"siteName":"Test","siteUrl":"https://example.com","feedUrl":"https://example.com/feed.xml"}' \
    >> dry-failures.ndjson
done
```

> Dry‑runs snapshot to `xmlrpc:last-dry` so `/health` can visualize your testing data.

---

## `/health` dashboard

Open:

```bash
/health?refresh=60&view=fail
```

If you're lazy like me, [click here to do it](http://127.0.0.1:8787/health?refresh=60&view=fail) while your server is open.

- **Tabs**: `All` / `Failures` / `Successes` (or `?view=all|fail|ok`)
- **Fixed‑height table** with scroll (no pagination)
- **Export JSON**: `?format=json`

The summary cards show:

- Site info, endpoint count
- Last ping timestamp + “next allowed in”
- Latest processed ID (commit/deploy)
- Last result (OK/FAIL counts)
- Last manual request timestamp

---

## Seeding & maintaining the endpoint list

Prefer KV over hardcoding:

```bash
# put/update the list
pnpm kv:put:endpoints

# read back
pnpm kv:get:endpoints
```

Suggested cleanup workflow:

1. Seed a big list into KV.
2. Run a **dry + verbose** POST with `only=fail&format=csv`.
3. Inspect the CSV (HTTP 301/302/4xx/5xx, timeouts).
4. Prune bad rows from `endpoints.json`.
5. Re‑seed KV.

---

## CI deploy (GitHub Actions)

A robust workflow ([see it in full here](https://github.com/ViorelMocanu/xmlrpc-for-astro/blob/main/.github/workflows/deploy.yml)) that shows a **Deployment** on the repo sidebar and seeds KV when `endpoints.json` changes:

```yaml
name: Deploy XML-RPC Worker on CloudFlare

permissions:
    contents: read # can checkout read the repo
    deployments: write # can create/update GitHub Deployments

concurrency:
    group: worker-deploy
    cancel-in-progress: true # prevent push storms and redundant deployments

on:
    push:
        branches: [main] # deploy from main only
    workflow_dispatch: {} # allow manual triggering

jobs:
    deploy:
        runs-on: ubuntu-latest
        environment:
            name: production-cloudflare
            url: ${{ vars.WORKER_URL }} # shows as clickable link on right sidebar
        env:
            CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }} # CloudFlare API token - NOT account-level
            XMLRPC_PING_SECRET: ${{ secrets.XMLRPC_PING_SECRET }} # XML-RPC ping secret

        steps:
            - name: Check WORKER_URL
              run: test -n "${{ vars.WORKER_URL }}" || (echo "WORKER_URL not set"; exit 1)

            - name: Checkout Code
              uses: actions/checkout@v4

            - name: Setup PNPM
              uses: pnpm/action-setup@v4
              with:
                  version: 10.15.0

            - name: Setup Node.js
              uses: actions/setup-node@v4
              with:
                  node-version: 20
                  cache: "pnpm"

            - name: Install Dependencies
              run: pnpm install --frozen-lockfile

            - name: Generate Types
              run: pnpm types

            - name: Sync CloudFlare secrets (optional)
              run: |
                  if [ -n "$XMLRPC_PING_SECRET" ]; then
                    printf '%s' "$XMLRPC_PING_SECRET" | pnpm wrangler secret put XMLRPC_PING_SECRET
                  else
                    echo "XMLRPC_PING_SECRET not set; skipping."
                  fi

            - name: Detect changed files
              id: changes
              uses: dorny/paths-filter@v3
              with:
                  filters: |
                      endpoints:
                        - 'endpoints.json'
            - name: Seed endpoints to KV (when changed)
              if: ${{ steps.changes.outputs.endpoints == 'true' }}
              run: pnpm sync-endpoints

            - name: Start GitHub Deployment
              id: dpl
              uses: bobheadxi/deployments@v1.5.0
              with:
                  step: start
                  token: ${{ secrets.GITHUB_TOKEN }}
                  env: production-cloudflare
                  ref: ${{ github.sha }}
            - name: Deploy with Wrangler
              run: pnpm wrangler deploy
            - name: GitHub Deployment Status
              if: always() # always run to mark success/failure
              uses: bobheadxi/deployments@v1.5.0
              with:
                  step: finish
                  token: ${{ secrets.GITHUB_TOKEN }}
                  env: ${{ steps.dpl.outputs.env }}
                  ref: ${{ github.sha }}
                  deployment_id: ${{ steps.dpl.outputs.deployment_id }}
                  status: ${{ job.status }}
                  env_url: ${{ vars.WORKER_URL }} # this is what renders on the sidebar

            - name: Smoke test
              env:
                  URL: ${{ vars.WORKER_URL }}
                  SEC: ${{ secrets.XMLRPC_PING_SECRET }}
                  USR: ${{ github.actor }}
              run: |
                  test -n "$URL" || (echo "WORKER_URL missing"; exit 1)
                  # hit / with a dry run and tiny limit to avoid rate limits
                  code=$(curl -sS -o /dev/null -w '%{http_code}' \
                  -X POST "$URL?dry=1&limit=3" \
                  -H "Authorization: Bearer $SEC" \
                  -H "Content-Type: application/json" \
                  --data "{'siteName':'SmokeTest GitHub $USR','siteUrl':'https://github.com/$USR','feedUrl':'https://github.com/$USR.atom'}")
                  echo "HTTP $code"
                  test "$code" = "200"

            - name: Publish summary
              if: ${{ always() }}
              env:
                  URL: ${{ vars.WORKER_URL }}
              run: |
                  {
                  echo "### Deployed to Cloudflare"
                  echo ""
                  echo "- **URL:** $URL"
                  echo "- **Health (failures):** ${URL%/}/health?view=fail"
                  echo "- **Health (all):** ${URL%/}/health"
                  } >> "$GITHUB_STEP_SUMMARY"
```

**Secrets to add in the repo or in GitHub → Settings → Environments → `your-environment` (I used `production-cloudflare` in the example above):**

- Variables:
    - `WORKER_URL` → _(required)_ your Worker URL (prefer a route/custom domain) (e.g. `https://<zone>.<name>.workers.dev/`)
    - `PING_SITE_NAME`, `PING_SITE_URL`, `PING_FEED_URL` — _(optional)_ site info defaults
- Secrets _(all required)_:
    - `CLOUDFLARE_API_TOKEN` (scopes in **Prerequisites**)
    - `XMLRPC_PING_SECRET` (same as you put with Wrangler)

## Using it from an Astro project

In the **Astro** site’s CI (after deploy step), notify the Worker:

```yaml
- name: Notify XML-RPC pinger
  if: ${{ success() }}
  env:
      URL: ${{ secrets.WORKER_URL }}
      SEC: ${{ secrets.XMLRPC_PING_SECRET }}
      SITE: ${{ secrets.PING_SITE_NAME || 'Example Site' }}
      HOME: ${{ secrets.PING_SITE_URL  || 'https://example.com' }}
      FEED: ${{ secrets.PING_FEED_URL  || 'https://example.com/feed.xml' }}
  run: |
      curl -sS -X POST "${URL}" \
        -H "Authorization: Bearer ${SEC}" \
        -H "Content-Type: application/json" \
        --data "{'siteName':'${SITE}','siteUrl':'${HOME}','feedUrl':'${FEED}'}"
```

> Multiple deploys in a row are fine — the Worker still enforces the hourly lock.

---

## Scripts (package.json)

If you’re using **`pnpm`**, these are handy aliases (adjust to your taste):

```jsonc
{
    "scripts": {
        "dev": "pnpm verify:fix && wrangler dev",
        "dev:remote": "pnpm verify:fix && wrangler dev --remote",
        "deploy": "pnpm verify:fix && pnpm sync-endpoints && wrangler deploy",
        "format": "prettier --check .",
        "format:fix": "prettier --write .",
        "lint": "eslint .",
        "lint:fix": "eslint . --fix",
        "types": "wrangler types",
        "typecheck": "pnpm types && pnpm tsc --project tsconfig.json --noEmit --pretty",
        "test": "pnpm verify",
        "verify": "pnpm lint && pnpm typecheck && pnpm format",
        "verify:fix": "pnpm lint:fix && pnpm typecheck && pnpm format:fix",
        "prepare": "husky",
        "pre-commit": "pnpm verify:fix",
        "upd": "pnpm self-update && pnpm update --latest --recursive --interactive --verbose --ignore-scripts=false --include=optional && pnpm up && pnpm i",
        "postinstall": "wrangler types",
        "tail": "wrangler tail xmlrpc-for-astro",
        "kv:put:endpoints": "wrangler kv key put xmlrpc:endpoints --binding=XMLRPC_PING_KV --path ./endpoints.json",
        "kv:put:endpoints:remote": "wrangler kv key put xmlrpc:endpoints --binding=XMLRPC_PING_KV --path ./endpoints.json --remote",
        "kv:get:endpoints": "wrangler kv key get xmlrpc:endpoints --binding=XMLRPC_PING_KV",
        "sync-endpoints": "pnpm kv:put:endpoints && pnpm kv:put:endpoints:remote",
    },
}
```

No scripts? You can always run the same commands with `pnpm wrangler …`.

---

## FAQ / Tips

### _“/health shows nothing!”_

Dry-runs write “last-result”s, so you should see something. Check error logs, but just in case: the worker does snapshot to `xmlrpc:last-dry`. Use `wrangler dev --remote` if you want to see live KV from your browser during dev.

### _“Why am I rate-limited?”_

A non-dry run sets a 1-hour lock (`xmlrpc:last-ping`). Dry-run (`?dry=1`) bypasses that lock.

### _“Some endpoints return 301/302/530/timeout.”_

That’s the point of dry-run + verbose: export CSV, open it in a spreadsheet, prune with extreme prejudice (and open a PR afterwards).

### Security considerations

- Never commit secrets. Use `wrangler secret put …` and GitHub Secrets.
- You can restrict `/health` with Cloudflare Access or a simple header check if you prefer.

### Miscellaneous

- Prefer a **custom domain/route** for a stable Worker URL.
- Tune `SUBREQ_BUDGET` (slice size) and `PING_CONCURRENCY` (parallel posts) if you move to Unbound/Paid - the current limits are set for the Free version, with the specs available [in the documentation](https://developers.cloudflare.com/workers/platform/limits/) (as of August 2025).
- If KV is empty and `PING_ENDPOINTS` var isn’t set, the worker uses a small baked-in list so you can test instantly. But for better results, seed KV with your curated set.

---

## License

MIT — Do what you like. If it helps your blog get a little more love from the pingiverse, even better. ✨

---

## Support

If you enjoyed this project, please consider giving it a star on GitHub or sharing it with others who might find it useful. Your support helps encourage further development and improvements!

This repo was partially vibe coded _(the hard way)_ with [ChatGPT 5 (Thinking)](https://chatgpt.com/) and [GitHub Copilot](https://github.com/features/copilot).

## Links

[![YouTube](https://img.shields.io/badge/YouTube-%23FF0000.svg?style=for-the-badge&logo=YouTube&logoColor=white)](https://www.youtube.com/@ViorelMocanu) [![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com/invite/UpnAutz) [![Facebook](https://img.shields.io/badge/Facebook-%231877F2.svg?style=for-the-badge&logo=Facebook&logoColor=white)](https://www.facebook.com/groups/carierait) [![Instagram](https://img.shields.io/badge/Instagram-%23E4405F.svg?style=for-the-badge&logo=Instagram&logoColor=white)](https://www.instagram.com/viorelmocanu.ro/) [![LinkedIn](https://img.shields.io/badge/linkedin-%230077B5.svg?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/viorelmocanu/) [![Twitter](https://img.shields.io/badge/Twitter-%231DA1F2.svg?style=for-the-badge&logo=Twitter&logoColor=white)](https://twitter.com/ViorelMocanu) [![Gmail](https://img.shields.io/badge/Gmail-D14836?style=for-the-badge&logo=gmail&logoColor=white)](https://viorelmocanu.ck.page/newsletter) [![WordPress](https://img.shields.io/badge/WordPress-%23117AC9.svg?style=for-the-badge&logo=WordPress&logoColor=white)](https://www.viorelmocanu.ro/blog/) [![Github-sponsors](https://img.shields.io/badge/sponsor-30363D?style=for-the-badge&logo=GitHub-Sponsors&logoColor=#EA4AAA)](https://github.com/sponsors/ViorelMocanu) [![Patreon](https://img.shields.io/badge/Patreon-F96854?style=for-the-badge&logo=patreon&logoColor=white)](https://www.patreon.com/ViorelMocanu) [![BuyMeACoffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/viorel)

[Viorel Mocanu], [digital consultant] specialized in Web Development, Design, Growth and AI + occasional [content creator].

[Viorel Mocanu]: https://github.com/ViorelMocanu
[digital consultant]: https://www.viorelmocanu.ro/
[content creator]: https://www.youtube.com/@ViorelMocanu
