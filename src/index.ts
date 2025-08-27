/// <reference types="../worker-configuration.d.ts" />
/* eslint-disable jsdoc/no-undefined-types */

type RuntimeEnv = Env & {
	XMLRPC_PING_KV: KVNamespace;

	// Auth for manual trigger
	XMLRPC_PING_SECRET: string;

	// Site info
	SITE_NAME?: string;
	SITE_URL?: string;
	FEED_URL?: string | null;
	PING_ENDPOINTS?: string; // JSON array

	// Deploy detectors
	DETECTOR?: "github" | "cloudflare";

	// GitHub detector
	GITHUB_REPO?: string; // "owner/repo"
	GITHUB_BRANCH?: string; // default "main"
	GITHUB_TOKEN?: string;

	// Cloudflare Pages detector
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_PAGES_PROJECT?: string;

	// Optional tuning knobs (strings from Wrangler become numbers when parsed below)
	SUBREQ_BUDGET?: string; // e.g. "45" on Free, "900" on Paid
	PING_CONCURRENCY?: string; // e.g. "6"
};

type PingPayload = {
	siteName?: string;
	siteUrl?: string;
	feedUrl?: string | null;
	endpoints?: string[];
};

type PingResult = { url: string; ok: boolean; status: number; error?: string };

interface DoPingResult {
	status: "done" | "skipped";
	reason?: string;
	dryRun?: boolean;
	method?: string;
	siteName?: string;
	siteUrl?: string;
	feedUrl?: string | null;
	totals?: {
		total: number;
		ok: number;
		fail: number;
		batchStart?: number;
		batchEnd?: number;
		batchCount?: number;
	};
	summary?: Array<PingResult & VerboseFields>;
	nextCursor?: number | null;
	subrequestBudget?: number;
	concurrencyUsed?: number;
}

interface GitHubBranchInfo {
	commit?: { sha?: string };
}
interface CfDeploy {
	id?: string;
	deployment_id?: string;
	short_id?: string;
}
interface CfDeployments {
	result?: { deployments?: CfDeploy[] } | CfDeploy[];
}

type PingOpts = {
	dryRun?: boolean; // skip 1h lock + (optionally) KV writes
	concurrency?: number; // default 6
	timeoutMs?: number; // default 10000
	limit?: number; // test first N endpoints
	verbose?: boolean; // add latency & body snippet
	only?: "all" | "fail" | "success"; // filter output
	cursor?: number; // NEW: 0-based index into the endpoints array
};

type VerboseFields = { ms?: number; bodySnippet?: string };

type ViewMode = "all" | "fail" | "ok";

interface HealthData {
	site: { name: string | null; url: string | null; feed: string | null };
	latestId: string | null;
	endpointsCount: number;
	lastPingAt: number | null;
	nextAllowedInMs: number;
	lastResultAt: number | null;
	successes: number;
	failures: number;
	lastRequestAt: number | null;
	lastRequestBody: unknown;
	// NEW: full list available for /health filtering
	summary: PingResult[];
	// kept for compatibility, not used by the new UI
	recentSample: PingResult[];
	sampleSource?: { time: number; result: unknown } | undefined;
}

type LastResultKV = {
	time: number;
	latest?: { id?: string }; // from scheduled()
	result?: {
		status: string;
		method: string;
		siteName: string;
		siteUrl: string;
		feedUrl: string | null;
		summary?: Array<{ url: string; ok: boolean; status: number; error?: string }>;
	};
};

const HOUR = 60 * 60;
const RL_KEY = "xmlrpc:last-ping";
const LAST_KEY = "xmlrpc:last-seen"; // commit sha or deploy id

const minimal_endpoints = ["https://rpc.pingomatic.com/", "https://blogsearch.google.com/ping/RPC2", "https://rpc.twingly.com/", "https://ping.fc2.com/", "https://ping.feedburner.com", "http://ping.blo.gs/", "http://www.weblogues.com/RPC/", "http://www.blogdigger.com/RPC2", "http://pingoat.com/goat/RPC2"];

export default {
	// Manual trigger (optional) — e.g., from CI
	async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
		// Health page (human-friendly)
		// GET /health?refresh=60&view=fail|all&format=json|csv|ndjson
		const url = new URL(request.url);
		const cursorQ = url.searchParams.get("cursor");
		const dryRun = url.searchParams.get("dry") === "1";
		const verbose = url.searchParams.get("verbose") === "1";
		const only = (url.searchParams.get("only") as "all" | "fail" | "success") || "all";
		const limit = Number(url.searchParams.get("limit") || "0");
		const format = url.searchParams.get("format"); // json (default), csv, ndjson

		if (request.method === "GET" && url.pathname === "/health") {
			const format = url.searchParams.get("format"); // json (default), csv, ndjson (ignored for GET)
			const refresh = Number(url.searchParams.get("refresh") || "0"); // seconds
			const view = (url.searchParams.get("view") as ViewMode) || "all";

			if (format === "json") {
				const data = await readHealth(env);
				return Response.json(data, { headers: { "Cache-Control": "no-store" } });
			}
			const html = await renderHealthHtml(env, refresh, view);
			return new Response(html, {
				status: 200,
				headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
			});
		}

		// Regular HTTP POST trigger for direct triggering via CURL / PowerShell Invoke-RestMethod
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
		const auth = request.headers.get("authorization");
		if (!auth || auth !== `Bearer ${env.XMLRPC_PING_SECRET}`) return new Response("Unauthorized", { status: 401 });

		const body = (await safeJson(request)) as Partial<PingPayload & { cursor?: number }>;
		const cursor = typeof body.cursor === "number" ? body.cursor : cursorQ ? Number(cursorQ) : 0;
		const res = await doPing(env, body, { dryRun, verbose, only, limit, cursor });

		// Persist only non-dry runs to "last-result"
		if (!dryRun) {
			await env.XMLRPC_PING_KV.put("xmlrpc:last-result", JSON.stringify({ time: Date.now(), result: res }), { expirationTtl: 7 * 24 * 3600 });
		} else {
			// OPTIONAL: also snapshot last dry run so /health has something to show
			await env.XMLRPC_PING_KV.put("xmlrpc:last-dry", JSON.stringify({ time: Date.now(), result: res }), { expirationTtl: 24 * 3600 });
		}

		// CSV / NDJSON exporters for easy local analysis
		if (format === "csv") {
			const csv = toCsv(res.summary ?? []);
			return new Response(csv, {
				headers: {
					"Content-Type": "text/csv; charset=utf-8",
					"Content-Disposition": `attachment; filename="xmlrpc-dryrun-${only}.csv"`,
					"Cache-Control": "no-store",
				},
			});
		}
		if (format === "ndjson") {
			const nd = toNdjson(res.summary ?? []);
			return new Response(nd, {
				headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
			});
		}

		return Response.json(res, { headers: { "Cache-Control": "no-store" } });
	},

	// Cron trigger — zero coupling with your site repo

	/**
	 * Cron trigger — zero coupling with your site repo
	 * @param {ScheduledController} _event The scheduled event controller
	 * @param {RuntimeEnv} env The runtime environment
	 * @param {ExecutionContext} _ctx The execution context
	 * @returns {Promise<void>} The scheduled event handler
	 */
	async scheduled(_event: ScheduledController, env: RuntimeEnv, _ctx: ExecutionContext): Promise<void> {
		try {
			const detector = (env.DETECTOR || "github") as "github" | "cloudflare";
			const latest = detector === "cloudflare" ? await latestCloudflareDeploy(env) : await latestGithubCommit(env);
			if (!latest?.id) return;

			const lastSeen = await env.XMLRPC_PING_KV.get(LAST_KEY);
			if (lastSeen === latest.id) return; // nothing new

			// also enforce ≤ 1/hour
			const rl = await env.XMLRPC_PING_KV.get(RL_KEY);
			if (rl) return;

			const result = await doPing(env, {});
			await env.XMLRPC_PING_KV.put(LAST_KEY, latest.id);
			// pre-set 1h window
			await env.XMLRPC_PING_KV.put(RL_KEY, String(Date.now()), { expirationTtl: HOUR });

			// Optional: log success
			await env.XMLRPC_PING_KV.put("xmlrpc:last-result", JSON.stringify({ time: Date.now(), latest, result }), { expirationTtl: 7 * 24 * 3600 });
		} catch (e) {
			// swallow to avoid cron alarms; consider sending to Sentry/Logtail
			// eslint-disable-next-line no-console
			console.error("scheduled error", e instanceof Error ? e.message : String(e)); // tiny breadcrumb
			await noop();
		}
	},
};

/**
 * Perform the ping operation
 * @param {RuntimeEnv} env The environment variables
 * @param {Partial<PingPayload>} payload The ping payload
 * @param opts
 * @returns {Promise<object>} The ping result
 */
async function doPing(env: RuntimeEnv, payload: Partial<PingPayload>, opts: PingOpts = {}): Promise<DoPingResult> {
	const { dryRun = false, concurrency = Math.max(1, Math.min(Number(env.PING_CONCURRENCY ?? 6), 10)), timeoutMs = 10_000, limit = 0, verbose = false, only = "all", cursor = 0 } = opts;

	// Compute a safe budget (default 45 for Free; if you’re Unbound/Paid set SUBREQ_BUDGET="900")
	const rawBudget = Number(env.SUBREQ_BUDGET ?? 45);
	const SUBREQ_BUDGET = Math.max(1, Math.min(rawBudget, 1000)); // clamp
	const MAX_CONCURRENCY = Math.max(1, Math.min(concurrency, 6)); // be polite

	// Respect the 1/h lock only for *non-dry* starts
	if (!dryRun) {
		const rl = await env.XMLRPC_PING_KV.get(RL_KEY);
		if (rl) return { status: "skipped", reason: "rate-limited (<=1/hour)" };
	}

	const siteName = payload.siteName ?? env.SITE_NAME ?? "Viorel Mocanu";
	const siteUrl = payload.siteUrl ?? env.SITE_URL ?? "https://www.viorelmocanu.ro";
	const feedUrl = payload.feedUrl ?? env.FEED_URL ?? null;

	// Build full endpoint list
	let endpoints: string[] = [];
	const kvList = (await env.XMLRPC_PING_KV.get("xmlrpc:endpoints", "json")) as string[] | null;
	if (Array.isArray(kvList)) endpoints = kvList;
	if (!endpoints.length) {
		endpoints = Array.isArray(payload.endpoints) ? payload.endpoints : env.PING_ENDPOINTS ? JSON.parse(env.PING_ENDPOINTS) : minimal_endpoints;
	}
	if (limit > 0) endpoints = endpoints.slice(0, limit);

	// Slice a batch under the subrequest cap
	const start = Math.max(0, cursor);
	const end = Math.min(endpoints.length, start + SUBREQ_BUDGET);
	const batch = endpoints.slice(start, end);
	const nextCursor = end < endpoints.length ? end : null;

	const method = feedUrl ? "weblogUpdates.extendedPing" : "weblogUpdates.ping";
	const params = feedUrl ? [siteName, siteUrl, feedUrl] : [siteName, siteUrl];
	const bodyXml = xmlRpc(method, params);

	if (!dryRun) {
		await env.XMLRPC_PING_KV.put(RL_KEY, String(Date.now()), { expirationTtl: HOUR });
	}

	// one request => one subrequest per endpoint; keep concurrency modest
	/**
	 * Ping a URL with a timeout
	 * @param {string} url The URL to ping
	 * @param {string} body The request body
	 * @param {number} ms The timeout in milliseconds
	 * @returns {Promise<PingResult & VerboseFields>} The ping result
	 */
	async function pingWithTimeout(url: string, body: string, ms = timeoutMs): Promise<PingResult & VerboseFields> {
		const started = Date.now();
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort("timeout"), ms);
		try {
			const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/xml" }, body, redirect: "manual", signal: ctrl.signal });
			const record: PingResult & VerboseFields = { url, ok: res.ok, status: res.status, ms: Date.now() - started };
			if (verbose && !res.ok) {
				try {
					record.bodySnippet = (await res.text()).slice(0, 200);
				} catch {}
			}
			return record;
		} catch (e) {
			return { url, ok: false, status: 0, error: String(e), ms: Date.now() - started };
		} finally {
			clearTimeout(t);
		}
	}

	/**
	 * Run a pool of promises with a limited concurrency
	 * @param {T[]} items The items to process
	 * @param {number} size The maximum number of concurrent promises
	 * @param {(i: T) => Promise<any>} fn The function to call for each item
	 * @returns {Promise<any[]>} The results of the promises
	 */
	async function runPool<T, R>(items: T[], size: number, fn: (i: T) => Promise<R>): Promise<R[]> {
		const results: R[] = [];
		let i = 0;
		const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
			while (true) {
				const idx = i++;
				if (idx >= items.length) break;
				results.push(await fn(items[idx]));
			}
		});
		await Promise.all(workers);
		return results;
	}

	let summary = await runPool(batch, MAX_CONCURRENCY, (u) => pingWithTimeout(u, bodyXml, timeoutMs));
	if (only === "fail") summary = summary.filter((r: PingResult) => !r.ok);
	if (only === "success") summary = summary.filter((r: PingResult) => r.ok);

	const totals = {
		total: endpoints.length,
		batchStart: start,
		batchEnd: end,
		batchCount: batch.length,
		ok: summary.filter((r: PingResult) => r.ok).length,
		fail: summary.filter((r: PingResult) => !r.ok).length,
	};

	// Save only non-dry runs (as before)
	if (!dryRun) {
		await env.XMLRPC_PING_KV.put("xmlrpc:last-result", JSON.stringify({ time: Date.now(), result: { siteName, siteUrl, feedUrl, summary } }), { expirationTtl: 7 * 24 * 3600 });
	}

	return {
		status: "done",
		dryRun,
		method,
		siteName,
		siteUrl,
		feedUrl,
		totals,
		summary,
		nextCursor, // <— tell caller if there’s more to do
		subrequestBudget: SUBREQ_BUDGET,
		concurrencyUsed: MAX_CONCURRENCY,
	};
}

/**
 * Convert an array of ping results to CSV format
 * @param {Array<PingResult & VerboseFields>} rows The array of ping results
 * @returns {string} The CSV string
 */
function toCsv(rows: Array<PingResult & VerboseFields>): string {
	const esc = (s: unknown) =>
		`"${String(s ?? "")
			.replace(/\r?\n/g, " ")
			.replace(/"/g, '""')}"`;
	const header = "url,ok,status,ms,error,bodySnippet";
	return [header, ...rows.map((r) => [esc(r.url), esc(r.ok), esc(r.status), esc(r.ms ?? ""), esc(r.error ?? ""), esc(r.bodySnippet ?? "")].join(","))].join("\r\n");
}

/**
 * Convert an array of ping results to NDJSON format
 * @param {Array<PingResult & VerboseFields>} rows The array of ping results
 * @returns {string} The NDJSON string
 */
function toNdjson(rows: Array<PingResult & VerboseFields>): string {
	return rows.map((r) => JSON.stringify(r)).join("\n");
}

/**
 * Generate XML-RPC request body
 * @param {string} method The XML-RPC method name
 * @param {string[]} params The method parameters
 * @returns {string} The XML-RPC request body
 */
function xmlRpc(method: string, params: string[]): string {
	const paramXml = params.map((p) => `<param><value><string>${escapeXml(String(p))}</string></value></param>`).join("");
	return `<?xml version="1.0"?>
<methodCall>
  <methodName>${method}</methodName>
  <params>${paramXml}</params>
</methodCall>`;
}

/**
 * Escape XML special characters
 * @param {string} s The string to escape
 * @returns {string} The escaped string
 */
function escapeXml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/**
 * Safely parse JSON from a request
 * @param {Request} req The request object
 * @returns {Promise<object>} The parsed JSON object or an empty object
 */
async function safeJson(req: Request): Promise<object> {
	try {
		return await req.json();
	} catch {
		return {};
	}
}

/**
 * No operation performed
 * @returns {Promise<void>} The scheduled event handler
 */
async function noop(): Promise<void> {
	// No operation performed
}

// --- Detectors ---

// Default (no changes to site repo): latest successful commit on a branch
/**
 * Get the latest commit SHA from a GitHub repository branch
 * @param {RuntimeEnv} env The environment variables
 * @returns {Promise<{ id: string } | null>} The latest commit SHA or null
 */
async function latestGithubCommit(env: RuntimeEnv): Promise<{ id: string } | null> {
	const repo = env.GITHUB_REPO;
	if (!repo) return null;
	const branch = env.GITHUB_BRANCH || "main";
	const r = await fetch(`https://api.github.com/repos/${repo}/branches/${branch}`, {
		headers: env.GITHUB_TOKEN ? { "Authorization": `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "xmlrpc-pinger" } : { "User-Agent": "xmlrpc-pinger" },
	});
	if (!r.ok) return null;
	const j = (await r.json()) as GitHubBranchInfo;
	const sha = j?.commit?.sha;
	return sha ? { id: sha } : null;
}

// Optional (tighter to actual Pages deploys): latest deploy id
/**
 * Get the latest deploy ID from a Cloudflare Pages project
 * @param {RuntimeEnv} env The environment variables
 * @returns {Promise<{ id: string } | null>} The latest deploy ID or null
 */
async function latestCloudflareDeploy(env: RuntimeEnv): Promise<{ id: string } | null> {
	const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_PAGES_PROJECT } = env;
	if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_PAGES_PROJECT) return null;

	// Note: The CF Pages deployments API returns recent deployments.
	// We only need the newest one's ID as a stable dedup key.
	const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CLOUDFLARE_PAGES_PROJECT}/deployments?per_page=1`;
	const r = await fetch(url, { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } });
	if (!r.ok) return null;
	const j = (await r.json()) as CfDeployments;

	// Be tolerant to shape differences
	const list = Array.isArray(j.result) ? j.result : (j.result?.deployments ?? []);
	const first: CfDeploy | undefined = Array.isArray(list) ? list[0] : undefined;
	const id = first?.id ?? first?.deployment_id ?? first?.short_id;
	return id ? { id } : null;
}

/**
 * Read health data from KV
 * @param {RuntimeEnv} env
 * @returns {Promise<HealthData>} The health data
 */
async function readHealth(env: RuntimeEnv): Promise<HealthData> {
	const [lastPingStr, lastSeen, endpoints, lastResult, lastDry, lastReq] = await Promise.all([env.XMLRPC_PING_KV.get("xmlrpc:last-ping", "text"), env.XMLRPC_PING_KV.get("xmlrpc:last-seen", "text"), env.XMLRPC_PING_KV.get("xmlrpc:endpoints", "json") as Promise<string[] | null>, env.XMLRPC_PING_KV.get("xmlrpc:last-result", "json") as Promise<LastResultKV | null>, env.XMLRPC_PING_KV.get("xmlrpc:last-dry", "json") as Promise<LastResultKV | null>, env.XMLRPC_PING_KV.get("xmlrpc:last-request", "json") as Promise<{ time: number; body: unknown } | null>]);
	const sampleSource = lastResult ?? lastDry ?? null;

	const lastPingMs = lastPingStr ? Number(lastPingStr) : null;
	const now = Date.now();
	const lockRemainingMs = lastPingMs ? Math.max(0, 60 * 60 * 1000 - (now - lastPingMs)) : 0;

	// Prefer the most recent available summary (last-result over last-dry)
	const summary: PingResult[] = (lastResult?.result?.summary as PingResult[] | undefined) ?? (lastDry?.result?.summary as PingResult[] | undefined) ?? [];

	const ok = summary.filter((s) => s.ok).length;
	const fail = summary.length - ok;

	return {
		site: {
			name: lastResult?.result?.siteName ?? lastDry?.result?.siteName ?? null,
			url: lastResult?.result?.siteUrl ?? lastDry?.result?.siteUrl ?? null,
			feed: lastResult?.result?.feedUrl ?? lastDry?.result?.feedUrl ?? null,
		},
		latestId: lastResult?.latest?.id ?? lastSeen ?? null,
		endpointsCount: Array.isArray(endpoints) ? endpoints.length : 0,
		lastPingAt: lastPingMs,
		nextAllowedInMs: lockRemainingMs,
		lastResultAt: lastResult?.time ?? lastDry?.time ?? null,
		successes: ok,
		failures: fail,
		lastRequestAt: lastReq?.time ?? null,
		lastRequestBody: lastReq?.body ?? null,
		summary,
		recentSample: summary.slice(0, 20),
		sampleSource: sampleSource ? { time: sampleSource.time, result: sampleSource.result } : undefined,
	};
}

/**
 * Format a time value
 * @param {number | null} ms The time in milliseconds
 * @returns {string} The formatted time string
 */
function fmtTime(ms: number | null): string {
	if (!ms) return "—";
	const d = new Date(ms);
	return `${d.toISOString()} (${fmtRelative(Date.now() - ms)} ago)`;
}

/**
 * Format a relative time value
 * @param {number} diffMs The time difference in milliseconds
 * @returns {string} The formatted relative time string
 */
function fmtRelative(diffMs: number): string {
	const s = Math.floor(diffMs / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	return `${d}d`;
}

/**
 * Render the health data as HTML
 * @param {RuntimeEnv} env The runtime environment
 * @param {number} refreshSeconds The number of seconds to refresh the page
 * @param {"fail" | "all" | "ok"} view The view mode
 * @returns {Promise<string>} The rendered HTML
 */
async function renderHealthHtml(env: RuntimeEnv, refreshSeconds = 0, view: ViewMode = "all"): Promise<string> {
	const data = await readHealth(env);

	// filter rows by view
	const rows = (data.summary || []).filter((r) => (view === "all" ? true : view === "fail" ? !r.ok : r.ok));

	// quick helpers
	const qp = (v: ViewMode) => `?view=${v}${refreshSeconds ? `&refresh=${refreshSeconds}` : ""}`;
	const badge = (label: string, color: string) => `<span class="badge" style="--c:${color}">${label}</span>`;
	const linkBadge = (label: string, color: string, href: string) => `<a class="badge link" style="--c:${color}" href="${href}">${label}</a>`;

	const okBadge = badge("OK", "#22c55e");
	const failBadge = badge("FAIL", "#ef4444");

	const metaRefresh = refreshSeconds > 0 ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : "";

	const recentRows = rows
		.map(
			(r: PingResult) => `
<tr>
	<td class="mono">${escapeHtml(r.url)}</td>
	<td>${r.ok ? okBadge : failBadge}</td>
	<td class="mono">${r.status}</td>
	<td class="muted">${r.error ? escapeHtml(r.error) : ""}</td>
</tr>
`,
		)
		.join("");

	const tabs = `
<div class="seg">
	<a href="${qp("all")}"  class="${view === "all" ? "active" : ""}">All</a>
	<a href="${qp("fail")}" class="${view === "fail" ? "active" : ""}">Failures</a>
	<a href="${qp("ok")}"   class="${view === "ok" ? "active" : ""}">Successes</a>
</div>
`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${metaRefresh}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>XML-RPC Pinger • Health</title>
<style>
	:root { color-scheme: light dark; --table-h: 520px; }
	body{font:14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin:24px;}
	.wrap{max-width:1000px;margin:auto;}
	h1{font-size:20px;margin:0 0 16px;}
	.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:16px;}
	.card{border:1px solid color-mix(in oklab, CanvasText 12%, transparent); border-radius:12px; padding:14px; background:color-mix(in oklab, Canvas 96%, transparent);}
	.k{color:color-mix(in oklab, CanvasText 40%, transparent)}
	.v{font-weight:600}
	.mono{font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace}
	.muted{color:color-mix(in oklab, CanvasText 55%, transparent)}
	table{width:100%; border-collapse:collapse; font-size:13px}
	th,td{padding:8px 10px; border-top:1px solid color-mix(in oklab, CanvasText 12%, transparent); vertical-align:top}
	th{text-align:left; font-weight:700}
	.badge{display:inline-block; padding:2px 8px; border-radius:999px; background:color-mix(in oklab, var(--c) 20%, transparent); color:var(--c); border:1px solid var(--c); font-size:12px}
	.badge.link{text-decoration:none}
	.row{display:flex; gap:12px; align-items:baseline; flex-wrap:wrap}
	.pill{padding:2px 8px; border-radius:999px; border:1px solid color-mix(in oklab, CanvasText 18%, transparent)}
	.small{font-size:12px}
	a{color:inherit}

	/* Segmented control */
	.seg{display:flex; gap:8px; margin-left:auto}
	.seg a{padding:4px 10px; border-radius:999px; border:1px solid color-mix(in oklab, CanvasText 22%, transparent); text-decoration:none}
	.seg a.active{background:color-mix(in oklab, CanvasText 15%, transparent)}

	/* Scrollable table area */
	.tablecard{border:1px solid color-mix(in oklab, CanvasText 12%, transparent); border-radius:12px; background:color-mix(in oklab, Canvas 96%, transparent);}
	.tablehdr{display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid color-mix(in oklab, CanvasText 12%, transparent);}
	.tablewrap{height:var(--table-h); overflow:auto;}
	thead th{position:sticky; top:0; background:color-mix(in oklab, Canvas 96%, transparent);}
</style>
</head>
<body>
<div class="wrap">
	<h1>XML-RPC Pinger • Health ${refreshSeconds ? `<span class="pill small">auto-refresh ${refreshSeconds}s</span>` : ""}</h1>

	<div class="grid">
		<div class="card">
		<div class="row"><span class="k">Site</span><span class="v">${escapeHtml(String(data.site.name ?? "—"))}</span></div>
		<div class="small mono muted">${escapeHtml(String(data.site.url ?? ""))}</div>
		<div class="small mono muted">${escapeHtml(String(data.site.feed ?? ""))}</div>
		</div>

		<div class="card">
		<div class="k">Endpoints</div>
		<div class="v">${data.endpointsCount}</div>
		</div>

		<div class="card">
		<div class="k">Last ping</div>
		<div class="v">${fmtTime(data.lastPingAt)}</div>
		<div class="small muted">Next allowed in: ${data.nextAllowedInMs ? Math.ceil(data.nextAllowedInMs / 1000) + "s" : "now"}</div>
		</div>

		<div class="card">
		<div class="k">Latest ID</div>
		<div class="mono">${escapeHtml(String(data.latestId ?? "—"))}</div>
		</div>

		<div class="card">
		<div class="k">Last result</div>
		<div>
			${linkBadge(`${data.successes} OK`, "#22c55e", qp("ok"))}
			${linkBadge(`${data.failures} FAIL`, "#ef4444", qp("fail"))}
		</div>
		<div class="small muted">at ${fmtTime(data.lastResultAt)}</div>
		</div>

		<div class="card">
		<div class="k">Last manual request</div>
		<div class="small muted">at ${fmtTime(data.lastRequestAt)}</div>
		</div>
	</div>

	<div class="tablecard">
		<div class="tablehdr">
		<div class="row"><strong>Results</strong><span class="muted small">(showing ${rows.length} of ${data.summary.length})</span></div>
		${tabs}
		</div>
		<div class="tablewrap">
		<table>
			<thead><tr><th>Endpoint</th><th>Status</th><th>HTTP</th><th>Error</th></tr></thead>
			<tbody>${recentRows || `<tr><td colspan="4" class="muted">No data.</td></tr>`}</tbody>
		</table>
		</div>
	</div>

	<div class="small muted" style="margin-top:10px">
		Tip: add <span class="mono">?refresh=60</span> to auto-refresh every 60s, <span class="mono">?view=fail</span> to show failures, or <span class="mono">?format=json</span> for JSON.
	</div>
</div>
</body>
</html>`;
}

/**
 * Escape HTML special characters in a string.
 * @param {string} s The input string
 * @returns {string} The escaped string
 */
function escapeHtml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
