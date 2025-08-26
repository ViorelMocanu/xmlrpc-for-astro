/// <reference types="../worker-configuration.d.ts" />
/// <reference types="node" />
/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, jsdoc/no-undefined-types */

export interface Env {
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
}

type PingPayload = {
	siteName?: string;
	siteUrl?: string;
	feedUrl?: string | null;
	endpoints?: string[];
};

type PingResult = { url: string; ok: boolean; status: number; error?: string };

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

const HOUR = 60 * 60;
const RL_KEY = "xmlrpc:last-ping";
const LAST_KEY = "xmlrpc:last-seen"; // commit sha or deploy id

export default {
	// Manual trigger (optional) — e.g., from CI
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
		const auth = request.headers.get("authorization");
		if (!auth || auth !== `Bearer ${env.XMLRPC_PING_SECRET}`) return new Response("Unauthorized", { status: 401 });

		const body = (await safeJson(request)) as Partial<PingPayload>;
		const res = await doPing(env, body);
		return Response.json(res);
	},

	// Cron trigger — zero coupling with your site repo

	async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
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
			await noop();
		}
	},
};

/**
 * Perform the ping operation
 * @param {Env} env The environment variables
 * @param {PingPayload} payload The ping payload
 * @returns {Promise<object>} The ping result
 */
async function doPing(env: Env, payload: PingPayload): Promise<object> {
	const rl = await env.XMLRPC_PING_KV.get(RL_KEY);
	if (rl) return { status: "skipped", reason: "rate-limited (<=1/hour)" };

	const siteName = payload.siteName ?? env.SITE_NAME ?? "Viorel Mocanu";
	const siteUrl = payload.siteUrl ?? env.SITE_URL ?? "https://www.viorelmocanu.ro";
	const feedUrl = payload.feedUrl ?? env.FEED_URL ?? null;

	// Prefer KV list if present: xmlrpc:endpoints
	let endpoints: string[] = [];
	const kvList = await env.XMLRPC_PING_KV.get("xmlrpc:endpoints", "text");
	if (kvList) endpoints = JSON.parse(kvList);
	if (!endpoints.length) {
		endpoints = Array.isArray(payload.endpoints) ? payload.endpoints : env.PING_ENDPOINTS ? JSON.parse(env.PING_ENDPOINTS) : ["https://rpc.pingomatic.com/"];
	}

	const method = feedUrl ? "weblogUpdates.extendedPing" : "weblogUpdates.ping";
	const params = feedUrl ? [siteName, siteUrl, feedUrl] : [siteName, siteUrl];
	const bodyXml = xmlRpc(method, params);

	// set RL immediately to gate concurrent calls
	await env.XMLRPC_PING_KV.put(RL_KEY, String(Date.now()), { expirationTtl: HOUR });

	const results = await Promise.allSettled(endpoints.map((u) => pingOne(u, bodyXml)));
	const summary: PingResult[] = results.map((r, i) => (r.status === "fulfilled" ? r.value : { url: endpoints[i], ok: false, status: 0, error: String((r as PromiseRejectedResult).reason) }));

	return { status: "done", method, siteName, siteUrl, feedUrl, summary };
}

/**
 * Perform the ping operation
 * @param {string} url The endpoint URL
 * @param {string} body The XML-RPC request body
 * @returns {Promise<PingResult>} The ping result
 */
async function pingOne(url: string, body: string): Promise<PingResult> {
	const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/xml" }, body });
	return { url, ok: res.ok, status: res.status };
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
 *
 */
async function noop() {
	/* no-op */
}

// --- Detectors ---

// Default (no changes to site repo): latest successful commit on a branch
/**
 * Get the latest commit SHA from a GitHub repository branch
 * @param {Env} env The environment variables
 * @returns {Promise<{ id: string } | null>} The latest commit SHA or null
 */
async function latestGithubCommit(env: Env): Promise<{ id: string } | null> {
	const repo = env.GITHUB_REPO;
	if (!repo) return null;
	const branch = env.GITHUB_BRANCH || "main";
	const r = await fetch(`https://api.github.com/repos/${repo}/branches/${branch}`, {
		headers: env.GITHUB_TOKEN ? { "Authorization": `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "xmlrpc-pinger" } : { "User-Agent": "xmlrpc-pinger" },
	});
	if (!r.ok) return null;
	const j: any = (await r.json()) as GitHubBranchInfo;
	const sha = j?.commit?.sha;
	return sha ? { id: sha } : null;
}

// Optional (tighter to actual Pages deploys): latest deploy id
/**
 * Get the latest deploy ID from a Cloudflare Pages project
 * @param {Env} env The environment variables
 * @returns {Promise<{ id: string } | null>} The latest deploy ID or null
 */
async function latestCloudflareDeploy(env: Env): Promise<{ id: string } | null> {
	const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_PAGES_PROJECT } = env;
	if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_PAGES_PROJECT) return null;

	// Note: The CF Pages deployments API returns recent deployments.
	// We only need the newest one's ID as a stable dedup key.
	const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CLOUDFLARE_PAGES_PROJECT}/deployments?per_page=1`;
	const r = await fetch(url, { headers: { Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}` } });
	if (!r.ok) return null;
	const j: any = (await r.json()) as CfDeployments;

	// Be tolerant to shape differences
	const list = Array.isArray(j.result) ? j.result : (j.result?.deployments ?? []);
	const first: CfDeploy | undefined = Array.isArray(list) ? list[0] : undefined;
	const id = first?.id ?? first?.deployment_id ?? first?.short_id;
	return id ? { id } : null;
}
